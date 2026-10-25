/**
 * Side-effect module: load `.env.local` into process.env BEFORE any module that
 * reads env at load time. Import this FIRST in demo/CLI scripts so `npm run demo:*`
 * and `npm run redteam` run with the same live/sandbox integrations as the web app
 * (Next.js loads .env.local automatically; vite-node does not).
 *
 *   import "./loadEnv";   // must be the first import
 *
 * Existing process.env values win (so inline overrides still work).
 */
import { readFileSync } from "node:fs";

try {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  /* no .env.local -> scripts run in sandbox, exactly as before */
}
