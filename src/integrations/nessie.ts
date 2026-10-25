/**
 * Capital One Nessie (https://api.nessieisreal.com): the hackathon sandbox
 * banking API. Finance uses it for realistic bank-account and transaction data.
 *
 * Two backends behind one interface:
 *  - live:    real Nessie REST calls when NESSIE_API_KEY is set.
 *  - sandbox: an in-process emulator that mirrors the Nessie request/response
 *             shapes (24-hex `_id`s, `{ code, message, objectCreated }` on POST),
 *             so the full flow runs offline and in tests.
 *
 * Nessie only ever holds fake money, but Finance still treats it like a real
 * bank: it reads purchases only from an account the person authorized (see
 * src/agents/finance/nessie/service.ts) and never creates purchases itself.
 */

import { nessieStatus } from "@/lib/env";

export interface NessieAddress {
  street_number: string;
  street_name: string;
  city: string;
  state: string;
  zip: string;
}

export interface NessieCustomer {
  _id: string;
  first_name: string;
  last_name: string;
  address: NessieAddress;
}

export type NessieAccountType = "Checking" | "Savings" | "Credit Card";

export interface NessieAccount {
  _id: string;
  type: NessieAccountType;
  nickname: string;
  rewards: number;
  balance: number;
  account_number?: string;
  customer_id: string;
}

export interface NessieMerchant {
  _id: string;
  name: string;
  /** Nessie returns category as a string array; POST accepts a string. */
  category: string[] | string;
  address?: NessieAddress;
  geocode?: { lat: number; lng: number };
}

export type NessiePurchaseStatus = "pending" | "cancelled" | "completed";

export interface NessiePurchase {
  _id: string;
  type: "merchant";
  merchant_id: string;
  payer_id: string;
  purchase_date: string;
  amount: number;
  status: NessiePurchaseStatus;
  medium: "balance" | "rewards";
  description?: string;
}

export interface NewPurchase {
  merchant_id: string;
  medium: "balance";
  purchase_date: string;
  amount: number;
  status?: NessiePurchaseStatus;
  description?: string;
}

export interface NessieClient {
  readonly backend: "live" | "sandbox";
  createCustomer(input: Omit<NessieCustomer, "_id">): Promise<NessieCustomer>;
  createAccount(customerId: string, input: Omit<NessieAccount, "_id" | "customer_id">): Promise<NessieAccount>;
  getAccount(accountId: string): Promise<NessieAccount | null>;
  createMerchant(input: { name: string; category: string; address: NessieAddress; geocode: { lat: number; lng: number } }): Promise<NessieMerchant>;
  getMerchant(merchantId: string): Promise<NessieMerchant | null>;
  createPurchase(accountId: string, input: NewPurchase): Promise<NessiePurchase>;
  listPurchases(accountId: string): Promise<NessiePurchase[]>;
}

export class NessieError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "NessieError";
  }
}

/* ------------------------------------------------------------------ live -- */

const DEFAULT_BASE = "https://api.nessieisreal.com";

export function createLiveNessieClient(apiKey: string, baseUrl = process.env.NESSIE_BASE_URL?.trim() || DEFAULT_BASE): NessieClient {
  const url = (path: string) => `${baseUrl.replace(/\/$/, "")}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`;

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(url(path), {
      method,
      headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Nessie answers some auth failures with plain text ("Invalid API key.").
    }
    if (!res.ok) {
      const msg = (json as { message?: string } | undefined)?.message ?? text.slice(0, 200) ?? res.statusText;
      throw new NessieError(`Nessie ${method} ${path} failed (${res.status}): ${msg}`, res.status);
    }
    if (json === undefined) throw new NessieError(`Nessie ${method} ${path} returned non-JSON: ${text.slice(0, 120)}`, res.status);
    return json as T;
  }

  /** POSTs answer `{ code, message, objectCreated }`. */
  async function create<T>(path: string, body: unknown): Promise<T> {
    const out = await request<{ objectCreated?: T; code?: number; message?: string }>("POST", path, body);
    if (!out.objectCreated) throw new NessieError(`Nessie POST ${path}: ${out.message ?? "no object created"}`, out.code);
    return out.objectCreated;
  }

  async function getOrNull<T>(path: string): Promise<T | null> {
    try {
      return await request<T>("GET", path);
    } catch (err) {
      if (err instanceof NessieError && err.status === 404) return null;
      throw err;
    }
  }

  return {
    backend: "live",
    createCustomer: (input) => create("/customers", input),
    createAccount: (customerId, input) => create(`/customers/${customerId}/accounts`, input),
    getAccount: (accountId) => getOrNull(`/accounts/${accountId}`),
    createMerchant: (input) => create("/merchants", input),
    getMerchant: (merchantId) => getOrNull(`/merchants/${merchantId}`),
    createPurchase: (accountId, input) => create(`/accounts/${accountId}/purchases`, input),
    listPurchases: (accountId) => request("GET", `/accounts/${accountId}/purchases`),
  };
}

/* --------------------------------------------------------------- sandbox -- */

interface SandboxState {
  customers: Map<string, NessieCustomer>;
  accounts: Map<string, NessieAccount>;
  merchants: Map<string, NessieMerchant>;
  purchases: Map<string, NessiePurchase>;
}

const HEX = "0123456789abcdef";
function objectId(): string {
  let out = "";
  for (let i = 0; i < 24; i++) out += HEX[Math.floor(Math.random() * 16)];
  return out;
}

/** Fresh emulator state (tests use this for isolation). */
export function createSandboxNessieClient(state: SandboxState = emptyState()): NessieClient {
  const need = <T>(v: T | undefined, what: string): T => {
    if (!v) throw new NessieError(`${what} not found`, 404);
    return v;
  };
  return {
    backend: "sandbox",
    async createCustomer(input) {
      const c = { _id: objectId(), ...structuredClone(input) };
      state.customers.set(c._id, c);
      return structuredClone(c);
    },
    async createAccount(customerId, input) {
      need(state.customers.get(customerId), "Customer");
      const a: NessieAccount = { _id: objectId(), customer_id: customerId, ...structuredClone(input) };
      state.accounts.set(a._id, a);
      return structuredClone(a);
    },
    async getAccount(accountId) {
      const a = state.accounts.get(accountId);
      return a ? structuredClone(a) : null;
    },
    async createMerchant(input) {
      const m: NessieMerchant = { _id: objectId(), ...structuredClone(input), category: [input.category] };
      state.merchants.set(m._id, m);
      return structuredClone(m);
    },
    async getMerchant(merchantId) {
      const m = state.merchants.get(merchantId);
      return m ? structuredClone(m) : null;
    },
    async createPurchase(accountId, input) {
      const account = need(state.accounts.get(accountId), "Account");
      need(state.merchants.get(input.merchant_id), "Merchant");
      if (!(input.amount > 0)) throw new NessieError("amount must be positive", 400);
      const p: NessiePurchase = {
        _id: objectId(),
        type: "merchant",
        payer_id: accountId,
        merchant_id: input.merchant_id,
        purchase_date: input.purchase_date,
        amount: input.amount,
        status: input.status ?? "pending",
        medium: input.medium,
        description: input.description,
      };
      state.purchases.set(p._id, p);
      account.balance = Number((account.balance - input.amount).toFixed(2));
      return structuredClone(p);
    },
    async listPurchases(accountId) {
      need(state.accounts.get(accountId), "Account");
      return [...state.purchases.values()].filter((p) => p.payer_id === accountId).map((p) => structuredClone(p));
    },
  };
}

function emptyState(): SandboxState {
  return { customers: new Map(), accounts: new Map(), merchants: new Map(), purchases: new Map() };
}

/* ----------------------------------------------------------------- pick -- */

const GLOBAL_KEY = "__sahaya_nessie_sandbox__";

/**
 * Process-wide client: live Nessie when NESSIE_API_KEY is set, otherwise one
 * shared sandbox emulator (shared via a global so the API routes and agent
 * tools within one dev server see the same fake bank).
 */
export function getNessieClient(): NessieClient {
  const key = process.env.NESSIE_API_KEY?.trim();
  if (nessieStatus().mode === "live" && key) return createLiveNessieClient(key);
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = emptyState();
  return createSandboxNessieClient(g[GLOBAL_KEY] as SandboxState);
}
