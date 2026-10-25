import type { NextRequest } from "next/server";
import { z } from "zod";
import { AgentError } from "@/agents/base/errors";
import { errorResponse } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { getSessionContext, resolveRequest } from "@/lib/server/session";

const scope = z.enum(["care:medications", "care:medications:approve", "care:grocery", "care:grocery:approve", "care:home-services"]);
const body = z.object({
  /** The caregiver's verified Sahaya ID (`https://<auth0-domain>/|<sub>`), shown on their own Profile page. */
  caregiverId: z.string().trim().min(3).max(300),
  scopes: z.array(scope).max(4).default([]),
  canApprove: z.boolean().default(false),
  revoke: z.boolean().default(false),
  /** Optional end of access, in days from now (1–365). */
  expiresInDays: z.number().int().min(1).max(365).optional(),
  /** How the caregiver will see you in their list, e.g. "Mum". No identifiers needed. */
  recipientLabel: z.string().trim().max(60).optional(),
});

const NO_STORE = { "Cache-Control": "no-store, private" };

/**
 * GET: the person's grants + recent caregiver activity (owner view), and the people who granted the signed-in user
 * access (caregiver view). POST: owner-only grant/revoke by the caregiver's verified id — never by name or email.
 */
export async function GET() {
  try {
    const session = await getSessionContext();
    const runtime = await getRuntime(session);
    const auth = await resolveRequest();
    const overview = auth.profile === "real" ? await runtime.caregiverOverview(session) : { grants: [], audit: [] };
    const recipients = auth.identity.kind === "user" && auth.profile === "real" ? await runtime.recipientsFor(session.userId) : [];
    return Response.json({ myId: auth.identity.kind === "user" ? auth.identity.userId : null, ...overview, recipients }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    // Identity first: signed-out callers get 401 before anything about the request is evaluated.
    const auth = await resolveRequest();
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Please check the caregiver ID and permissions.", code: "VALIDATION_FAILED" }, { status: 400 });
    if (auth.profile !== "real") throw new AgentError("PERMISSION_DENIED", "Caregiver access can only be granted from your own profile, not the demo.");
    const id = parsed.data.caregiverId;
    const validId =
      auth.identity.kind === "user"
        ? id.startsWith(`${auth.identity.issuer}|`) && id.length > auth.identity.issuer.length + 2 && !id.includes("#")
        : /^cg_[a-z0-9_]{3,40}$/.test(id); // local test mode only: synthetic caregiver ids
    if (!validId) throw new AgentError("VALIDATION_FAILED", "That isn't a Sahaya ID. Ask the caregiver to copy it from their Profile page.");
    const session = await getSessionContext();
    const runtime = await getRuntime(session);
    const { expiresInDays, ...rest } = parsed.data;
    const expiresAt = expiresInDays ? Date.now() + expiresInDays * 24 * 60 * 60 * 1000 : undefined;
    return Response.json(await runtime.setCaregiverGrant(session, { ...rest, expiresAt, agentId: "care" }), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
