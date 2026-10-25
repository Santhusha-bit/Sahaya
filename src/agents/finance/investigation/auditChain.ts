/**
 * Hash-chained case audit. Each event commits to the previous event's hash, so
 * editing, deleting or reordering any past entry breaks verification from that
 * point on. The chain is exported with the evidence packet so a third party can
 * re-verify it without trusting Kinline.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "../../base/workItems";
import type { CaseActor, ChainEvent } from "./types";

export const GENESIS = "0".repeat(64);

function eventHash(e: Omit<ChainEvent, "hash">): string {
  const body = canonicalize({ seq: e.seq, at: e.at, actor: e.actor, action: e.action, detail: e.detail, prevHash: e.prevHash });
  return createHash("sha256").update(body).digest("hex");
}

export function actorLabel(a: CaseActor): string {
  return `${a.kind}:${a.id}`;
}

export function appendEvent(
  chain: ChainEvent[],
  actor: CaseActor,
  action: string,
  detail: Record<string, unknown> = {},
  at = Date.now(),
): ChainEvent[] {
  const prev = chain[chain.length - 1];
  // JSON round-trip so the hashed detail is exactly what gets stored.
  const clean = JSON.parse(JSON.stringify(detail)) as Record<string, unknown>;
  const partial = { seq: chain.length, at, actor: actorLabel(actor), action, detail: clean, prevHash: prev?.hash ?? GENESIS };
  return [...chain, { ...partial, hash: eventHash(partial) }];
}

export function verifyChain(chain: ChainEvent[]): { ok: boolean; length: number; brokenAt?: number; reason?: string } {
  let prev = GENESIS;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    if (e.seq !== i) return { ok: false, length: chain.length, brokenAt: i, reason: "sequence gap" };
    if (e.prevHash !== prev) return { ok: false, length: chain.length, brokenAt: i, reason: "previous-hash mismatch" };
    if (eventHash(e) !== e.hash) return { ok: false, length: chain.length, brokenAt: i, reason: "event content changed" };
    prev = e.hash;
  }
  return { ok: true, length: chain.length };
}
