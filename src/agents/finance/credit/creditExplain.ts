import { llmAvailable, llmTurn, AGENT_MODEL } from "@/lib/llm";
import type { CreditFinding, CreditInterpretation } from "./creditInterpret";

/**
 * Plain-language explanation of a credit / identity review.
 *
 * Claude writes the explanation from the computed findings only (no SSN, no raw
 * report). The draft is then checked in code and REJECTED if it:
 *   - cites a finding id that does not exist, or skips a high-severity finding;
 *   - states a number that does not appear in the evidence;
 *   - claims things CRS does not provide or the data cannot show (bank transaction
 *     monitoring, confirmed fraud/identity theft, guarantees, ongoing monitoring);
 *   - contains anything shaped like an SSN.
 * On rejection (or without an API key) a deterministic template is used. The
 * sandbox / not-proof caveat is always appended in code, never left to the model.
 * Next steps come from a fixed rule table, never from the model.
 */

export interface NextStep {
  id: string;
  text: string;
  /** A Sahaya tool that can help; any such action still needs the person's approval. */
  tool?: "prepareDispute" | "requestAssistanceCoordination";
}

export interface CreditExplanation {
  text: string;
  source: "claude" | "template";
  model?: string;
  rejectedReasons: string[];
  caveat: string;
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/bank\s+(account\s+)?(transaction|activity|statement)s?/i, "mentions bank transaction monitoring (CRS does not provide it)"],
  [/\b(confirm(s|ed)?|proves?|definitely)\b[^.]{0,40}\b(fraud|identity theft|stolen)/i, "claims fraud is confirmed"],
  [/you (are|have been) (a victim|defrauded|scammed)/i, "claims the person is a victim"],
  [/\bguarantee/i, "makes a guarantee"],
  [/\b(we|sahaya|finance) (is|are|will be|am) (continuously |now )?monitoring\b/i, "claims ongoing monitoring"],
  [/\b\d{3}-?\d{2}-?\d{4}\b/, "contains an SSN-like number"],
];

export function caveatFor(mode: "live" | "sandbox"): string {
  return mode === "live"
    ? "Note: this used the CRS sandbox with a CRS test identity, not a real credit file. These are warning signs, not proof of fraud, and nothing was changed on any account."
    : "Note: this used an offline copy of CRS sandbox test data (no live CRS call), not a real credit file. These are warning signs, not proof of fraud, and nothing was changed on any account.";
}

/** Minimized facts handed to Claude. Evidence values only; no identity fields. */
export function factsForModel(interp: CreditInterpretation) {
  return {
    asOf: interp.asOf,
    overall: interp.overall,
    findings: interp.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      evidence: f.evidence.map((e) => `${e.source} ${e.field} = ${e.value}`),
    })),
  };
}

function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));
}

export function validateExplanation(draft: string, interp: CreditInterpretation): string[] {
  const problems: string[] = [];
  const ids = new Set(interp.findings.map((f) => f.id));
  const cited = new Set([...draft.matchAll(/\[([a-z0-9-]+)\]/g)].map((m) => m[1]));
  for (const c of cited) if (!ids.has(c)) problems.push(`cites unknown finding [${c}]`);
  for (const f of interp.findings) {
    if (f.severity === "high" && !cited.has(f.id)) problems.push(`does not cite high-severity finding [${f.id}]`);
  }
  const allowed = new Set(numbersIn(JSON.stringify(factsForModel(interp))));
  for (const n of numbersIn(draft.replace(/\[[a-z0-9-]+\]/g, ""))) {
    if (Number(n) > 12 && !allowed.has(n)) problems.push(`states number ${n} not found in the evidence`);
  }
  for (const [re, why] of FORBIDDEN) if (re.test(draft)) problems.push(why);
  if (draft.length > 2000) problems.push("too long");
  if (!draft.trim()) problems.push("empty");
  return problems;
}

export function templateExplanation(interp: CreditInterpretation): string {
  const lead =
    interp.overall === "attention"
      ? "I found some things on this credit file that need your attention."
      : interp.overall === "watch"
        ? "Your credit file mostly looks fine, but a few things are worth watching."
        : "Your credit file looks clear. I didn't find anything worrying.";
  const lines = interp.findings
    .filter((f) => f.severity !== "info" || f.id === "credit-score" || f.category === "change")
    .slice(0, 6)
    .map((f) => `${f.title} [${f.id}]. ${f.detail}`);
  return [lead, ...lines].join("\n");
}

const SYSTEM = `You are Finance inside Sahaya, explaining a credit and identity review to an older adult.
Write 4 to 7 short, calm sentences in plain language (no jargon, no markdown, no lists).
Rules:
- Use ONLY the findings provided. After each claim, cite the finding id in square brackets, e.g. [inquiry-burst]. Cite every high-severity finding.
- Only use numbers that appear in the findings.
- Never say fraud or identity theft is confirmed; these are warning signs to check.
- Never mention bank accounts or bank transactions; this review covers credit and identity data only.
- Do not give next steps; they are added separately.`;

export async function explainCreditReview(
  interp: CreditInterpretation,
  mode: "live" | "sandbox",
  opts: { useModel?: boolean; draft?: (system: string, user: string) => Promise<string> } = {},
): Promise<CreditExplanation> {
  const caveat = caveatFor(mode);
  const rejectedReasons: string[] = [];
  const draftFn =
    opts.draft ??
    (llmAvailable() && opts.useModel !== false
      ? async (system: string, user: string) =>
          (await llmTurn({ system, messages: [{ role: "user", content: user }], tools: [] })).text
      : undefined);

  if (draftFn) {
    try {
      const draft = (await draftFn(SYSTEM, JSON.stringify(factsForModel(interp)))).trim();
      const problems = validateExplanation(draft, interp);
      if (!problems.length) {
        return { text: `${draft}\n\n${caveat}`, source: "claude", model: opts.draft ? "injected" : AGENT_MODEL, rejectedReasons, caveat };
      }
      rejectedReasons.push(...problems);
    } catch (err) {
      rejectedReasons.push(`model call failed: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  return { text: `${templateExplanation(interp)}\n\n${caveat}`, source: "template", rejectedReasons, caveat };
}

/** Deterministic next steps keyed by finding id. */
export function nextStepsFor(findings: CreditFinding[]): NextStep[] {
  const has = (id: string) => findings.some((f) => f.id === id);
  const steps: NextStep[] = [];
  if (has("inquiry-burst") || has("possible-identity-misuse")) {
    steps.push({
      id: "confirm-inquiries",
      text: "Check whether you applied for credit recently. If you don't recognize these inquiries, I can draft a dispute to TransUnion for you to review and approve before anything is sent.",
      tool: "prepareDispute",
    });
    steps.push({
      id: "consider-freeze",
      text: "Consider a free security freeze with Equifax, Experian and TransUnion so no one can open new credit in your name. I won't place it for you; a family member or helper can do it with you.",
      tool: "requestAssistanceCoordination",
    });
  }
  if (has("identity-mismatch")) {
    steps.push({ id: "verify-personal-details", text: "Ask TransUnion to confirm the name, date of birth and address they have on file. Mismatches can be simple errors or a sign someone else's details were mixed in." });
  }
  if (has("contact-fraud-signals")) {
    steps.push({ id: "beware-verification-calls", text: "Be careful with calls or texts asking you to 'verify' a new account or share codes. Guardian can help check whether a caller is real." });
  }
  if (has("past-due")) {
    steps.push({ id: "confirm-past-due", text: "Call the listed creditor using the number on your own statement to confirm the past-due amount before paying anything." });
  }
  if (has("high-utilization")) {
    steps.push({ id: "lower-utilization", text: "Paying card balances down below about 30% of their limits usually helps your score." });
  }
  if (has("authorized-user-accounts")) {
    steps.push({ id: "ask-about-authorized-users", text: "Ask family whether anyone added you as an authorized user on their card. If no one did, those accounts should be disputed." });
  }
  if (has("possible-identity-misuse")) {
    steps.push({ id: "ftc-plan", text: "If you did not make these applications, IdentityTheft.gov (from the FTC) gives a free step-by-step recovery plan." });
  }
  if (!steps.length) {
    steps.push({ id: "no-action", text: "No action needed right now. I can repeat this review later, with your approval each time." });
  }
  return steps;
}
