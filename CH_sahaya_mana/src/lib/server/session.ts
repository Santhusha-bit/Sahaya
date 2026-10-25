import "server-only";
import { cookies } from "next/headers";
import { AgentError } from "@/agents/base/errors";
import type { AgentContext } from "@/agents/base/types";
import { getAuth0 } from "@/lib/auth0";
import { IDENTITY_MESSAGES, profileFor, resolveIdentity, type Identity, type Profile, type VerifiedSession } from "@/lib/auth/identity";

/**
 * Current request's identity (see src/lib/auth/identity.ts for the rules). Everything fails closed:
 * no verified identity → UNAUTHENTICATED, and nothing is read or written.
 */
export const PROFILE_COOKIE = "sahaya_profile";
/** Name used before the rename to Sahaya; still read so existing demo/real choices keep working (only selects a view). */
export const LEGACY_PROFILE_COOKIE = "kinline_profile";
export const LOCAL_USER = { id: "local-user" } as const;

export async function currentIdentity(): Promise<Identity> {
  let session: VerifiedSession | null = null;
  const auth0 = getAuth0();
  if (auth0) {
    try {
      const s = await auth0.getSession();
      session = s ? { sub: s.user?.sub, idToken: s.tokenSet?.idToken } : null;
    } catch {
      session = null; // unreadable/tampered cookie = signed out
    }
  }
  return resolveIdentity({ env: process.env, session, nowSec: Math.floor(Date.now() / 1000) });
}

export interface RequestAuth {
  identity: Exclude<Identity, { kind: "none" }>;
  profile: Profile;
  userId: string;
}

/** Identity + data profile, or UNAUTHENTICATED. */
export async function resolveRequest(): Promise<RequestAuth> {
  const identity = await currentIdentity();
  if (identity.kind === "none") throw new AgentError("UNAUTHENTICATED", IDENTITY_MESSAGES[identity.reason], { reason: identity.reason });
  let cookie: string | undefined;
  try {
    const jar = await cookies();
    cookie = jar.get(PROFILE_COOKIE)?.value ?? jar.get(LEGACY_PROFILE_COOKIE)?.value;
  } catch {
    cookie = undefined;
  }
  const p = profileFor(identity, cookie, process.env)!;
  return { identity, profile: p.profile, userId: p.userId };
}

export async function sessionProfile(): Promise<{ profile: Profile; userId: string; identityKind: "user" | "local" }> {
  const r = await resolveRequest();
  return { profile: r.profile, userId: r.userId, identityKind: r.identity.kind };
}

export async function getSessionContext(): Promise<AgentContext> {
  const { userId } = await resolveRequest();
  return { userId, actor: { id: userId, role: "older_adult" } };
}
