import type { NextRequest } from "next/server";
import { z } from "zod";
import { AgentError, type AgentErrorCode } from "@/agents/base/errors";
import type { AgentId } from "@/agents/base/types";
import type { CareAgent } from "@/agents/care/CareAgent";
import { DoseTransitionError } from "@/agents/care/domain/medication";
import type { OrderSummary } from "@/agents/care/services/groceryService";
import { careContext } from "@/lib/server/careSession";
import { errorResponse } from "@/lib/server/http";
import { demoModeActive, getDemoClock, getRuntime } from "@/lib/server/runtime";
import { PROFILE_COOKIE, getSessionContext } from "@/lib/server/session";

const as = z.enum(["self", "caregiver", "neighbor"]).default("self");
/** A person who granted the signed-in caregiver access (re-verified against the caller's grants). */
const recipient = z.string().min(3).max(300).optional();
const id = z.string().min(1).max(120);

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tick"), as, recipient }),
  z.object({ action: z.literal("advance"), as, recipient, minutes: z.number().int().min(1).max(24 * 60) }),
  z.object({ action: z.literal("confirm_dose"), as, recipient, doseId: id }),
  z.object({ action: z.literal("voice_reply"), as, recipient, text: z.string().min(1).max(500) }),
  z.object({ action: z.literal("pickup"), as, recipient, refillId: id }),
  z.object({ action: z.literal("pill_count"), as, recipient, medicationId: id, count: z.number().int().min(0).max(2000) }),
  z.object({ action: z.literal("pill_count_confirm"), as, recipient, pendingId: id, answer: z.enum(["yes", "no"]) }),
  z.object({ action: z.literal("acknowledge"), as, recipient, alertId: id }),
  z.object({ action: z.literal("decide"), as, recipient, approvalId: id, decision: z.enum(["approve", "deny"]) }),
  z.object({ action: z.literal("cooking"), as, recipient, text: z.string().min(1).max(200) }),
  z.object({ action: z.literal("consent"), as, recipient, source: z.string(), target: z.string(), type: z.string().max(80), enabled: z.boolean() }),
  z.object({ action: z.literal("grocery_usual"), as, recipient }),
  z.object({ action: z.literal("grocery_add"), as, recipient, items: z.array(z.string().trim().min(1).max(60)).min(1).max(10) }),
  z.object({ action: z.literal("suggestion"), as, recipient, cartId: id, suggestionId: id, decision: z.enum(["accept", "decline"]) }),
  z.object({ action: z.literal("order"), as, recipient, cartId: id }),
  z.object({ action: z.literal("meals"), as, recipient }),
  z.object({ action: z.literal("cook"), as, recipient, recipeId: id }),
  z.object({ action: z.literal("memory_correct"), as, recipient, factId: id, value: z.string().min(1).max(160) }),
  z.object({ action: z.literal("memory_delete"), as, recipient, factId: id }),
  // Home repairs. Person-only; every step goes through the Care tools. Booking happens only via "decide" (approve).
  z.object({
    action: z.literal("home_start"),
    as,
    recipient,
    requestId: id.optional(),
    service: z.enum(["plumbing", "electrical", "handyman", "appliance", "hvac", "tech", "cleaning", "chores"]),
    description: z.string().min(1).max(300),
    householdNotes: z.string().max(200).optional(),
    preferredTiming: z.string().max(80).optional(),
  }),
  /** Pick a time (or Change time): a new approval card; any earlier pending approval for the request is voided. */
  z.object({ action: z.literal("home_choose_time"), as, recipient, requestId: id, windowId: z.string().regex(/^win_\d{4}-\d{2}-\d{2}_(09|12|15)$/) }),
  z.object({ action: z.literal("demo"), as, recipient, enabled: z.boolean() }),
]);

/**
 * Care dashboard actions. Each one maps to an existing agent method or tool, so the same backend
 * checks apply as in conversation: role checks, caregiver scopes, approvals verified server-side.
 */
export async function POST(req: NextRequest) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const input = parsed.data;
  if (input.action === "demo") {
    // Switch between the real (empty-by-default) profile and the separate fictional demo profile.
    // Demo records live under a different user id; nothing is copied between them. A verified identity
    // (or explicit local mode) is still required — the cookie only selects a view, it never authenticates.
    try {
      await getSessionContext();
    } catch (err) {
      return errorResponse(err);
    }
    const res = Response.json({ ok: true, profile: input.enabled ? "demo" : "real" });
    res.headers.append("Set-Cookie", `${PROFILE_COOKIE}=${input.enabled ? "demo" : "real"}; Path=/; SameSite=Lax; HttpOnly; Max-Age=${60 * 60 * 24 * 365}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    return res;
  }
  try {
    const session = await getSessionContext();
    const runtime = await getRuntime(session);
    const care = runtime.get("care") as CareAgent;
    const ctx = await careContext(input.as, input.recipient);
    const self = () => {
      if (ctx.actor.role !== "older_adult") throw new AgentError("PERMISSION_DENIED", "only the person themselves can do that");
    };
    const tool = async (name: string, toolInput: unknown) => {
      self();
      const r = await care.executeTool(ctx, name, toolInput);
      if (r.status === "error") throw new AgentError(r.code as AgentErrorCode, r.error);
      return r.status === "approval_required" ? { status: r.status, approval: { id: r.approval.id, summary: r.approval.summary } } : { status: r.status, output: r.output };
    };
    switch (input.action) {
      case "tick":
        self();
        return Response.json(await care.tick(ctx));
      case "advance": {
        self();
        if (!demoModeActive()) throw new AgentError("PERMISSION_DENIED", "the sandbox clock only exists in demo mode");
        getDemoClock().advanceMinutes(input.minutes);
        return Response.json(await care.tick(ctx));
      }
      case "confirm_dose":
        return Response.json(await care.confirmDoseByUser(ctx, input.doseId));
      case "voice_reply":
        return Response.json(await care.medicationVoiceReply(ctx, input.text));
      case "pill_count":
        return Response.json(await care.reportPillCount(ctx, input.medicationId, input.count));
      case "pill_count_confirm":
        // The user's explicit tap on the confirmation question.
        return Response.json(await care.confirmPillCount(ctx, input.pendingId, input.answer));
      case "pickup":
        return Response.json(await care.markRefillPickedUp(ctx, input.refillId));
      case "acknowledge":
        return Response.json(await care.acknowledgeAlert(ctx, input.alertId));
      case "decide":
        return Response.json(await care.decide(ctx, input.approvalId, input.decision));
      case "cooking":
        return Response.json(await care.cookingVoice(ctx, input.text));
      case "consent":
        await runtime.setConsent(ctx, input.source as AgentId, input.target as AgentId, input.type, input.enabled);
        return Response.json({ ok: true });
      case "grocery_usual":
        return Response.json(await tool("createGroceryList", { includeUsualItems: true, additionalItems: [] }));
      case "grocery_add":
        // The person adds named items to their list; same tool, allergy filter and limits as in conversation.
        return Response.json(await tool("createGroceryList", { includeUsualItems: false, additionalItems: input.items }));
      case "suggestion": {
        const review = await tool("reviewCart", { cartId: input.cartId });
        const sub = (review.output as OrderSummary).pendingSubstitutions.find((s) => s.id === input.suggestionId);
        return Response.json(
          await tool("respondToCartSuggestion", {
            cartId: input.cartId,
            suggestionId: input.suggestionId,
            decision: input.decision,
            ...(sub ? { original: sub.original.name, substitute: sub.substitute.name } : {}),
          }),
        );
      }
      case "order": {
        const review = (await tool("reviewCart", { cartId: input.cartId })).output as OrderSummary;
        if (!review.readyForApproval) throw new AgentError("VALIDATION_FAILED", review.blockers.join("; "));
        return Response.json(
          await tool("requestOrderApproval", { cartId: review.cartId, cartHash: review.cartHash, totalCents: review.totals.totalCents, deliveryWindowId: review.deliveryWindow!.id }),
        );
      }
      case "meals":
        return Response.json(await tool("suggestMeals", { mealType: "dinner" }));
      case "cook":
        return Response.json(await tool("startCooking", { recipeId: input.recipeId }));
      case "memory_correct":
        return Response.json(await care.correctMemory(ctx, input.factId, input.value));
      case "home_start": {
        const { action: _a, as: _as, recipient: _r, ...fields } = input;
        void _a;
        void _as;
        void _r;
        return Response.json(await tool("startHomeRepairRequest", fields));
      }
      case "home_choose_time":
        return Response.json(await tool("proposeHomeRepairBooking", { requestId: input.requestId, windowId: input.windowId }));
      case "memory_delete":
        return Response.json(await care.deleteMemory(ctx, input.factId));
    }
  } catch (err) {
    return errorResponse(err instanceof DoseTransitionError ? new AgentError("VALIDATION_FAILED", err.message) : err);
  }
}
