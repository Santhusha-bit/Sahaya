import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { api, chat, login, memories, requireLive } from "./helpers";

/**
 * Real conversation (Claude) → real database (Convex). Synthetic preference only. The model may ask a follow-up
 * first, so we allow one clarifying turn; if nothing is saved after that, the test FAILS (no fallback).
 * Phase "after-restart" (run by e2e/run-live.mjs after restarting the server) checks persistence.
 */
// Outside Playwright's output folder (which is cleared on every run), so phase 2 can read it after the restart.
const STATE = `${tmpdir()}/sahaya-e2e-memory-state.json`;

test("i · learn → inspect → confirm → correct → forget, persisting across contexts", async ({ browser }) => {
  requireLive("A");
  test.skip(process.env.E2E_PHASE === "after-restart", "phase 1 only");
  rmSync(STATE, { force: true }); // never let phase 2 reuse a previous run's state
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "A");
  for (const m of await memories(page)) await api(page.request).post("/api/care/actions", { action: "memory_delete", factId: m.id });

  await chat(page, "Please remember that I always buy Meadow Mill oat milk.");
  let saved = (await memories(page)).find((m) => /oat milk/i.test(m.value));
  if (!saved) {
    await chat(page, "Yes, Meadow Mill oat milk — please save that.");
    saved = (await memories(page)).find((m) => /oat milk/i.test(m.value));
  }
  expect(saved, "Care did not save the stated preference").toBeTruthy();
  expect(["reported", "confirmed"]).toContain(saved!.status);

  // It's shown under "What Care knows about you" on the Care page.
  await page.goto("/agents/care");
  await expect(page.getByText("What Care knows about you")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(saved!.value).first()).toBeVisible();

  // A new browser context (new session) sees the same memory.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await login(page2, "A");
  expect((await memories(page2)).map((m) => m.id)).toContain(saved!.id);

  // Correct on the dashboard → confirmed with the new value.
  expect((await api(page2.request).post("/api/care/actions", { action: "memory_correct", factId: saved!.id, value: "Meadow Mill barista oat milk" })).status()).toBe(200);
  const corrected = (await memories(page2)).find((m) => m.id === saved!.id)!;
  expect(corrected).toMatchObject({ value: "Meadow Mill barista oat milk", status: "confirmed" });
  writeFileSync(STATE, JSON.stringify({ factId: saved!.id, runId: process.env.E2E_RUN_ID ?? null }));
  await ctx.close();
  await ctx2.close();
});

test("i · after a server restart the memory is still there, then forget removes it everywhere", async ({ page }) => {
  requireLive("A");
  test.skip(process.env.E2E_PHASE !== "after-restart" || !existsSync(STATE), "phase 2 runs after run-live.mjs restarts the server");
  const { factId, runId } = JSON.parse(readFileSync(STATE, "utf8"));
  test.skip(runId !== (process.env.E2E_RUN_ID ?? null), "phase 1 of this run didn't save a memory");
  await login(page, "A");
  expect((await memories(page)).map((m) => m.id)).toContain(factId);
  expect((await api(page.request).post("/api/care/actions", { action: "memory_delete", factId })).status()).toBe(200);
  expect((await memories(page)).map((m) => m.id)).not.toContain(factId);
  const state = await (await api(page.request).get("/api/agents/care/state")).json();
  expect(JSON.stringify(state.messages)).not.toContain("Meadow Mill barista oat milk");
});
