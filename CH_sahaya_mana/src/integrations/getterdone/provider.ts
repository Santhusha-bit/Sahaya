import { AgentError } from "@/agents/base/errors";
import { hashValue } from "@/lib/ids";
import { appEnv, type EnvLike } from "@/lib/config/env";
import { getterdoneConfig } from "./config";
import { GetterDoneClient } from "./client";

/**
 * Home-service provider interface used by the Care agent's booking tools. Two implementations:
 *
 *  - GetterDoneSandboxProvider — an in-app sandbox behind the GetterDone adapter interface. GetterDone documents no
 *    sandbox or test environment (checked 2026-10-24: docs/api, docs/integrations, OpenAPI), so this one runs entirely
 *    inside Sahaya: deterministic provider names, estimates, reference numbers and a clock-driven status. It never makes
 *    a network call. It is refused in production configuration unless the server is loopback-only (see
 *    sandboxProviderAllowed and src/lib/security/envCheck.ts), so sandbox bookings can't be shown to real users.
 *  - GetterDoneLiveProvider — wraps the allowlisted GetterDoneClient. Booking (POST /api/tasks) is hard-disabled.
 */
export interface QuoteRequest {
  service: string;
  windowStart: number;
  windowEnd: number;
}
export interface Quote {
  provider: string;
  estimateCents: number | null;
}
export interface BookRequest extends QuoteRequest {
  proposalHash: string;
  userKey: string;
}
export interface BookResult {
  provider: string;
  reference: string;
  arrival: { start: number; end: number };
  status: "booked";
}
export interface HomeServiceProvider {
  readonly id: "getterdone-sandbox" | "getterdone-live";
  readonly mode: "sandbox" | "live";
  quote(req: QuoteRequest): Promise<Quote>;
  book(req: BookRequest): Promise<BookResult>;
}

/** Fictional local providers and typical estimates for the sandbox. */
const SANDBOX: Record<string, { provider: string; estimateCents: number | null }> = {
  plumbing: { provider: "Bayside Plumbing Co.", estimateCents: 15000 },
  electrical: { provider: "Brightline Electric", estimateCents: 17500 },
  handyman: { provider: "Handy Hands Home Repair", estimateCents: 9500 },
  appliance: { provider: "FixRight Appliance Service", estimateCents: 12500 },
  hvac: { provider: "Comfort Air Heating & Cooling", estimateCents: 16000 },
  tech: { provider: "TechBuddy Home Help", estimateCents: 6500 },
  cleaning: { provider: "Sparkle Home Cleaning", estimateCents: 12000 },
  chores: { provider: "Helping Hands Errands", estimateCents: 6000 },
};

export class GetterDoneSandboxProvider implements HomeServiceProvider {
  readonly id = "getterdone-sandbox" as const;
  readonly mode = "sandbox" as const;
  async quote(req: QuoteRequest): Promise<Quote> {
    const p = SANDBOX[req.service];
    if (!p) throw new AgentError("VALIDATION_FAILED", "That kind of help isn't available.");
    return { provider: p.provider, estimateCents: p.estimateCents };
  }
  async book(req: BookRequest): Promise<BookResult> {
    const q = await this.quote(req);
    const h = hashValue({ p: req.proposalHash, u: req.userKey, s: req.windowStart }).toUpperCase();
    return { provider: q.provider, reference: `GD-${h.slice(0, 4)}-${h.slice(4, 8)}`, arrival: { start: req.windowStart, end: req.windowEnd }, status: "booked" };
  }
}

export class GetterDoneLiveProvider implements HomeServiceProvider {
  readonly id = "getterdone-live" as const;
  readonly mode = "live" as const;
  constructor(private readonly client: GetterDoneClient) {}
  async quote(): Promise<Quote> {
    throw new AgentError("INTEGRATION_UNAVAILABLE", "Live home-service booking isn't enabled.");
  }
  async book(): Promise<BookResult> {
    // POST /api/tasks secures the owner's card and contacts workers: hard-disabled in this build.
    return this.client.createTask({ title: "disabled", description: "disabled".padEnd(20, "."), category: "Handyman", reward: 1, expiresInHours: 24 });
  }
}

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/;

/** Home services can be switched off entirely (SAHAYA_HOME_SERVICES=off). */
export function homeServicesEnabled(env: EnvLike = process.env) {
  return (appEnv(env, "HOME_SERVICES") ?? "").trim().toLowerCase() !== "off";
}

/**
 * The sandbox provider may only serve development, tests, or a production build bound to loopback (local E2E).
 * Any other production configuration refuses it, so sandbox bookings are never presented to real users as real.
 */
export function sandboxProviderAllowed(env: EnvLike = process.env) {
  return env.NODE_ENV !== "production" || LOOPBACK.test((env.APP_BASE_URL ?? "").trim());
}

let override: HomeServiceProvider | null = null;
/** Test seam. */
export function setHomeServiceProvider(p: HomeServiceProvider | null) {
  override = p;
}

export function homeServiceProvider(env: EnvLike = process.env): HomeServiceProvider {
  if (override) return override;
  if (!homeServicesEnabled(env)) throw new AgentError("INTEGRATION_UNAVAILABLE", "Home repair help isn't available right now.");
  if (!sandboxProviderAllowed(env)) {
    throw new AgentError("INTEGRATION_UNAVAILABLE", "Home repair help isn't available right now.", { reason: "sandbox provider refused in production" });
  }
  return new GetterDoneSandboxProvider();
}

/** For completeness: the live provider object (booking always refuses). Not selected by this build. */
export function liveProvider(env: EnvLike = process.env) {
  return new GetterDoneLiveProvider(new GetterDoneClient(getterdoneConfig(env)));
}
