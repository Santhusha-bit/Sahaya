import { z } from "zod";
import { AgentError } from "@/agents/base/errors";
import { GETTERDONE_BASE_URL, type GetterDoneConfig } from "./config";

/**
 * GetterDone HTTP client with a hard allowlist. Only two documented operations can ever reach the network:
 *
 *  - POST /api/auth/agent/token  — OAuth2 client_credentials exchange (docs: "Authentication", step 2). Needed only for
 *                                  the price check below. Issues a bearer token; creates no task.
 *  - POST /api/tasks/quote       — OpenAPI operationId quoteTask: "Price a task without creating it … Nothing is
 *                                  charged." Returns reward, platformFee, total, currency, tokenStatus,
 *                                  confirmationToken (10 min).
 *
 * Everything else is refused BEFORE any network call with DEMO_MODE_BLOCKED — in particular the documented
 * consequential operations (task creation secures the owner's card and makes the task visible to workers; complete
 * releases payment; cancel/dispute/rate/attachments/webhooks/fund/register/feedback change state). Live task creation
 * is hard-disabled in this build regardless of GETTERDONE_DEMO_MODE: it needs the owner's future authorization.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const ALLOWED_OPERATIONS: ReadonlyArray<{ method: HttpMethod; path: string; source: string }> = [
  { method: "POST", path: "/api/auth/agent/token", source: "https://www.getterdone.ai/docs/api#authentication (OpenAPI: POST /api/auth/agent/token)" },
  { method: "POST", path: "/api/tasks/quote", source: "https://getterdone.ai/api/openapi (operationId quoteTask: \"Nothing is charged\")" },
];

/** Documented operations that create, pay, contact workers or otherwise change state. Never called. */
export const BLOCKED_OPERATIONS: ReadonlyArray<{ method: HttpMethod; path: string; why: string }> = [
  { method: "POST", path: "/api/tasks", why: "creates a task: secures the owner's card for reward + fee and makes it visible to workers" },
  { method: "POST", path: "/api/tasks/{id}/complete", why: "releases payment to the worker" },
  { method: "POST", path: "/api/tasks/{id}/cancel", why: "cancels a task and refunds/voids the card hold" },
  { method: "POST", path: "/api/tasks/{id}/dispute", why: "disputes a worker's submission" },
  { method: "POST", path: "/api/tasks/{id}/rate", why: "rates a worker" },
  { method: "POST", path: "/api/tasks/{id}/attachments", why: "attaches files to a task workers can see" },
  { method: "POST", path: "/api/agents/fund", why: "deprecated funding call" },
  { method: "POST", path: "/api/agents/webhooks", why: "changes the agent's webhook" },
  { method: "POST", path: "/api/agents/events/ack", why: "acknowledges the agent's event inbox" },
  { method: "PUT", path: "/api/agents/me", why: "renames the agent" },
  { method: "POST", path: "/api/auth/agent/register", why: "registers a new agent" },
  { method: "POST", path: "/api/platform/feedback", why: "sends feedback to the platform" },
];

export class DemoModeBlocked extends AgentError {
  constructor(readonly operation: string, reason = "Demo mode: Sahaya can't book, pay for or contact anyone through GetterDone.") {
    super("DEMO_MODE_BLOCKED", reason, { operation });
    this.name = "DemoModeBlocked";
  }
}

/** Numbers and enums only: free text from the API is never used (prompt-injection safe by construction). */
const quoteResponse = z.object({
  success: z.literal(true),
  data: z.object({
    reward: z.number().finite().min(0).max(100_000),
    platformFee: z.number().finite().min(0).max(100_000),
    total: z.number().finite().min(0).max(100_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    tokenStatus: z.enum(["ready", "none"]).optional(),
  }),
});

const tokenResponse = z.object({ access_token: z.string().min(10).max(5000), expires_in: z.number().int().positive().max(86_400).optional() });

export interface QuoteInput {
  title: string;
  description: string;
  category: string;
  reward: number;
  expiresInHours: number;
  location?: { lat: number; lng: number; label: string };
  remote?: boolean;
}

export interface QuoteResult {
  rewardCents: number;
  platformFeeCents: number;
  totalCents: number;
  currency: string;
  fundingReady: boolean | null;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export class GetterDoneClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: GetterDoneConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly opts: { timeoutMs?: number; now?: () => number } = {},
  ) {}

  /** The one gate every request passes through: exact method + path allowlist, checked before the network. */
  private assertAllowed(method: HttpMethod, path: string) {
    if (!ALLOWED_OPERATIONS.some((o) => o.method === method && o.path === path)) throw new DemoModeBlocked(`${method} ${path}`);
  }

  private async call(method: HttpMethod, path: string, body: unknown, bearer?: string) {
    this.assertAllowed(method, path);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${GETTERDONE_BASE_URL}${path}`, {
        method,
        headers: { "content-type": "application/json", accept: "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      // No URL, headers or body in the message: they could carry the key or the request details.
      throw new AgentError("INTEGRATION_UNAVAILABLE", timeout ? "GetterDone didn't answer in time." : "Couldn't reach GetterDone.", { operation: path }, true);
    }
    if (res.status === 401 || res.status === 403) throw new AgentError("INTEGRATION_UNAVAILABLE", "GetterDone didn't accept the credentials.", { operation: path, status: res.status });
    if (!res.ok) throw new AgentError("INTEGRATION_UNAVAILABLE", "GetterDone returned an error.", { operation: path, status: res.status }, res.status >= 500 || res.status === 429);
    try {
      return await res.json();
    } catch {
      throw new AgentError("INTEGRATION_UNAVAILABLE", "GetterDone sent a response Sahaya couldn't read.", { operation: path });
    }
  }

  private async bearer(): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value;
    const creds = this.cfg.credentials;
    if (!creds) throw new AgentError("INTEGRATION_UNAVAILABLE", this.cfg.keyProblem ?? "GetterDone isn't configured.");
    const json = await this.call("POST", "/api/auth/agent/token", { client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "client_credentials" });
    const parsed = tokenResponse.safeParse(json);
    if (!parsed.success) throw new AgentError("INTEGRATION_UNAVAILABLE", "GetterDone sent a sign-in response Sahaya couldn't read.", { operation: "token" });
    this.token = { value: parsed.data.access_token, expiresAt: now + (parsed.data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** Documented read-only price check. Only runs when live quotes are enabled with a valid key. */
  async quote(input: QuoteInput): Promise<QuoteResult> {
    if (!this.cfg.liveQuotes) throw new AgentError("INTEGRATION_UNAVAILABLE", "Live price checks are off; using simulated information.");
    const json = await this.call("POST", "/api/tasks/quote", input, await this.bearer());
    const parsed = quoteResponse.safeParse(json);
    if (!parsed.success) throw new AgentError("INTEGRATION_UNAVAILABLE", "GetterDone sent a price Sahaya couldn't read.", { operation: "quote" });
    const d = parsed.data.data;
    const cents = (n: number) => Math.round(n * 100);
    return { rewardCents: cents(d.reward), platformFeeCents: cents(d.platformFee), totalCents: cents(d.total), currency: d.currency, fundingReady: d.tokenStatus ? d.tokenStatus === "ready" : null };
  }

  /**
   * Live task creation (GetterDone's equivalent of a booking). Hard-disabled in this build — even with
   * GETTERDONE_DEMO_MODE=false — because it secures the owner's card and makes the request visible to workers.
   */
  async createTask(_input: QuoteInput): Promise<never> {
    void _input;
    throw new DemoModeBlocked("POST /api/tasks", "Live GetterDone bookings aren't enabled in this version of Sahaya. Nothing was sent.");
  }

  /** Generic entry point used by tests to prove any other documented operation is refused before the network. */
  async request(method: HttpMethod, path: string, body?: unknown): Promise<unknown> {
    return this.call(method, path, body);
  }
}
