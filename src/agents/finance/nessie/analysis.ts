/**
 * Pure, deterministic spending analysis over authorized bank transactions.
 * Every number Finance reports (totals, duplicates, subscriptions, deltas) is
 * computed here in code. Claude only adds categories and plain-language notes
 * on top (see classify.ts), and those are validated before use.
 */

export const CATEGORIES = [
  "groceries",
  "dining",
  "pharmacy",
  "healthcare",
  "utilities",
  "phone_internet",
  "entertainment",
  "news_media",
  "fitness",
  "transportation",
  "shopping",
  "insurance",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  groceries: "Groceries",
  dining: "Dining out",
  pharmacy: "Pharmacy",
  healthcare: "Healthcare",
  utilities: "Utilities",
  phone_internet: "Phone & internet",
  entertainment: "Entertainment & streaming",
  news_media: "News & media",
  fitness: "Fitness",
  transportation: "Transportation",
  shopping: "Shopping",
  insurance: "Insurance",
  other: "Other",
};

/** A bank purchase normalized from Nessie, minus anything Finance doesn't need. */
export interface BankTransaction {
  id: string;
  date: string; // YYYY-MM-DD
  amount: number;
  merchant: string;
  /** Merchant category reported by the bank (Nessie), if any. */
  bankCategory?: string;
  description?: string;
  status: "pending" | "completed" | "cancelled";
}

export interface CategorizedTransaction extends BankTransaction {
  category: Category;
  categorySource: "claude" | "rules";
}

export interface DuplicateCandidate {
  key: string;
  merchant: string;
  amount: number;
  transactionIds: [string, string];
  dates: [string, string];
  daysApart: number;
  note?: string;
}

export interface Subscription {
  key: string;
  merchant: string;
  monthlyAmount: number;
  previousAmount: number;
  charges: number;
  firstDate: string;
  lastDate: string;
  nextExpected: string;
  transactionIds: string[];
  priceIncrease: boolean;
  note?: string;
}

export interface CategoryLine {
  category: Category;
  label: string;
  total: number;
  previousTotal: number;
  change: number;
  count: number;
}

export interface MonthlySummary {
  month: string; // YYYY-MM
  previousMonth: string;
  total: number;
  previousTotal: number;
  change: number;
  transactionCount: number;
  byCategory: CategoryLine[];
  topMerchants: { merchant: string; total: number; count: number }[];
  largest: { merchant: string; amount: number; date: string } | null;
  recurringMonthlyTotal: number;
}

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
export const daysBetween = (a: string, b: string) => Math.round(Math.abs(toTime(b) - toTime(a)) / DAY);
const addDays = (date: string, days: number) => new Date(toTime(date) + days * DAY).toISOString().slice(0, 10);
const normalizeMerchant = (m: string) => m.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const counted = (t: BankTransaction) => t.status !== "cancelled";

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function previousMonthOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/* ------------------------------------------------------- categorization -- */

const BANK_CATEGORY_MAP: [RegExp, Category][] = [
  [/grocer|supermarket|food market/, "groceries"],
  [/restaurant|diner|cafe|coffee|food/, "dining"],
  [/pharmac|drug/, "pharmacy"],
  [/health|medical|doctor|clinic|dental|hospital/, "healthcare"],
  [/utilit|electric|gas|water|energy/, "utilities"],
  [/telecom|internet|phone|wireless|cable/, "phone_internet"],
  [/stream|entertain|music|movie|video/, "entertainment"],
  [/news|magazine|media|publish/, "news_media"],
  [/fitness|gym/, "fitness"],
  [/transport|taxi|ride|transit|fuel|gas station/, "transportation"],
  [/insur/, "insurance"],
  [/retail|shop|store|department/, "shopping"],
];

const NAME_HINTS: [RegExp, Category][] = [
  [/safeway|trader joe|whole foods|kroger|grocery|market/, "groceries"],
  [/cvs|walgreens|rite aid|pharmacy/, "pharmacy"],
  [/pg ?& ?e|pge|electric|water|utility/, "utilities"],
  [/comcast|xfinity|at ?& ?t|verizon|t mobile|internet|wireless/, "phone_internet"],
  [/netflix|hulu|spotify|stream|tv\b|disney|cloud|photos/, "entertainment"],
  [/gazette|times|news|journal|post\b/, "news_media"],
  [/gym|fitness|yoga/, "fitness"],
  [/diner|cafe|pizza|grill|restaurant|kitchen/, "dining"],
  [/uber|lyft|taxi|shuttle|transit/, "transportation"],
  [/insurance|medicare|supplement/, "insurance"],
];

/** Deterministic fallback categorizer (and the baseline Claude must beat). */
export function ruleCategory(t: Pick<BankTransaction, "merchant" | "bankCategory" | "description">): Category {
  const bank = (t.bankCategory ?? "").toLowerCase();
  for (const [re, cat] of BANK_CATEGORY_MAP) if (bank && re.test(bank)) return cat;
  const name = normalizeMerchant(`${t.merchant} ${t.description ?? ""}`);
  for (const [re, cat] of NAME_HINTS) if (re.test(name)) return cat;
  return "other";
}

export function categorizeWithRules(txns: BankTransaction[]): CategorizedTransaction[] {
  return txns.map((t) => ({ ...t, category: ruleCategory(t), categorySource: "rules" as const }));
}

/* ----------------------------------------------------------- duplicates -- */

/**
 * Possible duplicate charges: same merchant, same amount (to the cent), within
 * `windowDays` of each other. Monthly subscriptions are ~30 days apart, so they
 * never trip this. Each transaction is paired at most once.
 */
export function findDuplicateCharges(txns: BankTransaction[], windowDays = 3): DuplicateCandidate[] {
  const sorted = txns.filter(counted).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const used = new Set<string>();
  const out: DuplicateCandidate[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (used.has(a.id)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const gap = daysBetween(a.date, b.date);
      if (gap > windowDays) break;
      if (used.has(b.id)) continue;
      if (normalizeMerchant(a.merchant) !== normalizeMerchant(b.merchant)) continue;
      if (Math.abs(a.amount - b.amount) >= 0.005) continue;
      used.add(a.id);
      used.add(b.id);
      out.push({
        key: `dup:${a.id}:${b.id}`,
        merchant: a.merchant,
        amount: a.amount,
        transactionIds: [a.id, b.id],
        dates: [a.date, b.date],
        daysApart: gap,
      });
      break;
    }
  }
  return out;
}

/* -------------------------------------------------------- subscriptions -- */

/**
 * Recurring monthly charges: 2+ charges from one merchant, every gap 25-35 days,
 * and a stable price (all earlier charges within 2% of each other). The latest
 * charge may be up to 50% higher, which is reported as a price increase.
 */
export function findSubscriptions(txns: BankTransaction[], duplicateIds: Set<string> = new Set()): Subscription[] {
  const groups = new Map<string, BankTransaction[]>();
  for (const t of txns) {
    if (!counted(t)) continue;
    const k = normalizeMerchant(t.merchant);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const out: Subscription[] = [];
  for (const [k, list] of groups) {
    const charges = dedupeSameDay(list.sort((a, b) => a.date.localeCompare(b.date)), duplicateIds);
    if (charges.length < 2) continue;
    const gaps = charges.slice(1).map((c, i) => daysBetween(charges[i].date, c.date));
    if (!gaps.every((g) => g >= 25 && g <= 35)) continue;
    const earlier = charges.slice(0, -1).map((c) => c.amount);
    const base = earlier[0];
    if (!earlier.every((a) => Math.abs(a - base) <= base * 0.02)) continue;
    const last = charges[charges.length - 1];
    if (last.amount < base * 0.98 || last.amount > base * 1.5) continue;
    const previousAmount = charges[charges.length - 2].amount;
    out.push({
      key: `sub:${k}`,
      merchant: last.merchant,
      monthlyAmount: last.amount,
      previousAmount,
      charges: charges.length,
      firstDate: charges[0].date,
      lastDate: last.date,
      nextExpected: addDays(last.date, Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)),
      transactionIds: charges.map((c) => c.id),
      priceIncrease: last.amount > previousAmount * 1.01,
    });
  }
  return out.sort((a, b) => b.monthlyAmount - a.monthlyAmount);
}

/** Drop the later copy of a same-day duplicate so it doesn't look like a cadence break. */
function dedupeSameDay(sorted: BankTransaction[], duplicateIds: Set<string>): BankTransaction[] {
  const out: BankTransaction[] = [];
  for (const t of sorted) {
    const prev = out[out.length - 1];
    if (prev && duplicateIds.has(t.id) && daysBetween(prev.date, t.date) <= 3 && Math.abs(prev.amount - t.amount) < 0.005) continue;
    out.push(t);
  }
  return out;
}

/* -------------------------------------------------------------- summary -- */

export function monthlySummary(txns: CategorizedTransaction[], month: string, subscriptions: Subscription[]): MonthlySummary {
  const prev = previousMonthOf(month);
  const live = txns.filter(counted);
  const cur = live.filter((t) => monthOf(t.date) === month);
  const old = live.filter((t) => monthOf(t.date) === prev);
  const sum = (list: { amount: number }[]) => round2(list.reduce((s, t) => s + t.amount, 0));

  const byCategory: CategoryLine[] = CATEGORIES.map((category) => {
    const c = cur.filter((t) => t.category === category);
    const p = old.filter((t) => t.category === category);
    const total = sum(c);
    const previousTotal = sum(p);
    return { category, label: CATEGORY_LABELS[category], total, previousTotal, change: round2(total - previousTotal), count: c.length };
  })
    .filter((l) => l.total > 0 || l.previousTotal > 0)
    .sort((a, b) => b.total - a.total || b.previousTotal - a.previousTotal);

  const merchants = new Map<string, { merchant: string; total: number; count: number }>();
  for (const t of cur) {
    const m = merchants.get(t.merchant) ?? { merchant: t.merchant, total: 0, count: 0 };
    m.total = round2(m.total + t.amount);
    m.count += 1;
    merchants.set(t.merchant, m);
  }
  const largestTxn = [...cur].sort((a, b) => b.amount - a.amount)[0];
  const total = sum(cur);
  const previousTotal = sum(old);
  return {
    month,
    previousMonth: prev,
    total,
    previousTotal,
    change: round2(total - previousTotal),
    transactionCount: cur.length,
    byCategory,
    topMerchants: [...merchants.values()].sort((a, b) => b.total - a.total).slice(0, 5),
    largest: largestTxn ? { merchant: largestTxn.merchant, amount: largestTxn.amount, date: largestTxn.date } : null,
    recurringMonthlyTotal: round2(subscriptions.reduce((s, x) => s + x.monthlyAmount, 0)),
  };
}

/** Transactions that were not present in the previous analysis run. */
export function newSince(txns: BankTransaction[], previouslySeen: string[] | undefined): BankTransaction[] {
  if (!previouslySeen) return [];
  const seen = new Set(previouslySeen);
  return txns.filter((t) => !seen.has(t.id));
}

/* ----------------------------------------------------- suggested actions -- */

export type SuggestedActionKind = "dispute_duplicate" | "review_subscription" | "check_price_increase";

export interface SuggestedActionDraft {
  key: string;
  kind: SuggestedActionKind;
  title: string;
  detail: string;
  amount: number;
  merchant: string;
  transactionIds: string[];
}

export function suggestActions(duplicates: DuplicateCandidate[], subscriptions: Subscription[]): SuggestedActionDraft[] {
  const out: SuggestedActionDraft[] = [];
  for (const d of duplicates) {
    out.push({
      key: d.key,
      kind: "dispute_duplicate",
      title: `Possible double charge: ${d.merchant} $${d.amount.toFixed(2)}`,
      detail: `Charged twice ${d.daysApart === 0 ? "on the same day" : `${d.daysApart} day(s) apart`} (${d.dates[0]} and ${d.dates[1]}). If you only bought once, Finance can draft a dispute for $${d.amount.toFixed(2)}.`,
      amount: d.amount,
      merchant: d.merchant,
      transactionIds: [...d.transactionIds],
    });
  }
  for (const s of subscriptions) {
    if (s.priceIncrease) {
      const diff = round2(s.monthlyAmount - s.previousAmount);
      out.push({
        key: `price:${s.key}:${s.lastDate}`,
        kind: "check_price_increase",
        title: `${s.merchant} went up $${diff.toFixed(2)}`,
        detail: `Was $${s.previousAmount.toFixed(2)}/month, now $${s.monthlyAmount.toFixed(2)}/month (${s.lastDate}). Worth checking whether the new price was expected.`,
        amount: diff,
        merchant: s.merchant,
        transactionIds: s.transactionIds.slice(-2),
      });
    }
    out.push({
      key: `${s.key}`,
      kind: "review_subscription",
      title: `Still using ${s.merchant}? $${s.monthlyAmount.toFixed(2)}/month`,
      detail: `Charged ${s.charges} months in a row (since ${s.firstDate}); next charge expected around ${s.nextExpected}. That is $${round2(s.monthlyAmount * 12).toFixed(2)} a year.`,
      amount: s.monthlyAmount,
      merchant: s.merchant,
      transactionIds: s.transactionIds,
    });
  }
  return out;
}
