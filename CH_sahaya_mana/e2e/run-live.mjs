#!/usr/bin/env node
/**
 * Live E2E orchestrator: builds once, starts a loopback production server (http://localhost:3000 by default) against the real
 * Auth0 tenant and Convex DEVELOPMENT deployment configured in .env.local, runs the Playwright specs, restarts the
 * server to prove persistence, then runs the outage scenarios on deliberately broken servers.
 * Synthetic accounts only (.env.e2e.local). Without them it prints SKIPPED and runs nothing — never a fake pass.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".env.e2e.local")) process.loadEnvFile(".env.e2e.local");
// Two synthetic accounts: the care recipient (A) and the caregiver. Any other E2E_* lines are ignored.
const need = ["E2E_USER_A_EMAIL", "E2E_USER_A_PASSWORD", "E2E_CAREGIVER_EMAIL", "E2E_CAREGIVER_PASSWORD"];
const missing = need.filter((k) => !process.env[k]);
if (process.env.E2E_LIVE !== "1" || missing.length) {
  console.log("\n  LIVE E2E SKIPPED (nothing was tested).");
  console.log(`  ${process.env.E2E_LIVE !== "1" ? "E2E_LIVE=1 is not set. " : ""}${missing.length ? `Missing: ${missing.join(", ")}.` : ""}`);
  console.log("  Fill in .env.e2e.local (see docs/e2e.md) after Auth0 and the Convex dev deployment are configured.\n");
  process.exit(0);
}

// Port must be one of the Auth0 application's Allowed Callback URLs (default http://localhost:3000; stop `npm run dev` first).
const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE = `http://localhost:${PORT}`;
// The Convex DEVELOPMENT deployment to test against (never production).
const CONVEX_URL = process.env.E2E_CONVEX_URL ?? "https://valiant-scorpion-727.convex.cloud";
const base = {
  ...process.env,
  NODE_ENV: "production",
  SAHAYA_AUTH: "auth0",
  SAHAYA_STORAGE: "convex",
  NEXT_PUBLIC_CONVEX_URL: CONVEX_URL,
  APP_BASE_URL: BASE,
  E2E_BASE_URL: BASE,
  E2E_LIVE: "1",
  E2E_RUN_ID: String(Date.now()),
  // A deploy key in .env.local isn't part of the app; blank it for the test server (the production check would
  // otherwise — correctly — refuse to start). The real .env.local still needs it removed.
  CONVEX_DEPLOY_KEY: "",
  CONVEX_DEPLOYMENT: "",
};
delete base.SAHAYA_LOCAL_MODE;
delete base.KINLINE_LOCAL_MODE; // deprecated name, ignored here too

function run(cmd, args, env = process.env) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env });
  return r.status ?? 1;
}

async function withServer(env, fn) {
  const server = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(PORT)], { env, stdio: ["ignore", "ignore", "inherit"] });
  try {
    for (let i = 0; i < 90; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" });
        if (res.status) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    return fn();
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const results = [];
if (run("npm", ["run", "build"], base) !== 0) {
  console.error("Build failed; E2E not run.");
  process.exit(1);
}
const pw = (env, specs) => run("npx", ["playwright", "test", ...specs], env);

results.push(["main", await withServer(base, () => pw(base, ["e2e/public.spec.ts", "e2e/auth.spec.ts", "e2e/caregiver.spec.ts", "e2e/safety.spec.ts", "e2e/homeServices.spec.ts", "e2e/memory.spec.ts"]))]);
results.push(["after-restart", await withServer(base, () => pw({ ...base, E2E_PHASE: "after-restart" }, ["e2e/memory.spec.ts"]))]);
const scenarios = {
  "db-outage": { NEXT_PUBLIC_CONVEX_URL: "https://sahaya-e2e-nonexistent-000.convex.cloud" },
  "auth-outage": { AUTH0_DOMAIN: "sahaya-e2e-unreachable.invalid" },
  "no-storage": { SAHAYA_STORAGE: "" },
};
for (const [name, extra] of Object.entries(scenarios)) {
  const env = { ...base, ...extra, E2E_SCENARIO: name };
  results.push([name, await withServer(env, () => pw(env, ["e2e/outage.spec.ts"]))]);
}
console.log("\nLIVE E2E results (exit codes; 0 = all specs in that run passed or were explicitly skipped with a reason):");
for (const [name, code] of results) console.log(`  ${name}: ${code}`);
process.exit(results.some(([, c]) => c !== 0) ? 1 : 0);
