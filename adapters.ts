/**
 * Care integration adapters. Each adapter reports its own mode; the only implementations in this
 * build are local simulators (mode "sandbox"). A sandbox adapter can never be presented as live:
 * `resolveAdapter` refuses to run when the platform claims an integration is live but only a
 * simulator exists, and every simulator result carries `simulated: true`.
 *
 * Simulator state lives in Care's own `care.sandbox` namespace so it is per-user and per-runtime.
 */
import type { IntegrationId, IntegrationMode } from "@/integrations/status";
import { AgentError } from "../base/errors";
import { newId } from "@/lib/ids";
import { SANDBOX_CATALOG } from "./data/catalog";
import type { Product } from "./domain/grocery";
import { addLocalDays, friendlyTime, localDateOf, zonedTimeToUtc } from "./domain/time";
import { sanitizeUntrusted, type UntrustedText } from "./domain/untrusted";
import { NS, type CareRepo, type OrderStatus, type VoiceUtterance } from "./repository";

export interface AdapterInfo {
  integration: IntegrationId;
  mode: IntegrationMode;
  provider: string;
}

// ── Pharmacy ───────────────────────────────────────────────────────────────

export type PharmacyStatus = "submitted" | "ready" | "picked_up" | "rejected" | "out_of_stock" | "no_refills_remaining";
export type PharmacyScenario = "accept" | "rejected" | "out_of_stock" | "no_refills_remaining";

export interface RefillSubmission {
  idempotencyKey: string;
  rxNumber: string;
  medicationName: string;
  quantity: number;
  pharmacyId: string;
  fulfillment: "pickup" | "delivery";
}

export interface PharmacyRequestView {
  requestId: string;
  status: PharmacyStatus;
  message: UntrustedText;
  simulated: boolean;
  updatedAt: number;
}

export interface PharmacyAdapter extends AdapterInfo {
  submitRefill(userId: string, req: RefillSubmission): Promise<PharmacyRequestView & { duplicate: boolean }>;
  getStatus(userId: string, requestId: string): Promise<PharmacyRequestView>;
  markPickedUp(userId: string, requestId: string): Promise<PharmacyRequestView>;
}

interface SandboxPharmacyState {
  scenarios: Record<string, PharmacyScenario>;
  messages: Record<string, string>;
  requests: Record<string, { requestId: string; key: string; submittedAt: number; scenario: PharmacyScenario; pickedUpAt?: number; message: string }>;
  readyAfterMs: number;
}

const PHARMACY_STATE = "pharmacy";

export class SandboxPharmacyAdapter implements PharmacyAdapter {
  readonly integration = "pharmacy" as const;
  readonly mode = "sandbox" as const;
  readonly provider = "Sandbox pharmacy simulator (no prescriptions are transmitted)";

  constructor(private readonly repo: CareRepo, private readonly now: () => number) {}

  private async state(userId: string): Promise<SandboxPharmacyState> {
    return (
      (await this.repo.get<SandboxPharmacyState>(userId, NS.sandbox, PHARMACY_STATE)) ?? {
        scenarios: {},
        messages: {},
        requests: {},
        readyAfterMs: 2 * 60 * 60 * 1000,
      }
    );
  }
  private save(userId: string, s: SandboxPharmacyState) {
    return this.repo.put(userId, NS.sandbox, PHARMACY_STATE, s, "Sandbox pharmacy simulator state");
  }

  /** Test/demo control: how the simulated pharmacy answers for one prescription. */
  async setScenario(userId: string, rxNumber: string, scenario: PharmacyScenario, message?: string) {
    const s = await this.state(userId);
    s.scenarios[rxNumber] = scenario;
    if (message !== undefined) s.messages[rxNumber] = message;
    await this.save(userId, s);
  }

  private view(r: SandboxPharmacyState["requests"][string], readyAfterMs: number): PharmacyRequestView {
    const now = this.now();
    let status: PharmacyStatus;
    if (r.scenario !== "accept") status = r.scenario;
    else if (r.pickedUpAt) status = "picked_up";
    else status = now >= r.submittedAt + readyAfterMs ? "ready" : "submitted";
    return { requestId: r.requestId, status, message: sanitizeUntrusted(r.message, "pharmacy"), simulated: true, updatedAt: now };
  }

  async submitRefill(userId: string, req: RefillSubmission) {
    const s = await this.state(userId);
    const existing = Object.values(s.requests).find((r) => r.key === req.idempotencyKey);
    if (existing) return { ...this.view(existing, s.readyAfterMs), duplicate: true };
    const scenario = s.scenarios[req.rxNumber] ?? "accept";
    const defaults: Record<PharmacyScenario, string> = {
      accept: "Sandbox pharmacy: refill request received (simulated).",
      rejected: "Sandbox pharmacy: request rejected — please contact the pharmacy (simulated).",
      out_of_stock: "Sandbox pharmacy: medication out of stock (simulated).",
      no_refills_remaining: "Sandbox pharmacy: no refills remaining; prescriber authorization needed (simulated).",
    };
    const rec = {
      requestId: newId("rxreq"),
      key: req.idempotencyKey,
      submittedAt: this.now(),
      scenario,
      message: s.messages[req.rxNumber] ?? defaults[scenario],
    };
    s.requests[rec.requestId] = rec;
    await this.save(userId, s);
    return { ...this.view(rec, s.readyAfterMs), duplicate: false };
  }

  async getStatus(userId: string, requestId: string) {
    const s = await this.state(userId);
    const r = s.requests[requestId];
    if (!r) throw new AgentError("NOT_FOUND", `pharmacy request ${requestId} not found`);
    return this.view(r, s.readyAfterMs);
  }

  async markPickedUp(userId: string, requestId: string) {
    const s = await this.state(userId);
    const r = s.requests[requestId];
    if (!r) throw new AgentError("NOT_FOUND", `pharmacy request ${requestId} not found`);
    if (this.view(r, s.readyAfterMs).status !== "ready") {
      throw new AgentError("VALIDATION_FAILED", "the refill isn't ready for pickup yet");
    }
    r.pickedUpAt = this.now();
    await this.save(userId, s);
    return this.view(r, s.readyAfterMs);
  }
}

// ── Grocery ────────────────────────────────────────────────────────────────

export interface DeliveryWindow {
  id: string;
  label: string;
  start: number;
  end: number;
}

export interface GroceryOrderRequest {
  idempotencyKey: string;
  lines: Array<{ productId: string; quantity: number; unitPriceCents: number }>;
  totalCents: number;
  window: DeliveryWindow;
}

export interface GroceryOrderView {
  providerOrderId: string;
  status: OrderStatus;
  simulated: boolean;
  updatedAt: number;
}

export interface GroceryAdapter extends AdapterInfo {
  catalog(userId: string): Promise<Product[]>;
  getProduct(userId: string, id: string): Promise<Product | undefined>;
  search(userId: string, query: string): Promise<Product[]>;
  deliveryWindows(now: number, timeZone: string): DeliveryWindow[];
  placeOrder(userId: string, req: GroceryOrderRequest): Promise<GroceryOrderView & { duplicate: boolean }>;
  getOrder(userId: string, providerOrderId: string): Promise<GroceryOrderView>;
}

interface SandboxGroceryState {
  stock: Record<string, boolean>;
  orders: Record<string, { id: string; key: string; placedAt: number; window: DeliveryWindow; cancelled?: boolean }>;
}
const GROCERY_STATE = "grocery";

export class SandboxGroceryAdapter implements GroceryAdapter {
  readonly integration = "commerce" as const;
  readonly mode = "sandbox" as const;
  readonly provider = "Sandbox grocery simulator (no purchases or deliveries happen)";

  constructor(private readonly repo: CareRepo, private readonly now: () => number) {}

  private async state(userId: string): Promise<SandboxGroceryState> {
    return (await this.repo.get<SandboxGroceryState>(userId, NS.sandbox, GROCERY_STATE)) ?? { stock: {}, orders: {} };
  }
  private save(userId: string, s: SandboxGroceryState) {
    return this.repo.put(userId, NS.sandbox, GROCERY_STATE, s, "Sandbox grocery simulator state");
  }

  /** Test/demo control. */
  async setStock(userId: string, productId: string, inStock: boolean) {
    const s = await this.state(userId);
    s.stock[productId] = inStock;
    await this.save(userId, s);
  }

  async catalog(userId: string): Promise<Product[]> {
    const s = await this.state(userId);
    return SANDBOX_CATALOG.map((p) => (p.id in s.stock ? { ...p, inStock: s.stock[p.id] } : p));
  }

  async getProduct(userId: string, id: string) {
    return (await this.catalog(userId)).find((p) => p.id === id);
  }

  async search(userId: string, query: string) {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
    if (!terms.length) return [];
    return (await this.catalog(userId))
      .map((p) => {
        const hay = `${p.name} ${p.brand} ${p.category} ${p.substituteGroup.replace(/_/g, " ")}`.toLowerCase();
        return { p, score: terms.filter((t) => hay.includes(t) || hay.includes(t.replace(/s$/, ""))).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      // Multi-word queries keep only the best-matching products ("peanut butter" ≠ "unsalted butter").
      .filter((x, _i, all) => terms.length === 1 || x.score === all[0].score)
      .map((x) => x.p);
  }

  deliveryWindows(now: number, timeZone: string): DeliveryWindow[] {
    const tomorrow = addLocalDays(localDateOf(now, timeZone), 1);
    return [
      ["09:00", "11:00"],
      ["13:00", "15:00"],
      ["17:00", "19:00"],
    ].map(([a, b]) => {
      const start = zonedTimeToUtc(tomorrow, a, timeZone);
      const end = zonedTimeToUtc(tomorrow, b, timeZone);
      return { id: `win_${tomorrow}_${a.replace(":", "")}`, label: `Tomorrow ${friendlyTime(start, timeZone)}–${friendlyTime(end, timeZone)}`, start, end };
    });
  }

  async placeOrder(userId: string, req: GroceryOrderRequest) {
    const s = await this.state(userId);
    const existing = Object.values(s.orders).find((o) => o.key === req.idempotencyKey);
    if (existing) return { ...(await this.getOrder(userId, existing.id)), duplicate: true };
    const id = newId("sbx_order");
    s.orders[id] = { id, key: req.idempotencyKey, placedAt: this.now(), window: req.window };
    await this.save(userId, s);
    return { ...(await this.getOrder(userId, id)), duplicate: false };
  }

  /** Simulated lifecycle: placed → picking (+15 min) → out_for_delivery (window start) → delivered (+45 min). */
  async getOrder(userId: string, providerOrderId: string): Promise<GroceryOrderView> {
    const s = await this.state(userId);
    const o = s.orders[providerOrderId];
    if (!o) throw new AgentError("NOT_FOUND", `order ${providerOrderId} not found`);
    const now = this.now();
    const outAt = Math.max(o.window.start, o.placedAt + 60 * 60 * 1000);
    let status: OrderStatus = "placed";
    if (o.cancelled) status = "cancelled";
    else if (now >= outAt + 45 * 60 * 1000) status = "delivered";
    else if (now >= outAt) status = "out_for_delivery";
    else if (now >= o.placedAt + 15 * 60 * 1000) status = "picking";
    return { providerOrderId, status, simulated: true, updatedAt: now };
  }
}

// ── Meal delivery ──────────────────────────────────────────────────────────

export interface MealDeliveryAdapter extends AdapterInfo {
  book(userId: string, req: { idempotencyKey: string; meals: number; window: DeliveryWindow; totalCents: number }): Promise<{ bookingId: string; status: "booked"; simulated: boolean; duplicate: boolean }>;
}

export class SandboxMealDeliveryAdapter implements MealDeliveryAdapter {
  readonly integration = "delivery" as const;
  readonly mode = "sandbox" as const;
  readonly provider = "Sandbox meal-delivery simulator (nothing is booked or charged)";
  constructor(private readonly repo: CareRepo, private readonly now: () => number) {}
  async book(userId: string, req: { idempotencyKey: string; meals: number; window: DeliveryWindow; totalCents: number }) {
    const key = `meal_${req.idempotencyKey}`;
    const existing = await this.repo.get<{ bookingId: string }>(userId, NS.sandbox, key);
    if (existing) return { bookingId: existing.bookingId, status: "booked" as const, simulated: true, duplicate: true };
    const bookingId = newId("sbx_meal");
    await this.repo.put(userId, NS.sandbox, key, { bookingId, at: this.now(), ...req }, "Sandbox meal booking");
    return { bookingId, status: "booked" as const, simulated: true, duplicate: false };
  }
}

// ── Voice ──────────────────────────────────────────────────────────────────

export interface VoiceChannel extends AdapterInfo {
  /** Deliver one short prompt to the user. Sandbox: recorded in the Care voice log only. */
  say(userId: string, text: string, purpose: string, relatedId?: string): Promise<VoiceUtterance>;
  /** Record what the user said (a transcript from the voice layer or the demo script). */
  heard(userId: string, text: string, purpose: string, relatedId?: string): Promise<VoiceUtterance>;
}

/**
 * The Care voice channel. Prompts are recorded in Care's voice log and played by the Sahaya app:
 *  - "sandbox": no speech provider; text only (the browser may read it aloud, labelled as browser speech).
 *  - "live": Cartesia is configured and working; the app speaks prompts with Cartesia while it's open.
 * Neither mode places phone calls.
 */
export class AppVoiceChannel implements VoiceChannel {
  readonly integration = "voice" as const;
  readonly provider: string;
  constructor(
    private readonly repo: CareRepo,
    private readonly now: () => number,
    readonly mode: "live" | "sandbox" = "sandbox",
  ) {
    this.provider =
      mode === "live"
        ? "Cartesia voice, played in the Sahaya app while it's open (no phone calls)"
        : "Sandbox voice simulator (prompts are recorded in-app; no calls or audio)";
  }

  private async record(userId: string, u: Omit<VoiceUtterance, "id" | "at" | "channelMode" | "simulated">) {
    const utt: VoiceUtterance = { id: newId("utt"), at: this.now(), channelMode: this.mode, simulated: this.mode !== "live", ...u };
    // Transcripts are untrusted input: kept short and never placed in memory search text.
    utt.text = utt.direction === "from_user" ? sanitizeUntrusted(utt.text, "transcript", 500).text : utt.text;
    await this.repo.put(userId, NS.voice, utt.id, utt, "");
    return utt;
  }
  say(userId: string, text: string, purpose: string, relatedId?: string) {
    return this.record(userId, { direction: "to_user", text, purpose, relatedId });
  }
  heard(userId: string, text: string, purpose: string, relatedId?: string) {
    return this.record(userId, { direction: "from_user", text, purpose, relatedId });
  }
}

/** Kept for existing imports: the simulator flavour of the app voice channel. */
export class SandboxVoiceChannel extends AppVoiceChannel {
  constructor(repo: CareRepo, now: () => number) {
    super(repo, now, "sandbox");
  }
}

// ── Bundle + honesty guard ─────────────────────────────────────────────────

export interface CareAdapters {
  pharmacy: SandboxPharmacyAdapter;
  grocery: SandboxGroceryAdapter;
  mealDelivery: SandboxMealDeliveryAdapter;
  voice: AppVoiceChannel;
}

/** Pharmacy, grocery and delivery are always simulators; voice is live only when Cartesia is live. */
export function createSandboxAdapters(repo: CareRepo, now: () => number, voiceMode: "live" | "sandbox" = "sandbox"): CareAdapters {
  return {
    pharmacy: new SandboxPharmacyAdapter(repo, now),
    grocery: new SandboxGroceryAdapter(repo, now),
    mealDelivery: new SandboxMealDeliveryAdapter(repo, now),
    voice: new AppVoiceChannel(repo, now, voiceMode),
  };
}

/**
 * Returns the adapter only if its real mode matches what the platform reports. If the platform says
 * "live" but only a simulator exists, refuse instead of silently simulating under a live label.
 */
export function resolveAdapter<A extends AdapterInfo>(adapter: A, platformMode: (id: IntegrationId) => IntegrationMode): A {
  const reported = platformMode(adapter.integration);
  if (reported === "unavailable") {
    throw new AgentError("INTEGRATION_UNAVAILABLE", `${adapter.provider} is unavailable`);
  }
  if (reported === "live" && adapter.mode !== "live") {
    throw new AgentError(
      "INTEGRATION_UNAVAILABLE",
      `${adapter.integration} is reported live, but only a sandbox simulator is implemented; refusing to misrepresent it`,
    );
  }
  return adapter;
}

export function describeAdapters(adapters: CareAdapters, platformMode: (id: IntegrationId) => IntegrationMode) {
  return (Object.values(adapters) as AdapterInfo[]).map((a) => {
    const reported = platformMode(a.integration);
    // Effective mode never exceeds what is implemented; a "live" claim over a simulator is a misconfiguration.
    const misconfigured = reported === "live" && a.mode !== "live";
    const mode: IntegrationMode = reported === "unavailable" || misconfigured ? "unavailable" : a.mode;
    return {
      integration: a.integration,
      provider: a.provider,
      mode,
      detail: misconfigured ? "Reported live, but only a simulator exists — disabled" : a.provider,
    };
  });
}
