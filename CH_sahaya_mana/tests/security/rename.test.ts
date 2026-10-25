import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authConfig, localModeEnabled } from "@/lib/auth/identity";
import { appEnv, legacyEnvNames } from "@/lib/config/env";
import { decideStorage } from "@/lib/server/storagePolicy";
import { resolveLocalStorePath } from "@/lib/server/localStorePath";
import { checkDeploymentEnv } from "@/lib/security/envCheck";

const AUTH0 = { AUTH0_DOMAIN: "tenant.example.auth0.com", AUTH0_CLIENT_ID: "client123", AUTH0_CLIENT_SECRET: "x", AUTH0_SECRET: "y" };

describe("Kinline → Sahaya rename: settings", () => {
  it("SAHAYA_* is primary; the deprecated KINLINE_* name is a fallback; SAHAYA_* wins when both are set", () => {
    expect(appEnv({ SAHAYA_AUTH: "auth0" }, "AUTH")).toBe("auth0");
    expect(appEnv({ KINLINE_AUTH: "auth0" }, "AUTH")).toBe("auth0");
    expect(appEnv({ SAHAYA_AUTH: "none", KINLINE_AUTH: "auth0" }, "AUTH")).toBe("none");
    expect(appEnv({ SAHAYA_STORAGE: "", KINLINE_STORAGE: "convex" }, "STORAGE")).toBe(""); // an explicit blank switches it off
    expect(appEnv({}, "AUTH")).toBeUndefined();
    expect(legacyEnvNames({ KINLINE_AUTH: "auth0", SAHAYA_STORAGE: "convex" })).toEqual(["KINLINE_AUTH"]);
  });

  it("sign-in, local mode and storage follow the same rules under either name", () => {
    expect(authConfig({ ...AUTH0, SAHAYA_AUTH: "auth0" }).provider).toBe("auth0");
    expect(authConfig({ ...AUTH0, KINLINE_AUTH: "auth0" }).provider).toBe("auth0");
    expect(authConfig({ ...AUTH0, SAHAYA_AUTH: "", KINLINE_AUTH: "auth0" }).provider).toBe("none");
    expect(localModeEnabled({ NODE_ENV: "development", KINLINE_LOCAL_MODE: "nonsensitive" })).toBe(true);
    expect(localModeEnabled({ NODE_ENV: "production", SAHAYA_LOCAL_MODE: "nonsensitive" })).toBe(false);
    const user = { kind: "user", userId: "https://t/|u", issuer: "https://t/", idToken: "tok" } as const;
    expect(decideStorage(user as never, { KINLINE_STORAGE: "convex", NEXT_PUBLIC_CONVEX_URL: "https://x.convex.cloud" }).kind).toBe("convex");
    expect(() => decideStorage(user as never, { SAHAYA_STORAGE: "", KINLINE_STORAGE: "convex", NEXT_PUBLIC_CONVEX_URL: "https://x.convex.cloud" })).toThrow();
  });

  it("production validation applies equally to the old names", () => {
    const good = { ...AUTH0, AUTH0_SECRET: "a".repeat(40), APP_BASE_URL: "https://sahaya.example.org", NEXT_PUBLIC_CONVEX_URL: "https://dep.convex.cloud", SAHAYA_HOME_SERVICES: "off" };
    const codes = (env: Record<string, string | undefined>) => checkDeploymentEnv(env).map((p) => p.code);
    expect(codes({ ...good, SAHAYA_AUTH: "auth0", SAHAYA_STORAGE: "convex" })).toEqual([]);
    expect(codes({ ...good, KINLINE_AUTH: "auth0", KINLINE_STORAGE: "convex" })).toEqual([]);
    expect(codes({ ...good, SAHAYA_AUTH: "auth0", SAHAYA_STORAGE: "convex", KINLINE_LOCAL_MODE: "nonsensitive" })).toContain("LOCAL_MODE");
    expect(codes({ ...good, SAHAYA_AUTH: "auth0", SAHAYA_STORAGE: "convex", KINLINE_STORE: "file" })).toContain("LOCAL_STORE");
    expect(codes({ ...good, SAHAYA_AUTH: "auth0", SAHAYA_STORAGE: "", KINLINE_STORAGE: "convex" })).toContain("STORAGE_DISABLED");
  });
});

describe("Kinline → Sahaya rename: local test store", () => {
  it("moves the old .data/kinline-store.json to .data/sahaya-store.json once, keeping its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "sahaya-store-"));
    writeFileSync(join(dir, "kinline-store.json"), '{"v":1}');
    const p = resolveLocalStorePath({}, dir);
    expect(p).toBe(join(dir, "sahaya-store.json"));
    expect(readFileSync(p, "utf8")).toBe('{"v":1}');
    expect(existsSync(join(dir, "kinline-store.json"))).toBe(false);
    expect(resolveLocalStorePath({}, dir)).toBe(p); // second call: nothing to move
  });

  it("never overwrites an existing new store; an explicit path still wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "sahaya-store-"));
    writeFileSync(join(dir, "sahaya-store.json"), "new");
    writeFileSync(join(dir, "kinline-store.json"), "old");
    expect(readFileSync(resolveLocalStorePath({}, dir), "utf8")).toBe("new");
    expect(existsSync(join(dir, "kinline-store.json"))).toBe(true);
    expect(resolveLocalStorePath({ KINLINE_STORE_PATH: "/tmp/x.json" }, dir)).toBe("/tmp/x.json");
    expect(resolveLocalStorePath({ SAHAYA_STORE_PATH: "/tmp/y.json", KINLINE_STORE_PATH: "/tmp/x.json" }, dir)).toBe("/tmp/y.json");
  });
});
