/**
 * Shared types for Care's accessible shopping workflow (Visa "Reimagining
 * shopping" track): voice request -> history/preferences -> product search ->
 * substitutions -> accessible cart -> approval -> checkout -> tracking.
 */

/** One product offer as returned by a product-search provider (Apify or sandbox). */
export interface ProductCandidate {
  productId: string;
  name: string;
  brand?: string;
  size?: string;
  price: number;
  category: string;
  /** Lower-case attribute tags, e.g. "low-sodium", "organic", "spicy". */
  tags: string[];
  inStock: boolean;
  /** Where the offer came from, so the UI can label it honestly. */
  source: "apify" | "sandbox";
  url?: string;
  image?: string;
}

/** One item on the person's usual order, learned from shopping history. */
export interface UsualItem {
  /** Stable key, e.g. "milk". */
  key: string;
  /** Plain-language label shown to the person, e.g. "2% milk". */
  label: string;
  /** Search query sent to the product-search provider. */
  query: string;
  category: string;
  quantity: number;
  preferredBrand?: string;
  /** What the person usually pays per unit; anchors the substitution price cap. */
  usualPrice: number;
  /** When false, never substitute: skip the item instead. */
  allowSubstitution: boolean;
  /** Tags a product MUST carry for this item, e.g. ["low-sodium"] for soup. */
  requiredTags?: string[];
  /** How many past orders included this item (from history). */
  timesOrdered: number;
}

export interface ShoppingProfile {
  userId: string;
  displayName: string;
  usualItems: UsualItem[];
  /** Tags never acceptable on any product (dietary rules), e.g. "high-sodium". */
  avoidTags: string[];
  /** Words that disqualify a product, e.g. "skim", "spicy". */
  dislikedTerms: string[];
  /** Max relative price increase for a substitution (0.3 = 30% more than usual). */
  maxSubstitutionIncrease: number;
  /** Hard per-order spending limit enforced at checkout, in dollars. */
  spendingLimit: number;
  /** Saved payment method reference. Display data only, never a card number. */
  paymentMethod: { network: "visa"; last4: string; label: string; tokenRef: string };
  deliveryAddressLabel: string;
}

export interface PastOrder {
  placedAt: number;
  items: string[];
  total: number;
}

export type LineDecision = "usual" | "substituted" | "skipped";

export interface CartLine {
  /** Usual-item key this line fulfils. */
  itemKey: string;
  label: string;
  decision: LineDecision;
  /** Plain-language explanation of what Care chose and why. */
  reason: string;
  productId?: string;
  productName?: string;
  brand?: string;
  size?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  source?: ProductCandidate["source"];
  url?: string;
}

export interface CartTotals {
  subtotal: number;
  deliveryFee: number;
  total: number;
}

export interface ShoppingCart extends CartTotals {
  lines: CartLine[];
  /** Fingerprint of priced lines + total. Approval is bound to this. */
  cartHash: string;
  status: "ready" | "ordered" | "superseded";
}

export type OrderStage = "placed" | "packed" | "out_for_delivery" | "delivered";

export interface TrackingStep {
  stage: OrderStage;
  label: string;
  done: boolean;
  at?: number;
}
