import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { getSessionContext } from "@/lib/server/session";

const body = z.object({ decision: z.enum(["approve", "deny"]) });

export async function POST(req: NextRequest, ctx: RouteContext<"/api/approvals/[id]">) {
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    const session = await getSessionContext();
    const { approval, result } = await (await getRuntime(session)).resolveApproval(session, id, parsed.data.decision);
    return Response.json({
      approval: { id: approval.id, status: approval.status, summary: approval.summary },
      result: result && (result.status === "error" ? { status: "error", error: result.error } : { status: result.status }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
