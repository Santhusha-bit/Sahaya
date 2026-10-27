import type { NextRequest } from "next/server";
import { z } from "zod";
import type { CareAgent } from "@/agents/care/CareAgent";
import { careContext, DEMO_VIEWERS } from "@/lib/server/careSession";
import { errorResponse } from "@/lib/server/http";
import { demoModeActive, describeStorage, getDemoClock, getRequestStorage, getRuntime } from "@/lib/server/runtime";
import { getSessionContext } from "@/lib/server/session";

const viewer = z.enum(["self", "caregiver", "neighbor"]).catch("self");

/** Care dashboard read model, filtered on the server by the viewer's permissions. */
export async function GET(req: NextRequest) {
  // Read request data outside the try so Next's prerender bail-out isn't caught as an error.
  const as = viewer.parse(req.nextUrl.searchParams.get("as"));
  const recipient = req.nextUrl.searchParams.get("recipient");
  try {
    const session = await getSessionContext();
    const runtime = await getRuntime(session);
    const ctx = await careContext(as, recipient);
    const care = runtime.get("care") as CareAgent;
    const dashboard = await care.getDashboard(ctx);
    const own = ctx.actor.role === "older_adult";
    const routes = own ? (await runtime.listConsentRoutes(session.userId)).filter((r) => r.source === "care" || r.target === "care") : [];
    const clock = getDemoClock();
    const { auth, decision } = await getRequestStorage();
    return Response.json(
      {
      ...dashboard,
      viewerLabel: recipient ? "You (caregiver)" : DEMO_VIEWERS[as].label,
      demoMode: demoModeActive(),
      profileMode: auth.profile,
      identityKind: auth.identity.kind,
      storage: describeStorage(decision),
      sandboxClock: { simulatedOffsetMinutes: Math.round(clock.simulatedOffsetMs / 60_000) },
      routes,
      },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
