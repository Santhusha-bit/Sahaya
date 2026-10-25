/**
 * Coinbase x402: HTTP-native machine-to-machine payments (protocol layer).
 *
 * x402 revives HTTP 402 Payment Required. A paid resource answers an unpaid
 * request with `402` and a JSON body listing PaymentRequirements; the client
 * signs a payment for one of them and retries with an `X-PAYMENT` header; the
 * server verifies + settles through a facilitator and returns the resource with
 * an `X-PAYMENT-RESPONSE` header. We implement the v1 wire format and the
 * "exact" scheme on EVM: an EIP-3009 `transferWithAuthorization` for USDC,
 * signed as EIP-712 typed data (the payer never sends a transaction itself).
 *
 * Honest live/sandbox (acceptance criterion 12):
 *  - LIVE (testnet): X402_WALLET_PRIVATE_KEY (a funded Base Sepolia test wallet)
 *    + X402_PAY_TO. Care signs with the test wallet and the service verifies and
 *    settles through the x402 facilitator (X402_FACILITATOR_URL, default
 *    https://x402.org/facilitator), moving real TESTNET USDC.
 *  - SANDBOX: an ephemeral throwaway key signs the same EIP-712 authorization and
 *    a local verifier checks it cryptographically (signature, payee, amount, time
 *    window, single-use nonce). Nothing settles and no funds move.
 *
 * Only test networks are ever paid on: the Care policy refuses mainnet outright.
 */

import { randomBytes } from "node:crypto";
import { getAddress, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const X402_VERSION = 1;
export const PAYMENT_HEADER = "X-PAYMENT";
export const PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

/** USDC has 6 decimals on every supported network. */
export const USDC_DECIMALS = 6;

export interface X402Network {
  chainId: number;
  /** USDC contract (the EIP-3009 token and EIP-712 verifyingContract). */
  usdc: Hex;
  /** EIP-712 domain name/version of that USDC deployment. */
  usdcName: string;
  usdcVersion: string;
  testnet: boolean;
}

export const X402_NETWORKS: Record<string, X402Network> = {
  "base-sepolia": {
    chainId: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcName: "USDC",
    usdcVersion: "2",
    testnet: true,
  },
  // Listed so a mainnet requirement is recognized and REFUSED by policy, not
  // mistaken for an unknown network.
  base: {
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcName: "USD Coin",
    usdcVersion: "2",
    testnet: false,
  },
};

export const TEST_NETWORK = "base-sepolia";

/** One way to pay for a resource, as advertised in a 402 response. */
export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  /** Atomic token units (USDC: 1 = $0.000001). */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Hex;
  maxTimeoutSeconds: number;
  asset: Hex;
  extra?: { name?: string; version?: string; [k: string]: unknown };
}

export interface PaymentRequiredBody {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
}

export interface ExactEvmAuthorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: { signature: Hex; authorization: ExactEvmAuthorization };
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

// ---------------------------------------------------------------------------
// Amounts and header encoding
// ---------------------------------------------------------------------------

export function usdToAtomic(usd: number): bigint {
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
}

export function atomicToUsd(atomic: bigint | string): number {
  return Number(BigInt(atomic)) / 10 ** USDC_DECIMALS;
}

export function formatUsd(usd: number): string {
  // Cents for normal prices; a third decimal only for sub-cent amounts.
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 3 : 2)}`;
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader<T>(header: string): T {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
}

/** Parse and minimally shape-check a 402 body. Returns null if it isn't x402. */
export function parsePaymentRequired(body: unknown): PaymentRequiredBody | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Partial<PaymentRequiredBody>;
  if (typeof b.x402Version !== "number" || !Array.isArray(b.accepts)) return null;
  const accepts = b.accepts.filter(
    (r): r is PaymentRequirements =>
      !!r &&
      typeof r === "object" &&
      typeof r.scheme === "string" &&
      typeof r.network === "string" &&
      typeof r.maxAmountRequired === "string" &&
      /^\d+$/.test(r.maxAmountRequired) &&
      typeof r.resource === "string" &&
      typeof r.payTo === "string" &&
      typeof r.asset === "string",
  );
  return { x402Version: b.x402Version, error: b.error, accepts };
}

// ---------------------------------------------------------------------------
// EIP-712 typed data for EIP-3009 transferWithAuthorization
// ---------------------------------------------------------------------------

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function domainFor(req: PaymentRequirements) {
  const net = X402_NETWORKS[req.network];
  if (!net) throw new Error(`Unsupported x402 network "${req.network}"`);
  return {
    name: req.extra?.name ?? net.usdcName,
    version: req.extra?.version ?? net.usdcVersion,
    chainId: net.chainId,
    verifyingContract: getAddress(req.asset),
  };
}

function messageFor(a: ExactEvmAuthorization) {
  return {
    from: getAddress(a.from),
    to: getAddress(a.to),
    value: BigInt(a.value),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    nonce: a.nonce,
  };
}

// ---------------------------------------------------------------------------
// Wallet (buyer side)
// ---------------------------------------------------------------------------

export interface X402Wallet {
  readonly address: Hex;
  /** "testnet-wallet" = funded key from env; "ephemeral" = throwaway sandbox key. */
  readonly backend: "testnet-wallet" | "ephemeral";
  signExact(req: PaymentRequirements, nowSeconds?: number): Promise<PaymentPayload>;
}

export function createWallet(privateKey: Hex, backend: X402Wallet["backend"]): X402Wallet {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    backend,
    async signExact(req, nowSeconds = Math.floor(Date.now() / 1000)) {
      const authorization: ExactEvmAuthorization = {
        from: account.address,
        to: getAddress(req.payTo),
        value: req.maxAmountRequired,
        // Small backdate tolerates clock skew (same as the reference client).
        validAfter: String(nowSeconds - 600),
        validBefore: String(nowSeconds + req.maxTimeoutSeconds),
        nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
      };
      const signature = await account.signTypedData({
        domain: domainFor(req),
        types: AUTH_TYPES,
        primaryType: "TransferWithAuthorization",
        message: messageFor(authorization),
      });
      return { x402Version: X402_VERSION, scheme: "exact", network: req.network, payload: { signature, authorization } };
    },
  };
}

const WALLET_KEY = "__sahaya_x402_wallet__";

/** Live testnet wallet when configured, otherwise a process-wide ephemeral key. */
export function getX402Wallet(): X402Wallet {
  const g = globalThis as Record<string, unknown>;
  if (g[WALLET_KEY]) return g[WALLET_KEY] as X402Wallet;
  const pk = process.env.X402_WALLET_PRIVATE_KEY?.trim();
  const wallet =
    pk && /^0x[0-9a-fA-F]{64}$/.test(pk)
      ? createWallet(pk as Hex, "testnet-wallet")
      : createWallet(generatePrivateKey(), "ephemeral");
  g[WALLET_KEY] = wallet;
  return wallet;
}

export function setX402Wallet(w: X402Wallet | null): void {
  const g = globalThis as Record<string, unknown>;
  if (w) g[WALLET_KEY] = w;
  else delete g[WALLET_KEY];
}

// ---------------------------------------------------------------------------
// Facilitator (seller side)
// ---------------------------------------------------------------------------

export interface Facilitator {
  /** "x402-facilitator" = remote HTTP facilitator; "local-verifier" = sandbox. */
  readonly backend: "x402-facilitator" | "local-verifier";
  verify(payment: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse>;
  settle(payment: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse>;
}

/** Remote facilitator over HTTP (x402.org or Coinbase CDP). Settles on-chain. */
export class HttpFacilitator implements Facilitator {
  readonly backend = "x402-facilitator" as const;
  constructor(private readonly baseUrl: string = DEFAULT_FACILITATOR_URL) {}

  private async post<T>(path: string, payment: PaymentPayload, req: PaymentRequirements): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x402Version: payment.x402Version, paymentPayload: payment, paymentRequirements: req }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`facilitator ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok && !(json && typeof json === "object" && ("isValid" in json || "success" in json))) {
      throw new Error(`facilitator ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    }
    return json as T;
  }

  verify(payment: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    return this.post<VerifyResponse>("/verify", payment, req);
  }
  settle(payment: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    return this.post<SettleResponse>("/settle", payment, req);
  }
}

/**
 * Sandbox facilitator. Performs the same checks a real facilitator does before
 * settlement (EIP-712 signature recovers to `from`, payee, exact amount, asset,
 * time window, single-use nonce) but never touches a chain. The "transaction" it
 * returns is clearly labeled `sandbox:` so it can't be mistaken for a tx hash.
 */
export class LocalVerifierFacilitator implements Facilitator {
  readonly backend = "local-verifier" as const;
  private readonly usedNonces = new Set<string>();

  async verify(payment: PaymentPayload, req: PaymentRequirements, nowSeconds = Math.floor(Date.now() / 1000)): Promise<VerifyResponse> {
    const a = payment?.payload?.authorization;
    if (!a || !payment.payload.signature) return { isValid: false, invalidReason: "invalid_payload" };
    if (payment.scheme !== req.scheme || payment.network !== req.network) {
      return { isValid: false, invalidReason: "scheme_or_network_mismatch", payer: a.from };
    }
    const net = X402_NETWORKS[req.network];
    if (!net || getAddress(req.asset) !== getAddress(net.usdc)) {
      return { isValid: false, invalidReason: "unsupported_asset", payer: a.from };
    }
    if (getAddress(a.to) !== getAddress(req.payTo)) return { isValid: false, invalidReason: "wrong_recipient", payer: a.from };
    if (BigInt(a.value) !== BigInt(req.maxAmountRequired)) return { isValid: false, invalidReason: "wrong_amount", payer: a.from };
    if (BigInt(a.validAfter) > BigInt(nowSeconds)) return { isValid: false, invalidReason: "not_yet_valid", payer: a.from };
    if (BigInt(a.validBefore) <= BigInt(nowSeconds)) return { isValid: false, invalidReason: "expired", payer: a.from };
    if (this.usedNonces.has(a.nonce.toLowerCase())) return { isValid: false, invalidReason: "nonce_already_used", payer: a.from };
    let ok = false;
    try {
      ok = await verifyTypedData({
        address: getAddress(a.from),
        domain: domainFor(req),
        types: AUTH_TYPES,
        primaryType: "TransferWithAuthorization",
        message: messageFor(a),
        signature: payment.payload.signature,
      });
    } catch {
      ok = false;
    }
    return ok ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: "invalid_signature", payer: a.from };
  }

  async settle(payment: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const check = await this.verify(payment, req);
    if (!check.isValid) {
      return { success: false, transaction: "", network: req.network, payer: check.payer, errorReason: check.invalidReason };
    }
    const nonce = payment.payload.authorization.nonce.toLowerCase();
    this.usedNonces.add(nonce);
    return { success: true, transaction: `sandbox:${nonce.slice(2, 18)}`, network: req.network, payer: check.payer };
  }
}

const FACILITATOR_KEY = "__sahaya_x402_facilitator__";

export function getFacilitator(): Facilitator {
  const g = globalThis as Record<string, unknown>;
  if (g[FACILITATOR_KEY]) return g[FACILITATOR_KEY] as Facilitator;
  const f: Facilitator = x402Live()
    ? new HttpFacilitator(process.env.X402_FACILITATOR_URL?.trim() || DEFAULT_FACILITATOR_URL)
    : new LocalVerifierFacilitator();
  g[FACILITATOR_KEY] = f;
  return f;
}

export function setFacilitator(f: Facilitator | null): void {
  const g = globalThis as Record<string, unknown>;
  if (f) g[FACILITATOR_KEY] = f;
  else delete g[FACILITATOR_KEY];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Placeholder payee used in sandbox. No key exists for it; nothing is ever sent. */
export const SANDBOX_PAY_TO: Hex = "0x5a11db0000000000000000000000000000000402";

export function x402Live(): boolean {
  const pk = process.env.X402_WALLET_PRIVATE_KEY?.trim() ?? "";
  const payTo = process.env.X402_PAY_TO?.trim() ?? "";
  return /^0x[0-9a-fA-F]{64}$/.test(pk) && /^0x[0-9a-fA-F]{40}$/.test(payTo);
}

/** Address the product-data service is paid at (seller config). */
export function servicePayTo(): Hex {
  const payTo = process.env.X402_PAY_TO?.trim();
  return getAddress(payTo && /^0x[0-9a-fA-F]{40}$/.test(payTo) ? payTo : SANDBOX_PAY_TO);
}
