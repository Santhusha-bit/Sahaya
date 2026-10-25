import { getDataLayer } from "../../base/dataLayer";
import { getConsent } from "../../consent";
import { runInvestigation, type Investigation } from "./service";

/** Build a fresh Finance agent for the background worker (the request's agent may be gone). */
async function financeFor(userId: string) {
  // Imported lazily: the registry imports Finance's tools, which import this module.
  const { createAgent } = await import("../../registry");
  const data = getDataLayer();
  const finance = createAgent("finance", { data, userId, consent: await getConsent(data, userId) });
  await finance.initialize();
  return finance;
}

export async function processInvestigation(userId: string, investigationId: string): Promise<Investigation | null> {
  return runInvestigation(await financeFor(userId), investigationId);
}

/**
 * Hand a queued investigation to the worker without blocking the caller. Inside
 * a Next.js request this uses after(), so the run continues once the response
 * is sent; elsewhere (scripts, tests) it runs as a detached promise.
 */
export async function dispatchInvestigation(userId: string, investigationId: string): Promise<void> {
  const work = () =>
    processInvestigation(userId, investigationId).catch((err) => {
      console.error(`[investigation ${investigationId}] worker crashed:`, err);
    });
  try {
    const { after } = await import("next/server");
    after(work);
  } catch {
    void work();
  }
}
