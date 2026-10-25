import { DEFAULT_CONSENT, type ConsentSettings } from "../../base/policy";
import type { ToolContext, ToolResult } from "../../base/types";
import { CrsError, createCrsClient, maskSsn, type CrsCallResult, type CrsClient, type CrsProduct } from "@/integrations/crs";
import { authorizeCreditReview, type CreditReviewPurpose } from "./creditPolicy";
import { findTestIdentity, linkedPersonaId } from "./testIdentities";
import { interpretCreditData, type CreditSnapshot } from "./creditInterpret";
import { explainCreditReview, nextStepsFor } from "./creditExplain";

/**
 * Finance's end-to-end credit / identity review over the CRS Credit API.
 *
 *   1. Authorize (deterministic policy; the tool's approval gate already ran).
 *   2. Request CRS sandbox data for the linked CRS test identity.
 *   3. Interpret the returned fields into evidence-backed findings (+ change since
 *      the previous review).
 *   4. Claude explains the findings in plain language (validated in code).
 *   5. Deterministic next steps.
 *   6. Every step is written to the audit log; the review is saved in Finance's
 *      own memory namespace (SSN never stored, only masked).
 */

export const REVIEW_COLLECTION = "creditReviews";
const ACTOR = "finance";

export interface CreditReviewInput {
  purpose: CreditReviewPurpose;
  products: CrsProduct[];
  personaId?: string;
}

export interface CreditReviewDeps {
  client?: CrsClient;
  /** Injected Claude drafter (tests / demos). */
  draft?: (system: string, user: string) => Promise<string>;
}

async function readConsent(ctx: ToolContext): Promise<ConsentSettings> {
  const rows = await ctx.memory.readShared("consent", { limit: 1 });
  return { ...DEFAULT_CONSENT, ...((rows[0]?.data as ConsentSettings | undefined) ?? {}) };
}

export async function runCreditReview(ctx: ToolContext, input: CreditReviewInput, deps: CreditReviewDeps = {}): Promise<ToolResult> {
  const linked = linkedPersonaId();
  const requested = input.personaId ?? linked;
  const identity = findTestIdentity(requested);
  const audit = (action: string, detail: Record<string, unknown>) =>
    ctx.audit.record({ actor: ACTOR, action, correlationId: ctx.correlationId, detail });

  await audit("credit.review.requested", { purpose: input.purpose, products: input.products, personaId: requested });

  // ---- 1. Authorization ----
  const priorReviews = await ctx.memory.list(REVIEW_COLLECTION, { limit: 200 });
  const dayAgo = Date.now() - 86_400_000;
  const decision = authorizeCreditReview({
    consent: await readConsent(ctx),
    requestedPersonaId: requested,
    linkedPersonaId: linked,
    identity,
    purpose: input.purpose,
    reviewsInLast24h: priorReviews.filter((r) => r.createdAt >= dayAgo && r.data.status === "completed").length,
  });
  await audit("credit.review.authorization", decision.allowed ? { allowed: true, personaId: requested } : { allowed: false, code: decision.code, reason: decision.reason });
  if (!decision.allowed || !identity) {
    const reason = decision.allowed ? "Unknown test identity." : decision.reason;
    return { ok: false, summary: `I can't run that credit review: ${reason}`, error: decision.allowed ? "not_test_identity" : decision.code };
  }

  // ---- 2. CRS requests ----
  let client: CrsClient;
  try {
    client = deps.client ?? createCrsClient();
  } catch (err) {
    await audit("crs.request.failed", { error: (err as Error).message, code: err instanceof CrsError ? err.code : "unknown" });
    return { ok: false, summary: "I couldn't connect to the credit data service.", error: (err as Error).message };
  }
  const calls: Partial<Record<CrsProduct, CrsCallResult>> = {};
  const failures: Array<{ product: CrsProduct; error: string; code?: string }> = [];
  for (const product of input.products) {
    try {
      const r = await client.call(product, identity);
      calls[product] = r;
      await audit("crs.request", {
        product,
        mode: r.mode,
        method: r.method,
        endpoint: r.endpoint,
        status: r.status,
        requestId: r.requestId,
        latencyMs: r.latencyMs,
        personaId: identity.personaId,
        ssn: maskSsn(identity.ssn),
        responseSha256: r.responseSha256,
        errorMessages: r.errorMessages,
      });
    } catch (err) {
      const code = err instanceof CrsError ? err.code : undefined;
      failures.push({ product, error: (err as Error).message, code });
      await audit("crs.request.failed", { product, mode: client.mode, error: (err as Error).message, code });
    }
  }
  const succeeded = Object.keys(calls) as CrsProduct[];
  if (!succeeded.length) {
    return {
      ok: false,
      summary: `I couldn't get any data from CRS: ${failures.map((f) => f.error).join("; ")}`,
      error: failures[0]?.code ?? "crs_failed",
      data: { failures },
    };
  }

  // ---- 3. Interpretation (+ change detection) ----
  const previous = priorReviews
    .filter((r) => r.data.status === "completed" && r.data.personaId === identity.personaId)
    .sort((a, b) => b.createdAt - a.createdAt)[0]?.data.snapshot as CreditSnapshot | undefined;
  const interp = interpretCreditData({
    creditReport: calls.credit_report?.response,
    identityVerification: calls.identity_verification?.response,
    fraudFinder: calls.fraud_finder?.response,
    previous,
  });
  await audit("credit.review.interpreted", {
    overall: interp.overall,
    findings: interp.findings.map((f) => ({ id: f.id, severity: f.severity })),
    comparedTo: previous?.asOf ?? null,
  });

  // ---- 4. Explanation (Claude, validated) ----
  const explanation = await explainCreditReview(interp, client.mode, { draft: deps.draft });
  await audit("credit.review.explained", {
    source: explanation.source,
    model: explanation.model,
    rejectedReasons: explanation.rejectedReasons,
  });

  // ---- 5. Next steps (deterministic) ----
  const nextSteps = nextStepsFor(interp.findings);

  // ---- 6. Record ----
  const requests = succeeded.map((p) => {
    const c = calls[p]!;
    return { product: p, mode: c.mode, method: c.method, endpoint: c.endpoint, requestBody: c.requestBody, status: c.status, requestId: c.requestId, latencyMs: c.latencyMs, responseSha256: c.responseSha256 };
  });
  const rec = await ctx.memory.save(
    REVIEW_COLLECTION,
    {
      status: "completed",
      personaId: identity.personaId,
      ssn: maskSsn(identity.ssn),
      purpose: input.purpose,
      mode: client.mode,
      requests,
      failures,
      overall: interp.overall,
      findings: interp.findings,
      facts: interp.facts,
      snapshot: interp.snapshot,
      explanation: explanation.text,
      explanationSource: explanation.source,
      nextSteps,
    },
    { tags: ["credit-review", interp.overall] },
  );
  await audit("credit.review.completed", { reviewId: rec.id, overall: interp.overall, nextSteps: nextSteps.map((s) => s.id) });
  await ctx.tasks.create({
    title: `Credit & identity review (${identity.label})`,
    description: interp.findings[0]?.title,
    steps: ["Authorized", "CRS data requested", "Findings interpreted", "Explained", "Recorded for audit"],
    status: "completed",
    result: interp.overall === "attention" ? "Needs your attention" : interp.overall === "watch" ? "Worth watching" : "Looks clear",
    correlationId: ctx.correlationId,
  });

  const stepsText = nextSteps.map((s, i) => `${i + 1}. ${s.text}`).join("\n");
  return {
    ok: true,
    summary: `${explanation.text}\n\nWhat I'd suggest:\n${stepsText}`,
    data: {
      reviewId: rec.id,
      mode: client.mode,
      overall: interp.overall,
      findings: interp.findings,
      facts: interp.facts,
      requests,
      failures,
      explanationSource: explanation.source,
      rejectedReasons: explanation.rejectedReasons,
      nextSteps,
    },
  };
}
