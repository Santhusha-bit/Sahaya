import type { FetchLike } from "./types";

export const USER_AGENT =
  "GroceryProductDiscovery/1.0 (Apify Actor; +https://apify.com/store; contact via Apify Console)";

export interface JsonRequest {
  url: string;
  init?: RequestInit;
  timeoutMs?: number;
  retries?: number;
}

/** Retryable statuses: rate limiting and transient upstream failures. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * GET/POST JSON with a timeout, polite User-Agent and exponential backoff on
 * 429/5xx. Throws on a final non-2xx so callers can record a per-item error
 * instead of silently returning nothing.
 */
export async function fetchJson<T>(fetchImpl: FetchLike, req: JsonRequest): Promise<T> {
  const retries = req.retries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 20_000);
    try {
      const res = await fetchImpl(req.url, {
        ...req.init,
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(req.init?.headers ?? {}) },
      });
      if (res.ok) return (await res.json()) as T;
      lastError = new Error(`HTTP ${res.status} from ${new URL(req.url).host}`);
      if (!RETRYABLE.has(res.status)) break;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 500 * 2 ** attempt);
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run async work over items with a fixed concurrency limit, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
