/**
 * Deployment configuration check. In production (and staging, which runs with NODE_ENV=production) the app
 * serves only a "not configured safely" page until every rule passes. Messages name variables, never values.
 */
import { appEnv } from "@/lib/config/env";

export type EnvProblem = { code: string; message: string };

const SECRETISH_NAME = /(SECRET|PASSWORD|PRIVATE|TOKEN|DEPLOY_KEY|API_KEY|CLIENT_SECRET)/i;

/** Values that look like credentials (JWTs, deploy keys, long random strings, provider key prefixes). */
export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) return true; // JWT
  if (/^(prod|dev|preview|project):[\w-]+\|/.test(v)) return true; // Convex deploy key
  if (/^(sk|pk_live|rk|sk_live|xoxb|ghp|gho)[-_]/.test(v)) return true; // common provider keys
  if (/^https?:\/\//.test(v)) return false; // URLs are not secrets by themselves
  return v.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v);
}

export function checkDeploymentEnv(env: Partial<Record<string, string | undefined>>): EnvProblem[] {
  const p: EnvProblem[] = [];
  const has = (k: string) => Boolean(env[k]?.trim());
  // SAHAYA_* names, with the deprecated KINLINE_* names checked by exactly the same rules.
  if (appEnv(env, "AUTH") !== "auth0") p.push({ code: "AUTH_DISABLED", message: "SAHAYA_AUTH must be auth0." });
  if (appEnv(env, "STORAGE") !== "convex") p.push({ code: "STORAGE_DISABLED", message: "SAHAYA_STORAGE must be convex." });
  for (const k of ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET"]) {
    if (!has(k)) p.push({ code: "AUTH0_MISSING", message: `${k} is not set.` });
  }
  if (has("AUTH0_SECRET") && env.AUTH0_SECRET!.length < 32) p.push({ code: "AUTH0_SECRET_WEAK", message: "AUTH0_SECRET must be at least 32 characters (openssl rand -hex 32)." });
  if (has("AUTH0_DOMAIN") && /^https?:\/\//.test(env.AUTH0_DOMAIN!)) p.push({ code: "AUTH0_DOMAIN_FORMAT", message: "AUTH0_DOMAIN must be a host name without https://." });
  // https everywhere, except a loopback-only production build for local end-to-end testing (unreachable remotely).
  const base = env.APP_BASE_URL?.trim() ?? "";
  if (!/^https:\/\/[^/]+/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(base)) {
    p.push({ code: "BASE_URL", message: "APP_BASE_URL must be an https:// URL (http only for localhost)." });
  }
  if (!has("NEXT_PUBLIC_CONVEX_URL") || !/^https:\/\/[a-z0-9-]+\.convex\.cloud\/?$/.test(env.NEXT_PUBLIC_CONVEX_URL!)) {
    p.push({ code: "CONVEX_URL", message: "NEXT_PUBLIC_CONVEX_URL must be https://<deployment>.convex.cloud." });
  }
  if (has("CONVEX_DEPLOYMENT") && env.CONVEX_DEPLOYMENT!.includes("|")) {
    p.push({ code: "CONVEX_DEPLOY_KEY_IN_ENV", message: "CONVEX_DEPLOYMENT contains a deploy key. Rotate it and keep deploy keys out of the app environment." });
  }
  if (has("CONVEX_DEPLOY_KEY")) p.push({ code: "CONVEX_DEPLOY_KEY_AT_RUNTIME", message: "CONVEX_DEPLOY_KEY must only exist in the deploy pipeline, not the running app." });
  if (has("SAHAYA_LOCAL_MODE") || has("KINLINE_LOCAL_MODE")) p.push({ code: "LOCAL_MODE", message: "SAHAYA_LOCAL_MODE (or the old KINLINE_LOCAL_MODE) must not be set in production." });
  // The home-repair sandbox provider must never present sandbox bookings to real users: a production build that is
  // reachable beyond loopback must switch home services off until a real provider is authorized.
  const loopback = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(base);
  if (!loopback && (appEnv(env, "HOME_SERVICES") ?? "").trim().toLowerCase() !== "off") {
    p.push({ code: "SANDBOX_PROVIDER", message: "Home repairs use a sandbox provider. Set SAHAYA_HOME_SERVICES=off in production until a real provider is authorized." });
  }
  if (env.SAHAYA_STORE === "file" || env.KINLINE_STORE === "file") p.push({ code: "LOCAL_STORE", message: "Local file storage is not allowed in production." });
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith("NEXT_PUBLIC_") || !v) continue;
    if (/GETTERDONE/i.test(k)) p.push({ code: "PUBLIC_SECRET", message: `${k}: GetterDone settings must be server-side only (never NEXT_PUBLIC_).` });
    else if (SECRETISH_NAME.test(k) || looksLikeSecret(v)) p.push({ code: "PUBLIC_SECRET", message: `${k} looks like a secret but would be sent to browsers.` });
  }
  return p;
}

/** Problems that block serving in this environment (none outside production). */
export function blockingProblems(env: Partial<Record<string, string | undefined>>): EnvProblem[] {
  return env.NODE_ENV === "production" ? checkDeploymentEnv(env) : [];
}
