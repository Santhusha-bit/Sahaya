/**
 * Outbound channel for Finance dispute / clarification requests.
 *
 * Hospitals do not expose a public billing-dispute API (and Hyphenate does not
 * provide one), so this is ALWAYS a sandbox: a simulated billing office that
 * receives the approved letter, acknowledges it with a reference number,
 * reviews it, and responds with a corrected balance. Nothing leaves the app.
 * In production the same seam would hand the approved letter to the person's
 * email / patient portal / fax, and responses would be recorded by a human.
 *
 * Timing: each stage takes FINANCE_CASE_STEP_MS (default 20s) so a live demo
 * shows the case moving. FINANCE_BILLING_SCENARIO=partial makes the office fix
 * only part of the problem, to exercise resolution verification.
 */

import { createHash } from "node:crypto";
import type { ProviderUpdate } from "@/agents/finance/investigation/types";

export interface DisputeSubmission {
  caseId: string;
  recipientEmail: string;
  subject: string;
  body: string;
  idempotencyKey: string;
  /** What a correct fix would leave owing; the simulator uses it to respond. */
  expectedBalance: number;
  originalBalance: number;
}

export interface DisputeChannel {
  readonly backend: "sandbox";
  submit(s: DisputeSubmission): { submissionRef: string; submittedAt: number };
  track(input: { submissionRef: string; submittedAt: number; expectedBalance: number; originalBalance: number }, nowMs?: number): ProviderUpdate[];
}

export class SandboxBillingOffice implements DisputeChannel {
  readonly backend = "sandbox" as const;
  private readonly sent = new Map<string, { submissionRef: string; submittedAt: number }>();

  constructor(private readonly opts: { stepMs?: number; scenario?: "full" | "partial" } = {}) {}

  private get stepMs(): number {
    return this.opts.stepMs ?? Math.max(50, Number(process.env.FINANCE_CASE_STEP_MS ?? 20_000));
  }
  private get scenario(): "full" | "partial" {
    return this.opts.scenario ?? (process.env.FINANCE_BILLING_SCENARIO === "partial" ? "partial" : "full");
  }

  submit(s: DisputeSubmission) {
    // Idempotent: the same approved draft can never be sent twice.
    const prior = this.sent.get(s.idempotencyKey);
    if (prior) return prior;
    const ref = `SBX-${createHash("sha256").update(s.idempotencyKey).digest("hex").slice(0, 8).toUpperCase()}`;
    const out = { submissionRef: ref, submittedAt: Date.now() };
    this.sent.set(s.idempotencyKey, out);
    return out;
  }

  track(input: { submissionRef: string; submittedAt: number; expectedBalance: number; originalBalance: number }, nowMs = Date.now()): ProviderUpdate[] {
    const step = this.stepMs;
    const elapsed = nowMs - input.submittedAt;
    const providerRef = `BAY-${input.submissionRef.slice(4, 10)}`;
    const updates: ProviderUpdate[] = [{ stage: "submitted", label: "Request sent to the billing office", at: input.submittedAt }];
    if (elapsed >= step) updates.push({ stage: "acknowledged", label: "Billing office confirmed they received it", at: input.submittedAt + step, providerRef, message: `Your request was received. Reference ${providerRef}.` });
    if (elapsed >= 2 * step) updates.push({ stage: "under_review", label: "Billing office is reviewing the charges", at: input.submittedAt + 2 * step, providerRef, message: "A billing specialist is reviewing the claim against the insurer's EOB." });
    if (elapsed >= 3 * step) {
      const partial = this.scenario === "partial";
      const corrected = partial ? Math.round(((input.originalBalance + input.expectedBalance) / 2) * 100) / 100 : input.expectedBalance;
      updates.push({
        stage: "resolved",
        label: "Billing office sent a response",
        at: input.submittedAt + 3 * step,
        providerRef,
        correctedBalance: corrected,
        message: partial
          ? `We applied a partial adjustment. Your new balance is $${corrected.toFixed(2)}.`
          : `We corrected the billing error and issued a corrected statement. Your new balance is $${corrected.toFixed(2)}.`,
      });
    }
    return updates;
  }
}

const GLOBAL_KEY = "__kinline_billing_office__";

/** Process-wide channel so idempotency holds across requests. */
export function getDisputeChannel(): DisputeChannel {
  const g = globalThis as Record<string, unknown>;
  return (g[GLOBAL_KEY] ??= new SandboxBillingOffice()) as DisputeChannel;
}
