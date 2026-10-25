/**
 * x402 payment policy: a PURE, deterministic decision engine.
 *
 * Given a payment requirement returned by a paid service, the user's standing
 * spending mandate, and what has already been spent today, decide one of:
 *   - "pay":            within the previously authorized limit, pay now
 *   - "needs_approval": legitimate but outside the mandate, ask the person
 *   - "refuse":         never payable, even with approval
 *
 * No model output feeds this function; Claude can ask Care to buy data but only
 * this code decides whether money moves. Hard rules (test network only, USDC
 * only, registered product-data service only, payee pinned, absolute cap) apply
 * even when the person has approved, so an approval can't be stretched into a
 * mainnet payment or a grocery checkout.
 */

import { createHash } from "node:crypto";
import { getAddress } from "viem";
import { atomicToUsd, usdToAtomic, X402_NETWORKS, type PaymentRequirements } from "@/integrations/x402";
import { PERMITTED_CATEGORIES, type PaidDataService } from "./registry";

/** Absolute ceiling for a single x402 payment, approval or not. */
export const HARD_CAP_USD = 1.0;

/** A previously authorized, standing spending limit for paid agent services. */
export interface SpendingMandate {
  id: string;
  perPaymentLimitUsd: number;
  dailyLimitUsd: number;
  allowedServiceIds: string[];
  network: string;
  grantedBy: string;
  grantedAt: number;
  expiresAt?: number;
  revoked?: boolean;
}

export type PolicyAction = "pay" | "needs_approval" | "refuse";

export interface PolicyDecision {
  action: PolicyAction;
  /** How the payment is authorized when action is "pay". */
  authorizedBy?: "mandate" | "approval";
  amountUsd: number;
  reasons: string[];
  requirementHash: string;
}

export interface PolicyInput {
  requirement: PaymentRequirements;
  /** The registered service the requirement's resource belongs to, if any. */
  service: PaidDataService | undefined;
  mandate: SpendingMandate | null;
  spentTodayAtomic: bigint;
  /** Requirement hash the person explicitly approved, if this is an approved retry. */
  approvedHash?: string;
  now: number;
}

/**
 * Stable fingerprint of everything that determines what money moves where. An
 * approval is bound to this hash, so a re-quoted price, payee, network, asset or
 * resource after approval is a different payment and is not covered.
 */
export function requirementHash(r: PaymentRequirements): string {
  const canonical = JSON.stringify([
    r.scheme,
    r.network,
    r.maxAmountRequired,
    r.resource,
    r.payTo.toLowerCase(),
    r.asset.toLowerCase(),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

export function evaluateX402Payment(input: PolicyInput): PolicyDecision {
  const { requirement: r, service, mandate } = input;
  const hash = requirementHash(r);
  const amount = /^\d+$/.test(r.maxAmountRequired) ? BigInt(r.maxAmountRequired) : -1n;
  const amountUsd = amount >= 0n ? atomicToUsd(amount) : 0;
  const refuse = (...reasons: string[]): PolicyDecision => ({ action: "refuse", amountUsd, reasons, requirementHash: hash });

  // ---- Hard rules: refused even with approval ----
  if (!service) return refuse("resource is not a registered paid data service");
  if (!PERMITTED_CATEGORIES.includes(service.category)) {
    return refuse(`service category "${service.category}" may not be paid via x402 (x402 is not a checkout)`);
  }
  if (r.scheme !== "exact") return refuse(`unsupported payment scheme "${r.scheme}"`);
  const net = X402_NETWORKS[r.network];
  if (!net) return refuse(`unknown network "${r.network}"`);
  if (!net.testnet) return refuse(`network "${r.network}" is not a test network; only test payments are allowed`);
  if (r.network !== service.network) return refuse(`network "${r.network}" does not match the service's registered network`);
  if (!sameAddress(r.asset, net.usdc)) return refuse("asset is not USDC on this network");
  if (!sameAddress(r.payTo, service.payTo)) return refuse("payee does not match the service's registered address");
  if (amount <= 0n) return refuse("amount must be a positive whole number of token units");
  if (amount > usdToAtomic(HARD_CAP_USD)) return refuse(`amount exceeds the $${HARD_CAP_USD.toFixed(2)} hard cap`);
  if (amount > usdToAtomic(service.maxPriceUsd)) return refuse(`amount exceeds this service's $${service.maxPriceUsd.toFixed(2)} price ceiling`);

  // ---- Explicit approval for exactly this requirement ----
  if (input.approvedHash) {
    if (input.approvedHash === hash) {
      return { action: "pay", authorizedBy: "approval", amountUsd, reasons: ["approved by the person for this exact amount"], requirementHash: hash };
    }
    return refuse("payment terms changed since they were approved");
  }

  // ---- Standing mandate (previously authorized limit) ----
  const ask = (...reasons: string[]): PolicyDecision => ({ action: "needs_approval", amountUsd, reasons, requirementHash: hash });
  if (!mandate || mandate.revoked) return ask("no standing authorization for paid services");
  if (mandate.expiresAt && mandate.expiresAt <= input.now) return ask("the standing authorization has expired");
  if (!mandate.allowedServiceIds.includes(service.id)) return ask("this service isn't covered by the standing authorization");
  if (mandate.network !== r.network) return ask("the standing authorization doesn't cover this network");
  if (amount > usdToAtomic(mandate.perPaymentLimitUsd)) {
    return ask(`$${amountUsd.toFixed(2)} is above the $${mandate.perPaymentLimitUsd.toFixed(2)} per-payment limit`);
  }
  if (input.spentTodayAtomic + amount > usdToAtomic(mandate.dailyLimitUsd)) {
    return ask(`this would exceed the $${mandate.dailyLimitUsd.toFixed(2)} daily limit`);
  }
  return {
    action: "pay",
    authorizedBy: "mandate",
    amountUsd,
    reasons: [`within the standing $${mandate.perPaymentLimitUsd.toFixed(2)} per-payment / $${mandate.dailyLimitUsd.toFixed(2)} daily limit`],
    requirementHash: hash,
  };
}
