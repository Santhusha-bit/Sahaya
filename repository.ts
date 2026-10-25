import type { ScopedAgentStore } from "../base/AgentStore";
import { AgentError } from "../base/errors";
import type { Cart, Product, SafetyProfile, SpendingLimits } from "./domain/grocery";
import type { CookingSession, PantryItem } from "./domain/meals";
import type { DoseRecord, EscalationRule, Medication } from "./domain/medication";

/** Care's memory namespaces. The first six were declared by the original scaffold. */
export const NS = {
  medications: "care.medications",
  doses: "care.confirmations",
  groceryPreferences: "care.groceryPreferences",
  shoppingHistory: "care.shoppingHistory",
  pantry: "care.pantry",
  orders: "care.orders",
  profile: "care.profile",
  alerts: "care.alerts",
  refills: "care.refills",
  carts: "care.carts",
  voice: "care.voice",
  cooking: "care.cooking",
  pending: "care.pending",
  helpRequests: "care.helpRequests",
  sandbox: "care.sandbox",
  /** Learned memory about the person (structured facts with status and provenance), plus hash-only tombstones. */
  memory: "care.memory",
  /** Short-lived conversation state (e.g. the current topics). Not memory about the person. */
  session: "care.session",
  /**
   * Household-service requests and proposals (GetterDone demo). Owner-only: it has no caregiver read/write rule in
   * accessRules.NAMESPACE_RULE, so caregivers can neither see nor change it (default deny, also in Convex).
   */
  homeServices: "care.homeServices",
} as const;

export const CARE_NAMESPACES: string[] = Object.values(NS);

export interface CareProfile {
  displayName: string;
  /** True for the fictional demo persona; shown as "Demo profile" everywhere. */
  isDemo: boolean;
  timeZone: string;
  escalation: EscalationRule;
  /** Which caregiver is notified for Care alerts (ids only; contact details live with Guardian). */
  caregiverIds: string[];
}

export interface GroceryPreferences {
  safety: SafetyProfile;
  preferredBrands: string[];
  /** e.g. "Prefers oat milk" — shown back to the user, never parsed for decisions. */
  notes: string[];
  usualItems: Array<{ productId: string; quantity: number }>;
  essentials: Array<{ label: string; substituteGroup: string; defaultProductId: string; quantity: number }>;
  limits: SpendingLimits;
  /** True when the limits are Sahaya's conservative defaults, not something the user or a caregiver set. */
  limitsAreDefault?: boolean;
  deliveryFeeCents: number;
  demo: boolean;
}

export type AlertKind = "missed_doses" | "refill_needed" | "refill_problem" | "help_request" | "medication_safety" | "spending";

export interface CareAlert {
  id: string;
  kind: AlertKind;
  area: "medications" | "grocery";
  severity: "info" | "attention" | "urgent";
  title: string;
  /** Minimal, non-diagnostic detail. */
  detail: string;
  relatedIds: string[];
  createdAt: number;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
  /** Guardian event id when the alert was also escalated through the event bus. */
  escalationEventId?: string;
  escalationStatus?: string;
  demo: boolean;
}

export type RefillStatus =
  | "draft"
  | "blocked"
  | "submitted"
  | "ready"
  | "picked_up"
  | "rejected"
  | "out_of_stock"
  | "no_refills_remaining";

export interface RefillRecord {
  id: string;
  medicationId: string;
  medicationName: string;
  quantity: number | null;
  rxNumber: string | null;
  pharmacy: { id: string; name: string } | null;
  lastFill: { date: string; quantity: number } | null;
  refillsRemaining: number | null;
  fulfillment: "pickup" | "delivery";
  /** Fields that must be present before submission; never invented. */
  missing: string[];
  status: RefillStatus;
  draftHash: string;
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  approvalId?: string;
  pharmacyRequestId?: string;
  /** Pharmacy messages are untrusted text, sanitized and flagged. */
  pharmacyMessages: Array<{ at: number; text: string; flagged: boolean }>;
  statusHistory: Array<{ at: number; status: RefillStatus }>;
  simulated: boolean;
  demo: boolean;
}

export type OrderStatus = "placed" | "picking" | "out_for_delivery" | "delivered" | "cancelled" | "failed";

export interface OrderRecord {
  id: string;
  cartId: string;
  cartHash: string;
  lines: Array<{ productId: string; name: string; quantity: number; unitPriceCents: number; substitutedFor?: string }>;
  totalCents: number;
  deliveryWindow: { id: string; label: string; start: number; end: number };
  status: OrderStatus;
  statusHistory: Array<{ at: number; status: OrderStatus }>;
  placedAt: number;
  approvalId?: string;
  providerOrderId: string;
  simulated: boolean;
  demo: boolean;
  confirmationMessage?: string;
}

export interface VoiceUtterance {
  id: string;
  at: number;
  direction: "to_user" | "from_user";
  text: string;
  purpose: string;
  relatedId?: string;
  channelMode: "live" | "sandbox";
  /** A sandbox prompt is recorded, not spoken or dialled. */
  simulated: boolean;
}

export interface PendingConfirmation {
  id: string;
  kind: "pill_count" | "essential_addition" | "memory_fact" | "memory_forget";
  medicationId?: string;
  factId?: string;
  count?: number;
  question: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "confirmed" | "declined" | "expired";
}

export interface HelpRequestRecord {
  id: string;
  need: "medication_pickup" | "grocery_pickup" | "mobility" | "home_task" | "other";
  summary: string;
  status: "awaiting_consent" | "sent" | "declined" | "route_disabled" | "failed";
  eventId?: string;
  createdAt: number;
  updatedAt: number;
  demo: boolean;
}

export interface MealPlanRecord {
  id: string;
  date: string;
  mealType: string;
  ideas: Array<{ recipeId: string; name: string; minutes: number; uses: string[]; usesExpiring: string[]; missing: string[] }>;
  excluded: Array<{ recipeId: string; name: string; reasons: string[] }>;
  createdAt: number;
}

/** Typed access to Care's own namespaces through its scoped store (isolation stays enforced there). */
export class CareRepo {
  constructor(
    private readonly store: ScopedAgentStore,
    private readonly now: () => number,
  ) {}

  async get<T>(userId: string, ns: string, key: string): Promise<T | null> {
    const rec = await this.store.getMemory(userId, ns, key);
    return rec ? (rec.value as T) : null;
  }

  async require<T>(userId: string, ns: string, key: string, what: string): Promise<T> {
    const v = await this.get<T>(userId, ns, key);
    if (v === null) throw new AgentError("NOT_FOUND", `${what} not found`);
    return v;
  }

  async put(userId: string, ns: string, key: string, value: unknown, text: string) {
    const existing = await this.store.getMemory(userId, ns, key);
    const now = this.now();
    await this.store.putMemory({
      id: existing?.id ?? `mem_${ns}_${key}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 120),
      userId,
      namespace: ns,
      key,
      value,
      text,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async list<T>(userId: string, ns: string): Promise<T[]> {
    return (await this.store.listMemory(userId, ns)).sort((a, b) => a.createdAt - b.createdAt).map((r) => r.value as T);
  }

  async delete(userId: string, ns: string, key: string) {
    await this.store.deleteMemory(userId, ns, key);
  }

  // Typed helpers
  profile(userId: string) {
    return this.get<CareProfile>(userId, NS.profile, "profile");
  }
  preferences(userId: string) {
    return this.get<GroceryPreferences>(userId, NS.groceryPreferences, "preferences");
  }
  medications(userId: string) {
    return this.list<Medication>(userId, NS.medications);
  }
  medication(userId: string, id: string) {
    return this.require<Medication>(userId, NS.medications, id, `medication ${id}`);
  }
  saveMedication(userId: string, m: Medication) {
    return this.put(userId, NS.medications, m.id, m, `Medication ${m.name}: ${m.schedule.map((s) => `${s.slot} ${s.time}`).join(", ")}`);
  }
  doses(userId: string) {
    return this.list<DoseRecord>(userId, NS.doses);
  }
  saveDose(userId: string, d: DoseRecord) {
    return this.put(userId, NS.doses, d.id, d, `Dose ${d.slot} on ${d.localDate}: ${d.state}`);
  }
  alerts(userId: string) {
    return this.list<CareAlert>(userId, NS.alerts);
  }
  saveAlert(userId: string, a: CareAlert) {
    return this.put(userId, NS.alerts, a.id, a, `Care alert: ${a.title}`);
  }
  refills(userId: string) {
    return this.list<RefillRecord>(userId, NS.refills);
  }
  saveRefill(userId: string, r: RefillRecord) {
    return this.put(userId, NS.refills, r.id, r, `Refill for ${r.medicationName}: ${r.status}`);
  }
  carts(userId: string) {
    return this.list<Cart>(userId, NS.carts);
  }
  saveCart(userId: string, c: Cart) {
    return this.put(userId, NS.carts, c.id, c, `Grocery cart (${c.lines.length} items, ${c.status})`);
  }
  orders(userId: string) {
    return this.list<OrderRecord>(userId, NS.orders);
  }
  saveOrder(userId: string, o: OrderRecord) {
    return this.put(userId, NS.orders, o.id, o, `Grocery order ${o.id}: ${o.status}`);
  }
  pantry(userId: string) {
    return this.list<PantryItem>(userId, NS.pantry);
  }
  savePantryItem(userId: string, p: PantryItem) {
    return this.put(userId, NS.pantry, p.id, p, `Pantry: ${p.name} x${p.quantity}${p.expiresOn ? ` (expires ${p.expiresOn})` : ""}`);
  }
  voiceLog(userId: string) {
    return this.list<VoiceUtterance>(userId, NS.voice);
  }
  cooking(userId: string) {
    return this.get<CookingSession>(userId, NS.cooking, "current");
  }
  saveCooking(userId: string, s: CookingSession) {
    return this.put(userId, NS.cooking, "current", s, `Cooking ${s.recipeName}: step ${s.stepIndex + 1}/${s.totalSteps}`);
  }
}

export type { Product };
