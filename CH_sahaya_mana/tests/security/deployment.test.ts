import { describe, expect, it, vi } from "vitest";
import { blockingProblems, checkDeploymentEnv, looksLikeSecret } from "@/lib/security/envCheck";
import { contentSecurityPolicy, securityHeaders } from "@/lib/security/headers";

const GOOD = {
  // Home repairs use a sandbox provider: production beyond loopback must switch them off (SANDBOX_PROVIDER).
  SAHAYA_HOME_SERVICES: "off",
  NODE_ENV: "production",
  SAHAYA_AUTH: "auth0",
  SAHAYA_STORAGE: "convex",
  AUTH0_DOMAIN: "tenant.example.auth0.com",
  AUTH0_CLIENT_ID: "client123",
  AUTH0_CLIENT_SECRET: "synthetic-secret",
  AUTH0_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
  APP_BASE_URL: "https://sahaya.example.org",
  NEXT_PUBLIC_CONVEX_URL: "https://happy-animal-123.convex.cloud",
  CONVEX_DEPLOYMENT: "dev:happy-animal-123",
};
const codes = (env: object) => checkDeploymentEnv(env).map((p) => p.code);

describe("production configuration check", () => {
  it("accepts a complete, safe production configuration", () => {
    expect(checkDeploymentEnv(GOOD)).toEqual([]);
  });
  it("refuses local modes, missing auth/storage and non-https base URLs", () => {
    expect(codes({ ...GOOD, SAHAYA_AUTH: undefined })).toContain("AUTH_DISABLED");
    expect(codes({ ...GOOD, SAHAYA_STORAGE: undefined })).toContain("STORAGE_DISABLED");
    expect(codes({ ...GOOD, SAHAYA_LOCAL_MODE: "nonsensitive" })).toContain("LOCAL_MODE");
    expect(codes({ ...GOOD, SAHAYA_STORE: "file" })).toContain("LOCAL_STORE");
    expect(codes({ ...GOOD, APP_BASE_URL: "http://sahaya.example.org" })).toContain("BASE_URL");
    expect(codes({ ...GOOD, APP_BASE_URL: "http://localhost:3100" })).not.toContain("BASE_URL"); // loopback-only E2E build
    expect(codes({ ...GOOD, AUTH0_SECRET: "short" })).toContain("AUTH0_SECRET_WEAK");
    expect(codes({ ...GOOD, NEXT_PUBLIC_CONVEX_URL: "http://localhost:3210" })).toContain("CONVEX_URL");
  });
  it("detects a deploy key in CONVEX_DEPLOYMENT or the runtime env, and secrets in NEXT_PUBLIC_ vars", () => {
    expect(codes({ ...GOOD, CONVEX_DEPLOYMENT: "prod:synthetic-name|c3ludGhldGljLXRva2Vu" })).toContain("CONVEX_DEPLOY_KEY_IN_ENV");
    expect(codes({ ...GOOD, CONVEX_DEPLOY_KEY: "x" })).toContain("CONVEX_DEPLOY_KEY_AT_RUNTIME");
    expect(codes({ ...GOOD, NEXT_PUBLIC_API_KEY: "abc" })).toContain("PUBLIC_SECRET");
    expect(codes({ ...GOOD, NEXT_PUBLIC_THING: "sk-synthetic-value" })).toContain("PUBLIC_SECRET");
    expect(looksLikeSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln")).toBe(true);
    expect(looksLikeSecret("https://happy-animal-123.convex.cloud")).toBe(false);
  });
  it("only blocks in production; messages never contain values", () => {
    expect(blockingProblems({ NODE_ENV: "development" })).toEqual([]);
    const problems = checkDeploymentEnv({ ...GOOD, CONVEX_DEPLOYMENT: "prod:synthetic-name|c3ludGhldGljLXRva2Vu", NEXT_PUBLIC_X: "sk-synthetic-value" });
    expect(JSON.stringify(problems)).not.toMatch(/c3ludGhldGljLXRva2Vu|sk-synthetic-value/);
  });
  it("the proxy serves a safe unavailable page in a misconfigured production", async () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { ...env };
    try {
      for (const k of Object.keys(GOOD)) delete env[k];
      env.NODE_ENV = "production";
      vi.resetModules();
      const { NextRequest } = await import("next/server");
      const { proxy } = await import("@/proxy");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const page = await proxy(new NextRequest("http://127.0.0.1:3000/"));
      expect(page.status).toBe(503);
      expect(await page.text()).toContain("isn't configured safely");
      const api = await proxy(new NextRequest("http://127.0.0.1:3000/api/care/dashboard"));
      expect(api.status).toBe(503);
      expect(spy.mock.calls.flat().join(" ")).not.toMatch(/=/);
      spy.mockRestore();
    } finally {
      for (const k of Object.keys(env)) if (!(k in saved)) delete env[k];
      Object.assign(env, saved);
    }
  });
});

describe("security headers", () => {
  it("forbid framing, restrict sources, allow the microphone for this origin and Cartesia voice", () => {
    const prod = Object.fromEntries(securityHeaders({ NODE_ENV: "production" }).map((h) => [h.key, h.value]));
    expect(prod["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(prod["Content-Security-Policy"]).toContain("wss://api.cartesia.ai");
    expect(prod["Content-Security-Policy"]).toContain("media-src 'self' blob:");
    expect(prod["Content-Security-Policy"]).not.toContain("unsafe-eval");
    expect(prod["Permissions-Policy"]).toContain("microphone=(self)");
    expect(prod["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(prod["Strict-Transport-Security"]).toBeDefined();
    expect(contentSecurityPolicy({ NODE_ENV: "development" })).toContain("'unsafe-eval'"); // Next dev only
    // The loopback E2E build is plain http: no HSTS / upgrade-insecure-requests there.
    const loop = Object.fromEntries(securityHeaders({ NODE_ENV: "production", APP_BASE_URL: "http://localhost:3100" }).map((h) => [h.key, h.value]));
    expect(loop["Strict-Transport-Security"]).toBeUndefined();
    expect(loop["Content-Security-Policy"]).not.toContain("upgrade-insecure-requests");
  });
});

describe("Auth0 session cookie settings", () => {
  it("are Secure in production, SameSite=Lax, short and rolling", async () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { ...env };
    const seen: unknown[] = [];
    vi.resetModules();
    vi.doMock("@auth0/nextjs-auth0/server", () => ({
      Auth0Client: class {
        constructor(opts: unknown) {
          seen.push(opts);
        }
      },
    }));
    try {
      Object.assign(env, GOOD);
      const { getAuth0 } = await import("@/lib/auth0");
      expect(getAuth0()).not.toBeNull();
      expect(seen[0]).toMatchObject({
        authorizationParameters: { scope: "openid profile" },
        session: { rolling: true, inactivityDuration: 7200, absoluteDuration: 28800, cookie: { secure: true, sameSite: "lax" } },
      });
    } finally {
      vi.doUnmock("@auth0/nextjs-auth0/server");
      for (const k of Object.keys(env)) if (!(k in saved)) delete env[k];
      Object.assign(env, saved);
    }
  });
});
