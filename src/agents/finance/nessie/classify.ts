import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AGENT_MODEL, getClient, llmAvailable } from "@/lib/llm";
import {
  CATEGORIES,
  categorizeWithRules,
  type BankTransaction,
  type CategorizedTransaction,
  type Category,
  type DuplicateCandidate,
  type Subscription,
} from "./analysis";

/**
 * Claude reviews the authorized transactions: it assigns each one a spending
 * category and writes a short plain-language note on each duplicate /
 * subscription candidate that the code found. It never changes amounts, never
 * invents candidates, and never decides anything. Its output is validated
 * against the transaction refs and candidate keys we sent; anything invalid or
 * missing falls back to the deterministic rules.
 *
 * Data minimization: Claude sees merchant, date, amount and the bank's merchant
 * category under opaque refs (t1, t2, ...). No account, customer or bank ids.
 */

export interface ReviewResult {
  transactions: CategorizedTransaction[];
  duplicateNotes: Record<string, string>;
  subscriptionNotes: Record<string, string>;
  reviewer: "claude" | "rules";
  /** Why Claude was not used (or partially rejected), for honest labeling. */
  reviewerNote?: string;
}

export type TransactionReviewer = (input: {
  transactions: BankTransaction[];
  duplicates: DuplicateCandidate[];
  subscriptions: Subscription[];
}) => Promise<ReviewResult>;

const REPORT_TOOL = "report_transaction_review";

const reportSchema = z.object({
  categories: z.array(z.object({ ref: z.string(), category: z.string() })),
  duplicateNotes: z.array(z.object({ key: z.string(), note: z.string().max(400) })).default([]),
  subscriptionNotes: z.array(z.object({ key: z.string(), note: z.string().max(400) })).default([]),
});

const SYSTEM = `You review an older adult's authorized bank transactions for Finance, a money-clarity assistant.
Assign every transaction exactly one category from the allowed list. Then, for each possible duplicate charge and each recurring subscription listed, write one short, calm, plain-language note (under 30 words) that helps the person decide. Do not recommend specific actions beyond "check" or "consider"; the person decides.
Do not change amounts or invent transactions. Report everything by calling the ${REPORT_TOOL} tool exactly once.`;

export function rulesReviewer(reason?: string): TransactionReviewer {
  return async ({ transactions }) => ({
    transactions: categorizeWithRules(transactions),
    duplicateNotes: {},
    subscriptionNotes: {},
    reviewer: "rules",
    reviewerNote: reason,
  });
}

export function claudeReviewer(client: Anthropic = getClient()): TransactionReviewer {
  return async ({ transactions, duplicates, subscriptions }) => {
    const refOf = new Map<string, string>();
    transactions.forEach((t, i) => refOf.set(t.id, `t${i + 1}`));
    const idOf = new Map([...refOf].map(([id, ref]) => [ref, id]));
    const payload = {
      allowedCategories: CATEGORIES,
      transactions: transactions.map((t) => ({
        ref: refOf.get(t.id),
        date: t.date,
        merchant: t.merchant,
        amount: t.amount,
        bankCategory: t.bankCategory ?? null,
        description: t.description ?? null,
      })),
      possibleDuplicates: duplicates.map((d) => ({ key: d.key, merchant: d.merchant, amount: d.amount, dates: d.dates })),
      subscriptions: subscriptions.map((s) => ({
        key: s.key,
        merchant: s.merchant,
        monthlyAmount: s.monthlyAmount,
        previousAmount: s.previousAmount,
        months: s.charges,
      })),
    };

    let response: Anthropic.Message;
    try {
      response = await client.messages.create(
        {
          model: AGENT_MODEL,
          max_tokens: 8000,
          system: SYSTEM,
          tools: [
            {
              name: REPORT_TOOL,
              description: "Report the category for every transaction plus a note per duplicate and subscription candidate.",
              input_schema: {
                type: "object",
                properties: {
                  categories: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { ref: { type: "string" }, category: { type: "string", enum: [...CATEGORIES] } },
                      required: ["ref", "category"],
                    },
                  },
                  duplicateNotes: {
                    type: "array",
                    items: { type: "object", properties: { key: { type: "string" }, note: { type: "string" } }, required: ["key", "note"] },
                  },
                  subscriptionNotes: {
                    type: "array",
                    items: { type: "object", properties: { key: { type: "string" }, note: { type: "string" } }, required: ["key", "note"] },
                  },
                },
                required: ["categories", "duplicateNotes", "subscriptionNotes"],
              },
            },
          ],
          // "auto" (not a forced tool) so this works on every current model;
          // the system prompt asks for exactly one report call.
          tool_choice: { type: "auto" },
          messages: [{ role: "user", content: JSON.stringify(payload) }],
        },
        { timeout: 90_000 },
      );
    } catch (err) {
      const why = err instanceof Anthropic.APIError ? `Claude API error ${err.status ?? ""}`.trim() : "Claude unreachable";
      return rulesReviewer(`${why}; categorized with rules.`)({ transactions, duplicates, subscriptions });
    }

    const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === REPORT_TOOL);
    const parsed = call ? reportSchema.safeParse(call.input) : null;
    if (!parsed?.success) {
      return rulesReviewer(`Claude returned no valid review (stop: ${response.stop_reason}); categorized with rules.`)({
        transactions,
        duplicates,
        subscriptions,
      });
    }

    const claudeCat = new Map<string, Category>();
    let rejected = 0;
    for (const c of parsed.data.categories) {
      const txnId = idOf.get(c.ref);
      if (txnId && (CATEGORIES as readonly string[]).includes(c.category)) claudeCat.set(txnId, c.category as Category);
      else rejected++;
    }
    const fallback = new Map(categorizeWithRules(transactions).map((t) => [t.id, t.category]));
    const categorized: CategorizedTransaction[] = transactions.map((t) => {
      const cat = claudeCat.get(t.id);
      return cat ? { ...t, category: cat, categorySource: "claude" } : { ...t, category: fallback.get(t.id)!, categorySource: "rules" };
    });

    const dupKeys = new Set(duplicates.map((d) => d.key));
    const subKeys = new Set(subscriptions.map((s) => s.key));
    const keep = (notes: { key: string; note: string }[], allowed: Set<string>) =>
      Object.fromEntries(notes.filter((n) => allowed.has(n.key)).map((n) => [n.key, n.note.trim()]));

    const missing = transactions.length - claudeCat.size;
    return {
      transactions: categorized,
      duplicateNotes: keep(parsed.data.duplicateNotes, dupKeys),
      subscriptionNotes: keep(parsed.data.subscriptionNotes, subKeys),
      reviewer: "claude",
      reviewerNote:
        missing || rejected ? `${missing} transaction(s) fell back to rules (${rejected} invalid Claude label(s) rejected).` : undefined,
    };
  };
}

/** Claude when ANTHROPIC_API_KEY is set, otherwise the deterministic rules. */
export function defaultReviewer(): TransactionReviewer {
  return llmAvailable() ? claudeReviewer() : rulesReviewer("Sandbox: no ANTHROPIC_API_KEY, categorized with deterministic rules.");
}
