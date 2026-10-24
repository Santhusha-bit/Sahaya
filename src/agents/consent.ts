import { id, now } from "@/lib/id";
import { DEFAULT_CONSENT, type ConsentSettings } from "./base/policy";
import type { DataLayer } from "./base/types";

const COLLECTION = "consent";

/** Consent lives in shared memory, read/written at the app level (not via a scoped agent). */
export async function getConsent(data: DataLayer, userId: string): Promise<ConsentSettings> {
  const rows = await data.memory.list({ namespace: "shared", userId, collection: COLLECTION, limit: 1 });
  const stored = rows[0]?.data as ConsentSettings | undefined;
  return { ...DEFAULT_CONSENT, ...(stored ?? {}) };
}

export async function setConsent(data: DataLayer, userId: string, patch: ConsentSettings): Promise<ConsentSettings> {
  const current = await getConsent(data, userId);
  const next = { ...current, ...patch };
  const rows = await data.memory.list({ namespace: "shared", userId, collection: COLLECTION, limit: 1 });
  if (rows[0]) {
    await data.memory.patch(rows[0].id, next);
  } else {
    await data.memory.put({
      id: id("mem"),
      namespace: "shared",
      collection: COLLECTION,
      userId,
      data: next,
      createdAt: now(),
      updatedAt: now(),
    });
  }
  return next;
}
