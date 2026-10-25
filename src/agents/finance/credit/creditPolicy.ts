import type { ConsentSettings } from "../../base/policy";
import { isSandboxTestSsn, type CrsTestIdentity } from "./testIdentities";

/**
 * Deterministic authorization for a CRS credit / identity review.
 *
 * Pure function: no model output can change the decision. The per-request
 * approval itself is enforced earlier by the tool's `requiresApproval` gate; this
 * policy adds the standing rules that must ALSO hold before any CRS request:
 *
 *   1. The person has the `financeCreditReview` consent switched on.
 *   2. The review is for the persona linked to this account (Finance acts only for
 *      the account holder, never for an arbitrary identity).
 *   3. That persona is on the CRS test-identity allowlist with a 666-range SSN.
 *   4. The purpose is one of the recorded permissible purposes.
 *   5. No more than MAX_REVIEWS_PER_DAY reviews in 24 hours (limits repeated pulls).
 */

export const CREDIT_REVIEW_PURPOSES = ["identity_protection_review", "credit_health_review"] as const;
export type CreditReviewPurpose = (typeof CREDIT_REVIEW_PURPOSES)[number];

export const MAX_REVIEWS_PER_DAY = 5;

export type CreditAuthDecision =
  | { allowed: true; personaId: string }
  | { allowed: false; code: CreditDenialCode; reason: string };

export type CreditDenialCode =
  | "consent_off"
  | "not_linked_persona"
  | "not_test_identity"
  | "bad_purpose"
  | "rate_limited";

export function authorizeCreditReview(input: {
  consent: ConsentSettings;
  requestedPersonaId: string;
  linkedPersonaId: string;
  identity: CrsTestIdentity | undefined;
  purpose: string;
  reviewsInLast24h: number;
}): CreditAuthDecision {
  if (!input.consent.financeCreditReview) {
    return { allowed: false, code: "consent_off", reason: "Credit and identity reviews are switched off in consent settings." };
  }
  if (input.requestedPersonaId !== input.linkedPersonaId) {
    return {
      allowed: false,
      code: "not_linked_persona",
      reason: `Finance can only review the identity linked to this account (${input.linkedPersonaId}), not ${input.requestedPersonaId}.`,
    };
  }
  if (!input.identity || !isSandboxTestSsn(input.identity.ssn)) {
    return { allowed: false, code: "not_test_identity", reason: "Only CRS-supported test identities may be sent to CRS." };
  }
  if (!(CREDIT_REVIEW_PURPOSES as readonly string[]).includes(input.purpose)) {
    return { allowed: false, code: "bad_purpose", reason: `"${input.purpose}" is not a recorded purpose for a credit review.` };
  }
  if (input.reviewsInLast24h >= MAX_REVIEWS_PER_DAY) {
    return { allowed: false, code: "rate_limited", reason: `At most ${MAX_REVIEWS_PER_DAY} credit reviews per 24 hours.` };
  }
  return { allowed: true, personaId: input.requestedPersonaId };
}
