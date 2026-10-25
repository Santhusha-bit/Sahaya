import { id } from "@/lib/id";

/**
 * Short-lived, in-process holding area for an uploaded pantry photo.
 *
 * The upload route stashes the bytes and hands the scanPantryPhoto tool an opaque
 * imageId, so the base64 image never lands in tool-call records, conversation
 * history or the audit log, and the chat model cannot fabricate a scan (it has
 * no way to produce a valid id). Images are single-use, expire after a few
 * minutes, and are never written to persistent storage (data minimization).
 */

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 8;
/** Raw-bytes cap (base64 is ~4/3 larger). Keeps us under serverless body limits. */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

interface StashedImage {
  userId: string;
  base64: string;
  mimeType: string;
  at: number;
}

const GLOBAL_KEY = "__kinline_pantry_images__";

function store(): Map<string, StashedImage> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map<string, StashedImage>();
  return g[GLOBAL_KEY] as Map<string, StashedImage>;
}

function prune(map: Map<string, StashedImage>): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of map) if (v.at < cutoff) map.delete(k);
  while (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value as string);
}

export function stashPantryImage(userId: string, base64: string, mimeType: string): string {
  const map = store();
  prune(map);
  const imageId = id("img");
  map.set(imageId, { userId, base64, mimeType, at: Date.now() });
  return imageId;
}

/** Single-use: the image is removed as soon as it is taken. Scoped to the owner. */
export function takePantryImage(userId: string, imageId: string): { base64: string; mimeType: string } | null {
  const map = store();
  const entry = map.get(imageId);
  if (!entry || entry.userId !== userId || entry.at < Date.now() - TTL_MS) return null;
  map.delete(imageId);
  return { base64: entry.base64, mimeType: entry.mimeType };
}
