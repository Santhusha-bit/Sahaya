/**
 * CRS Credit API adapter (sandbox only).
 *
 * Live mode talks to the CRS sandbox (`https://api-sandbox.stitchcredit.com/api`)
 * with a JWT from `POST /users/login`. Three products are used, all documented in
 * the CRS Cal Hacks sandbox spec:
 *
 *   - credit_report          POST /transunion/credit-report/standard/{config}
 *                            (CRS Standard Format: scores, tradelines, inquiries)
 *   - identity_verification  POST /transunion/identity-manager-verification/basic
 *                            (TransUnion TruValidate identity match + risk)
 *   - fraud_finder           POST /fraud-finder/{config}
 *                            (AtData FraudFinder email/phone/IP/postal risk)
 *
 * CRS does NOT provide bank transaction monitoring through these endpoints, and
 * nothing here claims it does.
 *
 * Safety rules enforced in code:
 *   - The base URL must be the CRS sandbox host. Production is refused (CRS's own
 *     rule: "no testing is permitted in the production environment").
 *   - Only CRS test identities reach this adapter (see testIdentities.ts); request
 *     bodies are redacted (SSN masked) before they are returned for logging.
 *
 * Without credentials the adapter runs in sandbox mode: it returns an offline
 * fixture whose shape mirrors a recorded CRS sandbox response for persona P13,
 * labeled `mode: "sandbox"`. No network call is made and nothing is labeled live.
 */

import { createHash } from "node:crypto";
import { CRS_FIXTURES } from "./crsFixtures";

export const CRS_SANDBOX_BASE = "https://api-sandbox.stitchcredit.com/api";
const SANDBOX_HOST = "api-sandbox.stitchcredit.com";

export type CrsProduct = "credit_report" | "identity_verification" | "fraud_finder";
export const CRS_PRODUCTS: CrsProduct[] = ["credit_report", "identity_verification", "fraud_finder"];

/** The person fields a CRS request is built from (always a CRS test identity). */
export interface CrsSubject {
  personaId: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  ssn: string;
  birthDate?: string;
  email?: string;
  phoneNumber?: string;
  address: { addressLine1: string; city: string; state: string; postalCode: string };
}

export interface CrsCallResult {
  product: CrsProduct;
  mode: "live" | "sandbox";
  method: "POST";
  /** Path relative to the base URL, e.g. /transunion/credit-report/standard/tu-prequal-fico9 */
  endpoint: string;
  /** Request body with the SSN masked, safe to log and display. */
  requestBody: Record<string, unknown>;
  status: number;
  /** CRS `RequestID` response header (the stored report id). */
  requestId?: string;
  latencyMs: number;
  /** Raw response body as returned by CRS (or the fixture in sandbox mode). */
  response: Record<string, unknown>;
  /** sha256 of the raw response JSON, recorded in the audit trail. */
  responseSha256: string;
  /** CRS in-body error messages (CRS returns HTTP 200 with errorMessages on some failures). */
  errorMessages: string[];
}

export class CrsError extends Error {
  constructor(
    message: string,
    readonly code: "not_configured" | "production_refused" | "auth_failed" | "rate_limited" | "http_error" | "no_fixture" | "network",
    readonly status?: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "CrsError";
  }
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function crsCredentials(): { username: string; password: string } | null {
  const username = env("CRS_USERNAME") ?? env("CRS_USER");
  const password = env("CRS_PASSWORD") ?? env("CRS_PASS");
  return username && password ? { username, password } : null;
}

export function crsConfig() {
  return {
    baseUrl: (env("CRS_BASE_URL") ?? CRS_SANDBOX_BASE).replace(/\/+$/, ""),
    tuConfig: env("CRS_TU_CONFIG") ?? "tu-prequal-fico9",
    fraudConfig: env("CRS_FRAUD_CONFIG") ?? "fraud-finder",
    timeoutMs: Number(env("CRS_TIMEOUT_MS") ?? 20000),
  };
}

/** Refuse anything that is not the CRS sandbox host. */
export function assertSandboxBaseUrl(baseUrl: string): void {
  let host = "";
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new CrsError(`Invalid CRS base URL: ${baseUrl}`, "production_refused");
  }
  if (host !== SANDBOX_HOST) {
    throw new CrsError(`Refusing to call ${host}: Sahaya only uses the CRS sandbox (${SANDBOX_HOST}).`, "production_refused");
  }
}

export function maskSsn(ssn: string): string {
  const digits = ssn.replace(/\D/g, "");
  return digits.length >= 4 ? `***-**-${digits.slice(-4)}` : "***";
}

/** Recursively mask any `ssn`/`number`-style 9-digit SSN values for logging. */
export function redactForLog<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactForLog(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && /^\d{3}-?\d{2}-?\d{4}$/.test(v)) out[k] = maskSsn(v);
      else out[k] = redactForLog(v);
    }
    return out as T;
  }
  return value;
}

/** Build the documented request body for each product. */
export function buildRequest(product: CrsProduct, s: CrsSubject, cfg = crsConfig()): { endpoint: string; body: Record<string, unknown> } {
  switch (product) {
    case "credit_report":
      return {
        endpoint: `/transunion/credit-report/standard/${cfg.tuConfig}`,
        body: {
          firstName: s.firstName,
          ...(s.middleName ? { middleName: s.middleName } : {}),
          lastName: s.lastName,
          ssn: s.ssn,
          ...(s.birthDate ? { birthDate: s.birthDate } : {}),
          addresses: [{ ...s.address, borrowerResidencyType: "Current" }],
        },
      };
    case "identity_verification":
      return {
        endpoint: "/transunion/identity-manager-verification/basic",
        body: {
          firstName: s.firstName,
          ...(s.middleName ? { middleName: s.middleName } : {}),
          lastName: s.lastName,
          street1: s.address.addressLine1,
          city: s.address.city,
          state: s.address.state,
          zip: s.address.postalCode,
          ssn: s.ssn,
          ...(s.birthDate ? { dob: s.birthDate } : {}),
          ...(s.phoneNumber ? { phone: s.phoneNumber } : {}),
        },
      };
    case "fraud_finder":
      return {
        endpoint: `/fraud-finder/${cfg.fraudConfig}`,
        body: {
          email: s.email,
          firstName: s.firstName,
          lastName: s.lastName,
          ...(s.phoneNumber ? { phoneNumber: s.phoneNumber } : {}),
          address: { ...s.address },
        },
      };
  }
}

function sha256(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function extractErrors(body: Record<string, unknown>): string[] {
  const raw = body.errorMessages;
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).slice(0, 10);
}

export interface CrsClient {
  readonly mode: "live" | "sandbox";
  call(product: CrsProduct, subject: CrsSubject): Promise<CrsCallResult>;
}

/** Live client: JWT login, token cached in-process, one re-login on 401. */
export class LiveCrsClient implements CrsClient {
  readonly mode = "live" as const;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly creds: { username: string; password: string },
    private readonly cfg = crsConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    assertSandboxBaseUrl(cfg.baseUrl);
  }

  private async login(): Promise<string> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: this.creds.username, password: this.creds.password }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) throw new CrsError(`CRS login failed (HTTP ${res.status}).`, "auth_failed", res.status);
    const body = (await res.json()) as { token?: string; expires?: number };
    if (!body.token) throw new CrsError("CRS login returned no token.", "auth_failed", res.status);
    this.token = body.token;
    // `expires` units are not documented; accept epoch ms or seconds, default 10 min.
    const exp = Number(body.expires ?? 0);
    this.tokenExpiresAt = exp > 1e12 ? exp : exp > 1e9 ? exp * 1000 : Date.now() + 10 * 60_000;
    return this.token;
  }

  private async bearer(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt - 30_000) return this.token;
    return this.login();
  }

  async call(product: CrsProduct, subject: CrsSubject): Promise<CrsCallResult> {
    const { endpoint, body } = buildRequest(product, subject, this.cfg);
    const started = Date.now();
    const send = async (token: string) =>
      this.fetchImpl(`${this.cfg.baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          // FraudFinder caches identical requests; ask for a fresh evaluation.
          "Cache-Control": "no-cache",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });

    let res: Response;
    try {
      res = await send(await this.bearer());
      if (res.status === 401) res = await send(await this.bearer(true));
    } catch (err) {
      if (err instanceof CrsError) throw err;
      throw new CrsError(`CRS request failed: ${(err as Error).message}`, "network");
    }

    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? 0) || undefined;
      throw new CrsError("CRS sandbox rate limit reached (CRS962).", "rate_limited", 429, retry);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    if (!res.ok) throw new CrsError(`CRS ${product} returned HTTP ${res.status}.`, "http_error", res.status);

    return {
      product,
      mode: "live",
      method: "POST",
      endpoint,
      requestBody: redactForLog(body),
      status: res.status,
      requestId: res.headers.get("requestid") ?? undefined,
      latencyMs: Date.now() - started,
      response: json,
      responseSha256: sha256(json),
      errorMessages: extractErrors(json),
    };
  }
}

/** Offline client: returns recorded-shape fixtures; never touches the network. */
export class SandboxCrsClient implements CrsClient {
  readonly mode = "sandbox" as const;
  constructor(private readonly cfg = crsConfig()) {}

  async call(product: CrsProduct, subject: CrsSubject): Promise<CrsCallResult> {
    const { endpoint, body } = buildRequest(product, subject, this.cfg);
    const fixture = CRS_FIXTURES[subject.personaId]?.[product];
    if (!fixture) {
      throw new CrsError(
        `No offline fixture for ${subject.personaId} ${product}. Set CRS_USERNAME/CRS_PASSWORD to call the CRS sandbox.`,
        "no_fixture",
      );
    }
    const response = structuredClone(fixture);
    return {
      product,
      mode: "sandbox",
      method: "POST",
      endpoint,
      requestBody: redactForLog(body),
      status: 200,
      requestId: `offline-${subject.personaId.toLowerCase()}-${product}`,
      latencyMs: 0,
      response,
      responseSha256: sha256(response),
      errorMessages: extractErrors(response),
    };
  }
}

export function createCrsClient(): CrsClient {
  const creds = crsCredentials();
  return creds ? new LiveCrsClient(creds) : new SandboxCrsClient();
}
