import { AgentError } from "@/agents/base/errors";
import type { AuthEnv, Identity } from "@/lib/auth/identity";
import { appEnv } from "@/lib/config/env";

/**
 * Where a request's data may live. Pure, so the rules are tested directly:
 *  - Signed-in people → Convex only (SAHAYA_STORAGE=convex + NEXT_PUBLIC_CONVEX_URL). Otherwise 503.
 *    Never the local file, even in development.
 *  - Explicit non-sensitive local mode (development only) → the local FileStore (or memory).
 *  - Production never uses the local file. No identity → nothing is read or written.
 */
export type StorageDecision = { kind: "convex"; url: string; token: string } | { kind: "file" } | { kind: "memory" };

export function decideStorage(identity: Identity, env: AuthEnv): StorageDecision {
  if (identity.kind === "none") throw new AgentError("UNAUTHENTICATED", "Sign in to continue.");
  if (identity.kind === "local") {
    if (env.NODE_ENV === "production") throw new AgentError("STORAGE_UNAVAILABLE", "Local storage is never used in production.");
    return appEnv(env, "STORE") === "memory" ? { kind: "memory" } : { kind: "file" };
  }
  const url = env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (appEnv(env, "STORAGE") !== "convex" || !url) {
    throw new AgentError(
      "STORAGE_UNAVAILABLE",
      "You're signed in, but the secure database (Convex) isn't enabled on this server, so nothing can be saved. Personal information is never stored in local files.",
    );
  }
  if (!identity.idToken) throw new AgentError("UNAUTHENTICATED", "Please sign in again so Sahaya can reach your data securely.");
  return { kind: "convex", url, token: identity.idToken };
}
