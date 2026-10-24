/**
 * Read the user's consent settings from inside a tool, via the agent's scoped
 * memory. Wellness holds `sharedRead`, so it can read the shared "consent" record
 * written by the app-level consent module. Falls back to defaults on any error so
 * a missing record never crashes a turn. Consent is always re-read live (never
 * cached), so a revocation takes effect on the very next action (red-team case 5).
 */

import { DEFAULT_CONSENT, type ConsentSettings } from "@/agents/base/policy";
import type { ToolContext } from "@/agents/base/types";

export async function readConsent(ctx: Pick<ToolContext, "memory">): Promise<ConsentSettings> {
  try {
    const rows = await ctx.memory.readShared("consent", { limit: 1 });
    const stored = rows[0]?.data as ConsentSettings | undefined;
    return { ...DEFAULT_CONSENT, ...(stored ?? {}) };
  } catch {
    return { ...DEFAULT_CONSENT };
  }
}
