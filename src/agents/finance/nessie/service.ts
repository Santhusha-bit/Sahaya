import type { NessieClient, NessiePurchase } from "@/integrations/nessie";
import type { MemoryRecord, ScopedMemory } from "../../base/types";
import type { TaskService } from "../../base/services";
import {
  findDuplicateCharges,
  findSubscriptions,
  monthOf,
  monthlySummary,
  newSince,
  suggestActions,
  type BankTransaction,
  type CategorizedTransaction,
  type DuplicateCandidate,
  type MonthlySummary,
  type Subscription,
  type SuggestedActionKind,
} from "./analysis";
import { defaultReviewer, type TransactionReviewer } from "./classify";
import { provisionSandboxBank } from "./fixture";

/**
 * Finance's Capital One Nessie workflow:
 *   connect (person approves read access) -> fetch authorized purchases ->
 *   Claude categorizes + code detects duplicates/subscriptions -> monthly
 *   summary -> suggested actions the person accepts or dismisses.
 * Everything is saved in Finance's own memory namespace, which is Convex when
 * NEXT_PUBLIC_CONVEX_URL is set (in-process store otherwise).
 *
 * Code-enforced rules:
 *  - Purchases are read only from the account recorded in an "authorized"
 *    bankConnections record. The account id never comes from model input.
 *  - Only the last 4 digits of the account number are stored.
 *  - Suggested actions never execute on their own. Accepting a dispute only
 *    drafts it; submitting still needs requestFinancialApproval.
 *  - Finance has no tool that creates bank purchases. simulateNewPurchase is
 *    demo tooling for the sandbox bank, called by the demo script / UI only.
 */

export const CONNECTIONS = "bankConnections";
export const ANALYSES = "spendingAnalyses";
export const SUGGESTIONS = "suggestedActions";

export interface BankDeps {
  memory: ScopedMemory;
  nessie: NessieClient;
  reviewer?: TransactionReviewer;
  tasks?: TaskService;
  /** YYYY-MM-DD; defaults to the real current date. */
  today?: string;
}

export interface BankConnection {
  provider: "capital-one-nessie";
  backend: "live" | "sandbox";
  status: "authorized" | "revoked";
  customerId: string;
  accountId: string;
  nickname: string;
  last4: string;
  scope: "read:purchases";
  authorizedAt: number;
  revokedAt?: number;
  purchasesSeeded: number;
}

export class BankNotAuthorizedError extends Error {
  constructor(message = "No bank account is connected. Connect one first; that needs your approval.") {
    super(message);
    this.name = "BankNotAuthorizedError";
  }
}

const todayISO = () => new Date().toISOString().slice(0, 10);

export async function getConnection(memory: ScopedMemory): Promise<{ id: string; data: BankConnection } | null> {
  const rows = await memory.list(CONNECTIONS);
  const rec = rows.find((r) => r.data.status === "authorized") ?? rows[0];
  return rec ? { id: rec.id, data: rec.data as unknown as BankConnection } : null;
}

/**
 * Called only after the person approved access (connectSandboxBankAccount
 * requires approval). Reuses an existing account when there is one, otherwise
 * sets up the sandbox customer + account and populates it with test purchases.
 */
export async function connectBank(deps: BankDeps): Promise<{ connection: BankConnection; created: boolean }> {
  const existing = await getConnection(deps.memory);
  if (existing && existing.data.backend === deps.nessie.backend && (await deps.nessie.getAccount(existing.data.accountId))) {
    const connection: BankConnection = { ...existing.data, status: "authorized", authorizedAt: Date.now(), revokedAt: undefined };
    await deps.memory.update(existing.id, connection as unknown as Record<string, unknown>);
    return { connection, created: false };
  }
  const bank = await provisionSandboxBank(deps.nessie, deps.today ?? todayISO());
  const connection: BankConnection = {
    provider: "capital-one-nessie",
    backend: deps.nessie.backend,
    status: "authorized",
    customerId: bank.customerId,
    accountId: bank.accountId,
    nickname: bank.nickname,
    last4: bank.last4,
    scope: "read:purchases",
    authorizedAt: Date.now(),
    purchasesSeeded: bank.purchasesCreated,
  };
  // Older connections (e.g. a reset sandbox) are revoked so only one is live.
  for (const r of await deps.memory.list(CONNECTIONS)) {
    if (r.data.status === "authorized") await deps.memory.update(r.id, { status: "revoked", revokedAt: Date.now() });
  }
  await deps.memory.save(CONNECTIONS, connection as unknown as Record<string, unknown>, { tags: ["bank", "nessie"] });
  return { connection, created: true };
}

export async function revokeBank(memory: ScopedMemory): Promise<boolean> {
  const conn = await getConnection(memory);
  if (!conn || conn.data.status !== "authorized") return false;
  await memory.update(conn.id, { status: "revoked", revokedAt: Date.now() });
  return true;
}

async function requireAuthorized(memory: ScopedMemory): Promise<BankConnection> {
  const conn = await getConnection(memory);
  if (!conn || conn.data.status !== "authorized") throw new BankNotAuthorizedError();
  return conn.data;
}

/** Read purchases from the authorized account only, normalized for analysis. */
export async function fetchAuthorizedTransactions(
  deps: BankDeps,
  opts: { days?: number } = {},
): Promise<{ connection: BankConnection; transactions: BankTransaction[] }> {
  const connection = await requireAuthorized(deps.memory);
  if (connection.backend !== deps.nessie.backend) {
    throw new BankNotAuthorizedError(`The connected account is on the ${connection.backend} bank, but ${deps.nessie.backend} is active. Reconnect it.`);
  }
  if (!(await deps.nessie.getAccount(connection.accountId))) {
    throw new BankNotAuthorizedError("The connected sandbox account no longer exists (the sandbox bank was reset). Reconnect it.");
  }
  const purchases = await deps.nessie.listPurchases(connection.accountId);
  const merchants = new Map<string, { name: string; category?: string }>();
  for (const id of new Set(purchases.map((p) => p.merchant_id))) {
    const m = await deps.nessie.getMerchant(id);
    merchants.set(id, { name: m?.name ?? "Unknown merchant", category: Array.isArray(m?.category) ? m?.category[0] : m?.category });
  }
  let transactions = purchases.map((p) => toTransaction(p, merchants.get(p.merchant_id)));
  if (opts.days) {
    const cutoff = new Date(Date.parse(`${deps.today ?? todayISO()}T00:00:00Z`) - opts.days * 86_400_000).toISOString().slice(0, 10);
    transactions = transactions.filter((t) => t.date >= cutoff);
  }
  transactions.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return { connection, transactions };
}

function toTransaction(p: NessiePurchase, m: { name: string; category?: string } | undefined): BankTransaction {
  return {
    id: p._id,
    date: p.purchase_date.slice(0, 10),
    amount: Number(p.amount),
    merchant: m?.name ?? "Unknown merchant",
    bankCategory: m?.category,
    description: p.description,
    status: p.status === "cancelled" ? "cancelled" : p.status === "pending" ? "pending" : "completed",
  };
}

/* ------------------------------------------------------------- analysis -- */

export interface NewTransactionFinding {
  id: string;
  date: string;
  merchant: string;
  amount: number;
  category: string;
  flags: string[];
}

export interface SpendingAnalysis {
  analysisNumber: number;
  analyzedAt: number;
  month: string;
  bank: { backend: "live" | "sandbox"; nickname: string; last4: string };
  reviewer: "claude" | "rules";
  reviewerNote?: string;
  transactionCount: number;
  summary: MonthlySummary;
  subscriptions: Subscription[];
  duplicates: DuplicateCandidate[];
  firstRun: boolean;
  newTransactions: NewTransactionFinding[];
  seenTransactionIds: string[];
  transactions: Pick<CategorizedTransaction, "id" | "date" | "merchant" | "amount" | "category" | "categorySource">[];
  spoken: string;
}

export async function latestAnalysis(memory: ScopedMemory): Promise<SpendingAnalysis | null> {
  const rows = await memory.list(ANALYSES);
  const best = rows.sort((a, b) => Number(b.data.analysisNumber) - Number(a.data.analysisNumber))[0];
  return best ? (best.data as unknown as SpendingAnalysis) : null;
}

export async function runSpendingAnalysis(deps: BankDeps, opts: { month?: string } = {}): Promise<{ analysis: SpendingAnalysis; analysisId: string }> {
  const { connection, transactions } = await fetchAuthorizedTransactions(deps);
  const month = opts.month ?? monthOf(deps.today ?? todayISO());

  const duplicates = findDuplicateCharges(transactions);
  const duplicateIds = new Set(duplicates.flatMap((d) => d.transactionIds));
  const subscriptions = findSubscriptions(transactions, duplicateIds);
  const review = await (deps.reviewer ?? defaultReviewer())({ transactions, duplicates, subscriptions });
  for (const d of duplicates) d.note = review.duplicateNotes[d.key];
  for (const s of subscriptions) s.note = review.subscriptionNotes[s.key];
  const summary = monthlySummary(review.transactions, month, subscriptions);

  const previous = await latestAnalysis(deps.memory);
  const comparable = previous && previous.bank.last4 === connection.last4 && previous.bank.backend === connection.backend ? previous : null;
  const byId = new Map(review.transactions.map((t) => [t.id, t]));
  const subIds = new Set(subscriptions.flatMap((s) => s.transactionIds));
  const newTransactions: NewTransactionFinding[] = newSince(transactions, comparable?.seenTransactionIds).map((t) => {
    const flags: string[] = [];
    if (duplicateIds.has(t.id)) flags.push("possible duplicate");
    if (subIds.has(t.id)) flags.push("subscription charge");
    const sub = subscriptions.find((s) => s.priceIncrease && s.transactionIds[s.transactionIds.length - 1] === t.id);
    if (sub) flags.push("price increase");
    return { id: t.id, date: t.date, merchant: t.merchant, amount: t.amount, category: byId.get(t.id)!.category, flags };
  });

  const analysis: SpendingAnalysis = {
    analysisNumber: (previous?.analysisNumber ?? 0) + 1,
    analyzedAt: Date.now(),
    month,
    bank: { backend: connection.backend, nickname: connection.nickname, last4: connection.last4 },
    reviewer: review.reviewer,
    reviewerNote: review.reviewerNote,
    transactionCount: transactions.length,
    summary,
    subscriptions,
    duplicates,
    firstRun: !comparable,
    newTransactions,
    seenTransactionIds: transactions.map((t) => t.id),
    transactions: review.transactions.map(({ id, date, merchant, amount, category, categorySource }) => ({ id, date, merchant, amount, category, categorySource })),
    spoken: "",
  };
  analysis.spoken = speakAnalysis(analysis);

  const rec = await deps.memory.save(ANALYSES, analysis as unknown as Record<string, unknown>, { tags: ["analysis", month] });
  await syncSuggestions(deps.memory, rec.id, duplicates, subscriptions);
  return { analysis, analysisId: rec.id };
}

function money(n: number) {
  return `$${n.toFixed(2)}`;
}

export function speakAnalysis(a: SpendingAnalysis): string {
  const s = a.summary;
  const parts: string[] = [];
  if (!a.firstRun && a.newTransactions.length) {
    const flagged = a.newTransactions.filter((t) => t.flags.includes("possible duplicate"));
    parts.push(
      `Since I last looked, ${a.newTransactions.length} new charge${a.newTransactions.length === 1 ? "" : "s"} came in` +
        (flagged.length ? `, and ${flagged[0].merchant} for ${money(flagged[0].amount)} looks like it may have been charged twice.` : "."),
    );
  } else if (!a.firstRun) {
    parts.push("No new charges since I last looked.");
  }
  parts.push(`So far this month you've spent ${money(s.total)} across ${s.transactionCount} purchases. Last month's total was ${money(s.previousTotal)}.`);
  const top = s.byCategory[0];
  if (top) parts.push(`Your biggest category is ${top.label.toLowerCase()} at ${money(top.total)}.`);
  if (a.subscriptions.length) {
    parts.push(`You have ${a.subscriptions.length} regular monthly charges adding up to ${money(s.recurringMonthlyTotal)} a month.`);
  }
  const inc = a.subscriptions.find((x) => x.priceIncrease);
  if (inc) parts.push(`${inc.merchant} went up from ${money(inc.previousAmount)} to ${money(inc.monthlyAmount)}.`);
  if (a.duplicates.length && (a.firstRun || !a.newTransactions.some((t) => t.flags.includes("possible duplicate")))) {
    parts.push(`I also found ${a.duplicates.length} possible double charge${a.duplicates.length === 1 ? "" : "s"}.`);
  }
  parts.push("I've listed some suggestions for you to look over. Nothing happens unless you say so.");
  return parts.join(" ");
}

/* ---------------------------------------------------- suggested actions -- */

export interface SuggestedAction {
  key: string;
  kind: SuggestedActionKind;
  title: string;
  detail: string;
  note?: string;
  amount: number;
  merchant: string;
  transactionIds: string[];
  status: "suggested" | "accepted" | "dismissed";
  firstSeenAnalysisId: string;
  lastSeenAnalysisId: string;
  decidedAt?: number;
  outcome?: string;
}

/** Upsert by stable key so a re-run never re-asks about something already decided. */
async function syncSuggestions(memory: ScopedMemory, analysisId: string, duplicates: DuplicateCandidate[], subscriptions: Subscription[]) {
  const existing = new Map((await memory.list(SUGGESTIONS)).map((r) => [String(r.data.key), r]));
  const notes = new Map<string, string | undefined>([
    ...duplicates.map((d) => [d.key, d.note] as const),
    ...subscriptions.map((s) => [s.key, s.note] as const),
  ]);
  for (const draft of suggestActions(duplicates, subscriptions)) {
    const prior = existing.get(draft.key);
    const note = notes.get(draft.key);
    if (prior) {
      const patch: Record<string, unknown> = { lastSeenAnalysisId: analysisId };
      if (prior.data.status === "suggested") Object.assign(patch, { title: draft.title, detail: draft.detail, amount: draft.amount, transactionIds: draft.transactionIds, note });
      await memory.update(prior.id, patch);
    } else {
      const action: SuggestedAction = { ...draft, note, status: "suggested", firstSeenAnalysisId: analysisId, lastSeenAnalysisId: analysisId };
      await memory.save(SUGGESTIONS, action as unknown as Record<string, unknown>, { tags: ["suggestion", draft.kind] });
    }
  }
}

export async function currentSuggestions(memory: ScopedMemory): Promise<(SuggestedAction & { id: string })[]> {
  const rows = await memory.list(ANALYSES);
  const latest = rows.sort((a, b) => Number(b.data.analysisNumber) - Number(a.data.analysisNumber))[0];
  if (!latest) return [];
  const order: Record<SuggestedActionKind, number> = { dispute_duplicate: 0, check_price_increase: 1, review_subscription: 2 };
  return (await memory.list(SUGGESTIONS))
    .filter((r) => r.data.lastSeenAnalysisId === latest.id)
    .map((r: MemoryRecord) => ({ id: r.id, ...(r.data as unknown as SuggestedAction) }))
    .sort((a, b) => order[a.kind] - order[b.kind] || b.amount - a.amount);
}

/**
 * The person's decision on one suggestion. Accepting never moves money:
 * duplicates become a drafted dispute, subscriptions / price changes become a
 * to-do for the person (or their helper). Dismissing is remembered.
 */
export async function decideSuggestion(
  deps: Pick<BankDeps, "memory" | "tasks">,
  actionId: string,
  decision: "accept" | "dismiss",
): Promise<{ action: SuggestedAction; outcome: string; disputeId?: string }> {
  const rec = await deps.memory.get(actionId);
  if (!rec || rec.collection !== SUGGESTIONS) throw new Error("Suggestion not found.");
  const action = rec.data as unknown as SuggestedAction;
  if (action.status !== "suggested") {
    return { action, outcome: `Already ${action.status}${action.outcome ? `: ${action.outcome}` : "."}` };
  }

  let outcome: string;
  let disputeId: string | undefined;
  if (decision === "dismiss") {
    outcome =
      action.kind === "review_subscription"
        ? `Okay, keeping ${action.merchant}. I won't suggest it again.`
        : `Okay, I'll leave the ${action.merchant} charge alone.`;
  } else if (action.kind === "dispute_duplicate") {
    const dispute = await deps.memory.save(
      "disputes",
      {
        reason: `Possible duplicate charge from ${action.merchant}`,
        amount: action.amount,
        merchant: action.merchant,
        transactionIds: action.transactionIds,
        status: "drafted",
        source: "nessie-analysis",
      },
      { tags: ["dispute"] },
    );
    disputeId = dispute.id;
    outcome = `I drafted a dispute for the extra ${action.merchant} charge of $${action.amount.toFixed(2)}. It is not sent: submitting it needs your separate approval.`;
  } else {
    const title =
      action.kind === "review_subscription"
        ? `Cancel ${action.merchant} ($${action.amount.toFixed(2)}/month)`
        : `Ask ${action.merchant} about the price increase`;
    await deps.tasks?.create({
      title,
      description: "You chose this from Finance's spending review. Finance does not cancel or call anyone on its own.",
      steps: ["You decided", "Contact the company", "Confirm it's done"],
      status: "in_progress",
    });
    outcome = `Added "${title}" to your to-do list. Finance won't cancel or contact anyone on its own.`;
  }

  const patch = { status: decision === "accept" ? "accepted" : "dismissed", decidedAt: Date.now(), outcome, disputeId };
  await deps.memory.update(actionId, patch);
  return { action: { ...action, ...patch } as SuggestedAction, outcome, disputeId };
}

/* ------------------------------------------------- demo: sandbox bank only -- */

export type SimulatedPurchase =
  | { scenario: "double_charge" }
  | { scenario: "custom"; merchant: string; amount: number; category?: string };

/**
 * Demo tooling, NOT a Finance tool: plays the role of the bank posting a new
 * card purchase to the connected sandbox account, so the next analysis has
 * something new to detect. "double_charge" re-posts the most recent purchase
 * (same merchant, amount and date), the classic duplicate.
 */
export async function simulateNewPurchase(
  deps: Pick<BankDeps, "memory" | "nessie" | "today">,
  input: SimulatedPurchase,
): Promise<{ purchase: NessiePurchase; merchant: string }> {
  const connection = await requireAuthorized(deps.memory);
  if (input.scenario === "double_charge") {
    const purchases = (await deps.nessie.listPurchases(connection.accountId)).filter((p) => p.status !== "cancelled");
    const latest = purchases.sort((a, b) => b.purchase_date.localeCompare(a.purchase_date))[0];
    if (!latest) throw new Error("The sandbox account has no purchases to duplicate.");
    const merchant = await deps.nessie.getMerchant(latest.merchant_id);
    const purchase = await deps.nessie.createPurchase(connection.accountId, {
      merchant_id: latest.merchant_id,
      medium: "balance",
      purchase_date: latest.purchase_date.slice(0, 10),
      amount: latest.amount,
      status: "completed",
      description: latest.description,
    });
    return { purchase, merchant: merchant?.name ?? "Unknown merchant" };
  }
  const name = input.merchant.trim().slice(0, 60) || "New merchant";
  const m = await deps.nessie.createMerchant({
    name,
    category: input.category?.trim() || "Retail",
    address: { street_number: "1", street_name: "Main St", city: "Berkeley", state: "CA", zip: "94704" },
    geocode: { lat: 37.87, lng: -122.27 },
  });
  const purchase = await deps.nessie.createPurchase(connection.accountId, {
    merchant_id: m._id,
    medium: "balance",
    purchase_date: deps.today ?? todayISO(),
    amount: Math.round(input.amount * 100) / 100,
    status: "completed",
    description: name,
  });
  return { purchase, merchant: name };
}
