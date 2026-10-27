import "server-only";
import type { AgentContext } from "@/agents/base/types";
import { AgentError } from "@/agents/base/errors";
import { DEMO_CAREGIVER, DEMO_LIMITED_CAREGIVER } from "@/agents/care/data/demoProfile";
import { demoModeActive, getRuntime } from "./runtime";
import { getSessionContext, sessionProfile } from "./session";

export type CareViewer = "self" | "caregiver" | "neighbor";

export const DEMO_VIEWERS: Record<CareViewer, { label: string }> = {
  self: { label: "You" },
  caregiver: { label: DEMO_CAREGIVER.name },
  neighbor: { label: DEMO_LIMITED_CAREGIVER.name },
};

const RECIPIENT_ID = /^[\x21-\x7e]{3,300}$/;

/**
 * Whose eyes the Care dashboard renders through:
 *  - self: the verified person.
 *  - recipient=<id>: a signed-in caregiver viewing someone who granted THEM access. The id must be one of the
 *    caller's active grants (never a free user id); the store re-checks the grant and its capabilities on every
 *    read and write (Convex functions), and the Care agent filters by capability.
 *  - caregiver/neighbor: previews of the fictional demo caregivers, only in explicit local test mode.
 */
export async function careContext(viewer: CareViewer, recipient?: string | null): Promise<AgentContext> {
  const session = await getSessionContext();
  if (recipient) {
    const sp = await sessionProfile();
    if (sp.identityKind !== "user" || sp.profile !== "real") throw new AgentError("PERMISSION_DENIED", "Sign in with your own account to view someone you help.");
    if (!RECIPIENT_ID.test(recipient) || recipient === session.userId) throw new AgentError("PERMISSION_DENIED", "You don't have access to that person.");
    const runtime = await getRuntime(session);
    const mine = await runtime.recipientsFor(session.userId);
    if (!mine.some((r) => r.recipientId === recipient)) throw new AgentError("PERMISSION_DENIED", "You don't have access to that person.");
    return { userId: recipient, actor: { id: session.userId, role: "caregiver" } };
  }
  if (viewer === "self") return session;
  const sp = await sessionProfile();
  if (!demoModeActive() || sp.identityKind !== "local" || sp.profile !== "demo") {
    throw new AgentError("PERMISSION_DENIED", "Caregiver previews are only available in the local demo.");
  }
  const id = viewer === "caregiver" ? DEMO_CAREGIVER.id : DEMO_LIMITED_CAREGIVER.id;
  return { userId: session.userId, actor: { id, role: "caregiver" } };
}
