import { describe, expect, it } from "vitest";
import { authConfig, canonicalUserId, localModeEnabled, profileFor, resolveIdentity } from "@/lib/auth/identity";
import { isSameOriginRequest } from "@/lib/auth/csrf";
import { decideStorage } from "@/lib/server/storagePolicy";

const AUTH = { SAHAYA_AUTH: "auth0", AUTH0_DOMAIN: "tenant.example.auth0.com", AUTH0_CLIENT_ID: "client123", AUTH0_CLIENT_SECRET: "x", AUTH0_SECRET: "y" };
const NOW = 1_800_000_000;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
const goodToken = (over: object = {}) => jwt({ iss: "https://tenant.example.auth0.com/", aud: "client123", sub: "auth0|abc", exp: NOW + 3600, ...over });

describe("identity resolution (fail closed)", () => {
  it("Auth0 is only active when explicitly enabled and fully configured", () => {
    expect(authConfig({ ...AUTH, SAHAYA_AUTH: undefined })).toEqual({ provider: "none", reason: "not_enabled" });
    expect(authConfig({ ...AUTH, AUTH0_SECRET: "" })).toEqual({ provider: "none", reason: "incomplete" });
    expect(authConfig(AUTH)).toMatchObject({ provider: "auth0", issuer: "https://tenant.example.auth0.com/" });
  });

  it("no session, a tampered/foreign token or an expired token never yields a user", () => {
    expect(resolveIdentity({ env: AUTH, session: null, nowSec: NOW })).toEqual({ kind: "none", reason: "signed_out" });
    expect(resolveIdentity({ env: AUTH, session: { sub: "auth0|abc", idToken: goodToken({ exp: NOW - 1 }) }, nowSec: NOW })).toEqual({ kind: "none", reason: "expired" });
    expect(resolveIdentity({ env: AUTH, session: { sub: "auth0|abc", idToken: goodToken({ sub: "auth0|other" }) }, nowSec: NOW }).kind).toBe("none");
    expect(resolveIdentity({ env: AUTH, session: { sub: "auth0|abc", idToken: goodToken({ aud: "someone-else" }) }, nowSec: NOW }).kind).toBe("none");
    expect(resolveIdentity({ env: AUTH, session: { sub: "auth0|abc", idToken: goodToken({ iss: "https://evil.example/" }) }, nowSec: NOW }).kind).toBe("none");
    expect(resolveIdentity({ env: AUTH, session: { sub: "auth0|abc", idToken: "not-a-jwt" }, nowSec: NOW }).kind).toBe("none");
    expect(resolveIdentity({ env: AUTH, session: { sub: 42 }, nowSec: NOW }).kind).toBe("none");
  });

  it("the app user id comes only from the verified issuer + subject (same as Convex), never email", () => {
    const id = resolveIdentity({ env: AUTH, session: { sub: "auth0|abc", idToken: goodToken({ email: "a@b.c" }) }, nowSec: NOW });
    expect(id).toMatchObject({ kind: "user", userId: canonicalUserId("https://tenant.example.auth0.com/", "auth0|abc") });
    expect(JSON.stringify(id)).not.toContain("a@b.c");
  });

  it("local mode is explicit, development-only, and never overrides configured sign-in", () => {
    expect(resolveIdentity({ env: { NODE_ENV: "development" }, session: null, nowSec: NOW })).toEqual({ kind: "none", reason: "auth_not_configured" });
    expect(localModeEnabled({ NODE_ENV: "production", SAHAYA_LOCAL_MODE: "nonsensitive" })).toBe(false);
    expect(localModeEnabled({ NODE_ENV: "development", SAHAYA_LOCAL_MODE: "nonsensitive", ...AUTH })).toBe(false);
    expect(resolveIdentity({ env: { NODE_ENV: "development", SAHAYA_LOCAL_MODE: "nonsensitive" }, session: null, nowSec: NOW })).toEqual({ kind: "local", userId: "local-user" });
  });

  it("cookies only narrow an existing identity to demo/test; they never authenticate", () => {
    expect(profileFor({ kind: "none", reason: "signed_out" }, "demo", {})).toBeNull();
    const user = { kind: "user" as const, userId: "https://t/|auth0|abc", subject: "auth0|abc", issuer: "https://t/", idToken: "x" };
    expect(profileFor(user, "demo", {})).toEqual({ profile: "demo", userId: "https://t/|auth0|abc#demo" });
    expect(profileFor(user, "test-someone", {})).toEqual({ profile: "real", userId: user.userId }); // test profiles: local only
    expect(profileFor({ kind: "local", userId: "local-user" }, "demo", {})).toEqual({ profile: "demo", userId: "demo-margaret" });
    expect(profileFor({ kind: "local", userId: "local-user" }, "test-abcd", {})).toEqual({ profile: "test", userId: "test-abcd" });
  });
});

describe("storage policy (no silent local fallback)", () => {
  const user = { kind: "user" as const, userId: "u", subject: "s", issuer: "i", idToken: "tok" };
  it("signed-in people need Convex; otherwise 503, never the local file", () => {
    expect(() => decideStorage(user, { NODE_ENV: "development" })).toThrow(expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }));
    expect(() => decideStorage(user, { NODE_ENV: "production", NEXT_PUBLIC_CONVEX_URL: "https://x.convex.cloud" })).toThrow(expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }));
    expect(decideStorage(user, { SAHAYA_STORAGE: "convex", NEXT_PUBLIC_CONVEX_URL: "https://x.convex.cloud" })).toEqual({ kind: "convex", url: "https://x.convex.cloud", token: "tok" });
    expect(() => decideStorage({ ...user, idToken: null }, { SAHAYA_STORAGE: "convex", NEXT_PUBLIC_CONVEX_URL: "https://x.convex.cloud" })).toThrow(expect.objectContaining({ code: "UNAUTHENTICATED" }));
  });
  it("no identity means no storage at all; local identity never in production", () => {
    expect(() => decideStorage({ kind: "none", reason: "signed_out" }, {})).toThrow(expect.objectContaining({ code: "UNAUTHENTICATED" }));
    expect(() => decideStorage({ kind: "local", userId: "local-user" }, { NODE_ENV: "production" })).toThrow(expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }));
    expect(decideStorage({ kind: "local", userId: "local-user" }, { NODE_ENV: "development" })).toEqual({ kind: "file" });
    expect(decideStorage({ kind: "local", userId: "local-user" }, { NODE_ENV: "development", SAHAYA_STORE: "memory" })).toEqual({ kind: "memory" });
  });
});

describe("cross-site protection", () => {
  const req = (method: string, headers: Record<string, string>) => ({ method, url: "http://127.0.0.1:3000/api/x", headers: new Headers(headers) });
  it("allows same-origin state changes and reads; blocks cross-site or header-less writes", () => {
    expect(isSameOriginRequest(req("GET", {}))).toBe(true);
    expect(isSameOriginRequest(req("POST", { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }))).toBe(true);
    expect(isSameOriginRequest(req("POST", { origin: "https://evil.example", host: "127.0.0.1:3000" }))).toBe(false);
    expect(isSameOriginRequest(req("POST", { "sec-fetch-site": "cross-site", host: "127.0.0.1:3000" }))).toBe(false);
    expect(isSameOriginRequest(req("POST", { host: "127.0.0.1:3000" }))).toBe(false);
  });
});
