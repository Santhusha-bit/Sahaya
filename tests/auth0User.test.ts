import { afterEach, describe, expect, it, vi } from "vitest";

const AUTH0_ENV = {
  AUTH0_DOMAIN: "sahaya-test.us.auth0.com",
  AUTH0_CLIENT_ID: "test-client",
  AUTH0_CLIENT_SECRET: "test-secret",
  AUTH0_SECRET: "a".repeat(64),
};

afterEach(() => {
  for (const k of Object.keys(AUTH0_ENV)) delete process.env[k];
  vi.resetModules();
});

describe("Auth0 wiring", () => {
  it("without Auth0 env: no client, demo user, sandbox status", async () => {
    const { auth0 } = await import("@/lib/auth0");
    const { getCurrentUser } = await import("@/lib/user");
    const { auth0Status } = await import("@/lib/env");
    expect(auth0).toBeNull();
    expect(auth0Status().mode).toBe("sandbox");
    const user = await getCurrentUser();
    expect(user).toMatchObject({ id: "demo-user", authMode: "sandbox" });
  });

  it("a partial config (no client secret) stays in demo mode", async () => {
    process.env.AUTH0_DOMAIN = AUTH0_ENV.AUTH0_DOMAIN;
    process.env.AUTH0_CLIENT_ID = AUTH0_ENV.AUTH0_CLIENT_ID;
    const { auth0 } = await import("@/lib/auth0");
    expect(auth0).toBeNull();
  });

  it("with Auth0 env: client exists, status live; outside a request falls back to demo user", async () => {
    Object.assign(process.env, AUTH0_ENV);
    const { auth0 } = await import("@/lib/auth0");
    const { getCurrentUser } = await import("@/lib/user");
    const { auth0Status } = await import("@/lib/env");
    expect(auth0).not.toBeNull();
    expect(auth0Status().mode).toBe("live");
    // CLI scripts and tests have no request cookies to read.
    const user = await getCurrentUser();
    expect(user.authMode).toBe("sandbox");
  });
});
