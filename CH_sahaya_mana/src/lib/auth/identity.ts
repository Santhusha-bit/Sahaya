/**
 * Who is making this request — pure logic, so every rule is unit-tested. The server wrapper
 * (src/lib/server/session.ts) feeds it the environment and the Auth0 SDK's verified session.
 *
 * Rules (fail closed):
 *  - Real users exist only through Auth0, and only when the owner has enabled it (SAHAYA_AUTH=auth0) with all
 *    four AUTH0_* settings. The app's user id is derived ONLY from the verified subject: `${iss}|${sub}` — the
 *    same string the Convex functions derive from ctx.auth — never from email, cookies, headers or request data.
 *  - An expired ID token (needed for the database) counts as signed out: the person signs in again.
 *  - The ONLY shortcut is explicit non-sensitive local mode: NODE_ENV=development AND SAHAYA_LOCAL_MODE=nonsensitive
 *    AND Auth0 not enabled. It is never available in production and is labelled in the UI.
 *  - SAHAYA_* settings also accept their deprecated KINLINE_* names (src/lib/config/env.ts).
 *  - The demo profile is a view chosen by a signed-in person or in local mode; it never authenticates anyone.
 */

import { appEnv } from "@/lib/config/env";

export type AuthEnv = Partial<Record<string, string | undefined>>;

export type AuthConfig =
  | { provider: "auth0"; domain: string; clientId: string; issuer: string }
  | { provider: "none"; reason: "not_enabled" | "incomplete" };

const AUTH0_VARS = ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET"] as const;

export function authConfig(env: AuthEnv): AuthConfig {
  if (appEnv(env, "AUTH") !== "auth0") return { provider: "none", reason: "not_enabled" };
  if (!AUTH0_VARS.every((k) => Boolean(env[k]?.trim()))) return { provider: "none", reason: "incomplete" };
  const domain = env.AUTH0_DOMAIN!.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return { provider: "auth0", domain, clientId: env.AUTH0_CLIENT_ID!.trim(), issuer: `https://${domain}/` };
}

export function localModeEnabled(env: AuthEnv): boolean {
  return env.NODE_ENV === "development" && appEnv(env, "LOCAL_MODE") === "nonsensitive" && authConfig(env).provider === "none";
}

/** What the Auth0 SDK gives us after it decrypted and checked its own session cookie. */
export interface VerifiedSession {
  sub?: unknown;
  idToken?: unknown;
}

export type Identity =
  | { kind: "user"; userId: string; subject: string; issuer: string; idToken: string | null }
  | { kind: "local"; userId: "local-user" }
  | { kind: "none"; reason: "auth_not_configured" | "signed_out" | "expired" | "invalid_session" };

/** Reads (not verifies) a JWT's payload. Signature/issuer/audience are verified by Auth0 at login and Convex per call. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function canonicalUserId(issuer: string, subject: string) {
  return `${issuer}|${subject}`;
}

export function resolveIdentity(input: { env: AuthEnv; session: VerifiedSession | null; nowSec: number }): Identity {
  const cfg = authConfig(input.env);
  if (cfg.provider === "auth0") {
    const s = input.session;
    if (!s) return { kind: "none", reason: "signed_out" };
    if (typeof s.sub !== "string" || !s.sub.trim() || s.sub.length > 255) return { kind: "none", reason: "invalid_session" };
    let issuer = cfg.issuer;
    let idToken: string | null = null;
    if (typeof s.idToken === "string" && s.idToken) {
      const payload = decodeJwtPayload(s.idToken);
      if (!payload) return { kind: "none", reason: "invalid_session" };
      // The token must belong to this session's subject and this tenant/application.
      if (payload.sub !== s.sub || payload.iss !== cfg.issuer) return { kind: "none", reason: "invalid_session" };
      const aud = payload.aud;
      if (!(aud === cfg.clientId || (Array.isArray(aud) && aud.includes(cfg.clientId)))) return { kind: "none", reason: "invalid_session" };
      if (typeof payload.exp !== "number" || payload.exp <= input.nowSec) return { kind: "none", reason: "expired" };
      issuer = payload.iss as string;
      idToken = s.idToken;
    }
    return { kind: "user", userId: canonicalUserId(issuer, s.sub), subject: s.sub, issuer, idToken };
  }
  if (localModeEnabled(input.env)) return { kind: "local", userId: "local-user" };
  return { kind: "none", reason: "auth_not_configured" };
}

export const DEMO_LOCAL_USER_ID = "demo-margaret";

export type Profile = "real" | "demo" | "test";

/** Which data profile this request uses. Requires an identity first; a cookie can only narrow it to demo/test. */
export function profileFor(identity: Identity, cookie: string | undefined, env: AuthEnv): { profile: Profile; userId: string } | null {
  if (identity.kind === "none") return null;
  const demoAsked = cookie === "demo" || (!cookie && appEnv(env, "DEMO") === "1");
  if (identity.kind === "user") {
    return demoAsked ? { profile: "demo", userId: `${identity.userId}#demo` } : { profile: "real", userId: identity.userId };
  }
  if (demoAsked) return { profile: "demo", userId: DEMO_LOCAL_USER_ID };
  if (cookie && /^test-[a-z0-9-]{4,40}$/.test(cookie)) return { profile: "test", userId: cookie };
  return { profile: "real", userId: identity.userId };
}

export const IDENTITY_MESSAGES: Record<Exclude<Identity, { kind: "user" | "local" }>["reason"], string> = {
  auth_not_configured:
    "Sign-in isn't set up on this server, so personal information can't be stored. For non-sensitive local testing, run `npm run dev:local`.",
  signed_out: "Please sign in to continue.",
  expired: "Your sign-in has expired. Please sign in again.",
  invalid_session: "Your sign-in couldn't be verified. Please sign in again.",
};
