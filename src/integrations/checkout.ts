/**
 * Checkout + order tracking for Care's shopping workflow.
 *
 * Honest status: there is no live commerce/payment credential in this project,
 * so the demo ENDS AT A SANDBOX CHECKOUT. The sandbox provider never touches a
 * card number; it receives only a saved-payment token reference (e.g. a Visa
 * test card ending 4242) and returns a clearly-labeled sandbox order reference.
 * A real provider (a Visa-enabled merchant/PSP checkout) would implement the
 * same `CheckoutProvider` interface; the approval binding and spending limit
 * below are enforced in Care's code before any provider is called.
 *
 * Tracking: the sandbox provider supports tracking with a deterministic,
 * demo-paced timeline derived from the placement time, so a live demo visibly
 * advances placed -> packed -> out for delivery -> delivered.
 */

import { id } from "@/lib/id";
import type { OrderStage, TrackingStep } from "@/agents/care/shopping/types";

export interface PlaceOrderInput {
  userId: string;
  cartHash: string;
  total: number;
  itemCount: number;
  paymentTokenRef: string;
  /** Idempotency key: the same approved cart can never be charged twice. */
  idempotencyKey: string;
}

export interface PlacedOrder {
  orderRef: string;
  placedAt: number;
  backend: "sandbox";
  trackingSupported: boolean;
  /** Shown to the person verbatim. */
  notice: string;
}

export interface CheckoutProvider {
  readonly backend: "sandbox";
  readonly label: string;
  placeOrder(input: PlaceOrderInput): Promise<PlacedOrder>;
  track(order: { orderRef: string; placedAt: number }, nowMs?: number): TrackingStep[];
}

const STAGES: { stage: OrderStage; label: string; afterSteps: number }[] = [
  { stage: "placed", label: "Order placed", afterSteps: 0 },
  { stage: "packed", label: "Packed at the store", afterSteps: 1 },
  { stage: "out_for_delivery", label: "Out for delivery", afterSteps: 2 },
  { stage: "delivered", label: "Delivered", afterSteps: 4 },
];

/** Demo pacing: one tracking step per this many ms (default 45s). */
function stepMs(): number {
  const v = Number(process.env.SHOP_TRACKING_STEP_MS);
  return Number.isFinite(v) && v > 0 ? v : 45_000;
}

const placedByKey = new Map<string, PlacedOrder>();

export class SandboxCheckout implements CheckoutProvider {
  readonly backend = "sandbox" as const;
  readonly label = "Sandbox checkout (no real payment)";

  async placeOrder(input: PlaceOrderInput): Promise<PlacedOrder> {
    const existing = placedByKey.get(input.idempotencyKey);
    if (existing) return existing;
    const order: PlacedOrder = {
      orderRef: id("sbx_order").toUpperCase(),
      placedAt: Date.now(),
      backend: "sandbox",
      trackingSupported: true,
      notice: "Sandbox checkout: this is a demo order. No real payment was taken and nothing will be delivered.",
    };
    placedByKey.set(input.idempotencyKey, order);
    return order;
  }

  track(order: { orderRef: string; placedAt: number }, nowMs: number = Date.now()): TrackingStep[] {
    const elapsed = Math.max(0, nowMs - order.placedAt);
    const step = stepMs();
    return STAGES.map((s) => {
      const at = order.placedAt + s.afterSteps * step;
      return { stage: s.stage, label: s.label, done: elapsed >= s.afterSteps * step, at };
    });
  }
}

export function getCheckoutProvider(): CheckoutProvider {
  return new SandboxCheckout();
}

export function currentStage(steps: TrackingStep[]): TrackingStep {
  return [...steps].reverse().find((s) => s.done) ?? steps[0];
}
