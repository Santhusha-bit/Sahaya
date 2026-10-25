import { z } from "zod";
import type { AgentTool } from "../base/types";
import { extractObservations } from "./extractObservations";
import { activeObservations, correctObservation, deleteObservation, saveObservation } from "./wellnessStore";
import { readConsent } from "./wellnessConsent";
import { runWellnessTurn } from "./wellnessWorkflow";
import { getTimeSeriesProvider } from "@/integrations/tigerdata";
import { getLongitudinalTrend } from "./longitudinalTrends";
import { syncWellnessTimeSeries } from "./timeSeriesSync";
import { updateHouseholdAnalytics } from "./householdAnalytics";
import { getVoiceProvider } from "@/integrations/cartesia";
import { getCurrentUser } from "@/lib/user";
import { auth0Status } from "@/lib/env";

export const wellnessTools: AgentTool[] = [
  {
    name: "startConversationalCheckIn",
    description: "Open a gentle daily check-in. Records that a check-in started and returns a natural opening question.",
    inputSchema: z.object({ topic: z.string().optional() }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save("checkIns", { topic: input.topic ?? "general", status: "open" }, { tags: ["checkin"] });
      const openers = [
        "How are you feeling today — really?",
        "What's been on your mind lately?",
        "Did anything bring you a little joy today?",
      ];
      return {
        ok: true,
        summary: "Check-in started.",
        data: { checkInId: rec.id, opener: openers[Math.floor(Math.random() * openers.length)] },
      };
    },
  },
  {
    name: "extractWellnessObservations",
    description:
      "Extract structured wellness observations (sleep, energy, mood, appetite, pain, social) from what the person said, using the Bitdeer inference provider when configured. Output is schema-validated and evidence-checked in code; invented numbers, diagnoses and medication advice are rejected. Accepted observations are saved to the canonical record with model provenance.",
    inputSchema: z.object({ text: z.string().min(1) }),
    async execute(input, ctx) {
      const consent = await readConsent(ctx);
      const result = await extractObservations({
        text: input.text,
        consent,
        audit: ctx.audit,
        correlationId: ctx.correlationId,
      });

      // Persist accepted observations (deduped) to the canonical store.
      const savedIds: string[] = [];
      let duplicates = 0;
      for (const obs of result.accepted) {
        const { stored, duplicate } = await saveObservation(ctx.memory, obs, {
          audit: ctx.audit,
          correlationId: ctx.correlationId,
        });
        if (duplicate) duplicates++;
        else savedIds.push(stored.recordId);
      }

      const acc = result.accepted.map((o) =>
        o.value !== undefined ? `${o.type}=${o.value}${o.unit ?? ""}` : `${o.type} (${o.description})`,
      );
      const summaryParts: string[] = [];
      if (acc.length) summaryParts.push(`Noted: ${acc.join(", ")}.`);
      if (result.needsConfirmation.length) summaryParts.push(`${result.needsConfirmation.length} to confirm.`);
      if (result.rejected.length) summaryParts.push(`${result.rejected.length} unsupported candidate(s) rejected.`);
      if (!summaryParts.length) summaryParts.push("No clear well-being observations in that message.");

      return {
        ok: true,
        summary: summaryParts.join(" "),
        data: {
          accepted: result.accepted,
          needsConfirmation: result.needsConfirmation,
          rejected: result.rejected.map((r) => ({ type: r.candidate.type, reason: r.reason, layer: r.layer })),
          savedIds,
          duplicates,
          provenance: result.provenance,
          concern: result.accepted.some((o) => ["mood", "sleep_quality", "pain", "appetite"].includes(o.type)),
        },
      };
    },
  },
  {
    name: "saveWellnessMemory",
    description: "Save a wellness observation or self-reported symptom to the longitudinal record.",
    inputSchema: z.object({
      note: z.string().min(1),
      category: z.enum(["mood", "sleep", "pain", "appetite", "social", "other"]).default("other"),
      valence: z.enum(["positive", "negative", "neutral"]).default("neutral"),
    }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save(
        "observations",
        { note: input.note, category: input.category, valence: input.valence },
        { tags: ["wellness", input.category] },
      );
      return { ok: true, summary: `Remembered a ${input.category} note.`, data: { observationId: rec.id } };
    },
  },
  {
    name: "analyzeLongitudinalPatterns",
    description: "Look across saved observations for trends over time (e.g. repeated poor sleep or growing isolation).",
    inputSchema: z.object({ category: z.enum(["mood", "sleep", "pain", "appetite", "social", "all"]).default("all") }),
    async execute(input, ctx) {
      const all = await ctx.memory.list("observations");
      const scoped = input.category === "all" ? all : all.filter((o) => o.data.category === input.category);
      const counts: Record<string, number> = {};
      let negative = 0;
      for (const o of scoped) {
        const cat = String(o.data.category ?? "other");
        counts[cat] = (counts[cat] ?? 0) + 1;
        if (o.data.valence === "negative") negative++;
      }
      const trend =
        scoped.length === 0 ? "not enough data yet" : negative >= 3 ? "worsening — several negative notes" : negative > 0 ? "mixed" : "stable/positive";
      return {
        ok: true,
        summary: `Pattern (${input.category}): ${trend}. ${scoped.length} observation(s).`,
        data: { counts, negative, total: scoped.length, trend },
      };
    },
  },
  {
    name: "generateWellnessSummary",
    description: "Generate a shareable well-being summary for family/caregivers from recent observations.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).default(7) }),
    async execute(input, ctx) {
      const since = Date.now() - input.days * 86400_000;
      const obs = (await ctx.memory.list("observations")).filter((o) => o.createdAt >= since);
      const positives = obs.filter((o) => o.data.valence === "positive").length;
      const negatives = obs.filter((o) => o.data.valence === "negative").length;
      const summaryText = obs.length
        ? `Over the last ${input.days} days: ${positives} positive and ${negatives} concerning note(s). Highlights: ${obs
            .slice(0, 3)
            .map((o) => o.data.note)
            .join("; ")}.`
        : `No wellness notes recorded in the last ${input.days} days.`;
      const rec = await ctx.memory.save("summaries", { text: summaryText, days: input.days }, { tags: ["summary"] });
      return { ok: true, summary: summaryText, data: { summaryId: rec.id } };
    },
  },
  {
    name: "scheduleFollowUp",
    description: "Schedule a follow-up check-in at a later time.",
    inputSchema: z.object({ when: z.string().min(1), reason: z.string().optional() }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save("followUps", { when: input.when, reason: input.reason, status: "scheduled" }, { tags: ["followup"] });
      return { ok: true, summary: `I'll check back in ${input.when}.`, data: { followUpId: rec.id } };
    },
  },
  {
    name: "requestCaregiverNotification",
    description:
      "Notify a caregiver about a well-being concern. Sensitive: requires the person's approval before anything is sent.",
    inputSchema: z.object({ concern: z.string().min(1), caregiver: z.string().default("primary caregiver") }),
    requiresApproval: true,
    approvalSummary: (input) => ({
      title: `Tell ${input.caregiver}`,
      description: `Wellness wants to share with ${input.caregiver}: "${input.concern}"`,
    }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save("caregiverNotices", { concern: input.concern, caregiver: input.caregiver, delivered: true });
      return { ok: true, summary: `Shared with ${input.caregiver}.`, data: { noticeId: rec.id } };
    },
  },
  {
    name: "arrangeFamilyCall",
    description: "Help arrange a call or visit with a family member.",
    inputSchema: z.object({ familyMember: z.string().min(1), when: z.string().optional() }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save("familyCalls", { familyMember: input.familyMember, when: input.when ?? "soon", status: "requested" });
      return { ok: true, summary: `I'll help set up a call with ${input.familyMember}${input.when ? ` ${input.when}` : ""}.`, data: { callId: rec.id } };
    },
  },
  {
    name: "escalateSafetyToGuardian",
    description:
      "Escalate an urgent safety concern to the Guardian agent (authorized cross-agent workflow). Use only for genuine safety issues.",
    inputSchema: z.object({
      summary: z.string().min(1).max(500),
      severity: z.enum(["low", "medium", "high", "critical"]).default("high"),
    }),
    async execute(input, ctx) {
      const res = await ctx.bus.publish({
        sourceAgent: "wellness",
        targetAgent: "guardian",
        type: "safety.escalation",
        userId: ctx.userId,
        correlationId: ctx.correlationId,
        payload: { summary: input.summary, severity: input.severity, observedBy: "wellness" },
      });
      return {
        ok: res.ok,
        summary: res.ok ? "Escalated to Guardian — they'll take it from here." : `Could not escalate: ${res.reason}`,
        data: { eventId: res.event.id, status: res.event.status },
        error: res.ok ? undefined : res.reason,
      };
    },
  },
  {
    name: "requestCareAssist",
    description:
      "Ask the Care agent for meal or grocery help on the person's behalf (authorized cross-agent workflow, with permission).",
    inputSchema: z.object({ kind: z.enum(["meal", "grocery"]), note: z.string().min(1).max(300) }),
    async execute(input, ctx) {
      const res = await ctx.bus.publish({
        sourceAgent: "wellness",
        targetAgent: "care",
        type: "care.assist",
        userId: ctx.userId,
        correlationId: ctx.correlationId,
        payload: { kind: input.kind, note: input.note },
      });
      return {
        ok: res.ok,
        summary: res.ok ? `Asked Care to help with ${input.kind}.` : `Could not reach Care: ${res.reason}`,
        data: { eventId: res.event.id, status: res.event.status },
        error: res.ok ? undefined : res.reason,
      };
    },
  },
  {
    name: "requestHumanAssistance",
    description:
      "Ask Guardian to coordinate a human helper (e.g. for groceries) when the person says they have no one to help. Authorized cross-agent workflow carried over the Fetch.ai bridge; records the person's consent first and sends only the minimum needed.",
    inputSchema: z.object({
      need: z.string().min(1).max(300),
      urgency: z.enum(["routine", "soon", "urgent"]).default("soon"),
    }),
    async execute(input, ctx) {
      const consent = await ctx.memory.save(
        "consents",
        { purpose: "human_assistance", need: input.need, grantedAt: Date.now() },
        { tags: ["consent"] },
      );
      const res = await ctx.bus.publish({
        sourceAgent: "wellness",
        targetAgent: "guardian",
        type: "assistance.request",
        userId: ctx.userId,
        correlationId: ctx.correlationId,
        payload: { need: input.need, urgency: input.urgency, consentRef: consent.id },
      });
      return {
        ok: res.ok,
        summary: res.ok
          ? "I've asked Guardian to help arrange a person to assist you, and they're coordinating it now."
          : `Could not reach Guardian: ${res.reason}`,
        data: { eventId: res.event.id, status: res.event.status, consentRef: consent.id },
        error: res.ok ? undefined : res.reason,
      };
    },
  },
  {
    name: "processWellnessConversation",
    description:
      "Run the full wellness turn for what the person just said: extract + validate observations (Bitdeer), store the canonical record (Convex), save continuity (Moss) and historical context (Backboard) if permitted, update the sleep/energy time series (Tiger Data), retrieve the trend, and produce a warm, non-diagnostic follow-up. External failures never corrupt the canonical record.",
    inputSchema: z.object({ text: z.string().min(1) }),
    async execute(input, ctx) {
      const consent = await readConsent(ctx);
      const result = await runWellnessTurn({
        text: input.text,
        memory: ctx.memory,
        userId: ctx.userId,
        consent,
        audit: ctx.audit,
        correlationId: ctx.correlationId,
      });
      const failed = result.syncs.filter((s) => !s.ok);
      return {
        ok: true,
        summary: `${result.followUp}${failed.length ? ` (note: ${failed.length} integration sync(s) failed and were skipped safely)` : ""}`,
        data: {
          saved: result.savedCount,
          duplicates: result.duplicates,
          accepted: result.extraction.accepted,
          needsConfirmation: result.extraction.needsConfirmation,
          rejected: result.extraction.rejected.map((r) => ({ type: r.candidate.type, reason: r.reason, layer: r.layer })),
          historical: result.historical.map((h) => ({ topic: h.context.topic, summary: h.context.summary })),
          sleepTrend: result.sleepTrend,
          energyTrend: result.energyTrend,
          sleepVsUsual: result.sleepHistory
            ? { narrative: result.sleepHistory.narrative, comparison: result.sleepHistory.comparison, confidence: result.sleepHistory.uncertainty.confidence }
            : null,
          syncs: result.syncs,
          followUp: result.followUp,
        },
      };
    },
  },
  {
    name: "reviewRememberedObservations",
    description: "List what Wellness currently remembers (active observations) so the person can review it. Deleted items are not shown.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    async execute(input, ctx) {
      const all = await activeObservations(ctx.memory);
      const items = all.slice(-input.limit).reverse();
      return {
        ok: true,
        summary: items.length ? `You have ${items.length} remembered observation(s).` : "I'm not holding any observations yet.",
        data: {
          items: items.map((o) => ({
            id: o.id,
            recordId: o.recordId,
            type: o.type,
            value: o.value,
            unit: o.unit,
            description: o.description,
            requiresConfirmation: o.requiresConfirmation,
            evidence: o.evidence,
            provenance: o.provenance,
            createdAt: o.createdAt,
            correctedAt: o.correctedAt,
          })),
        },
      };
    },
  },
  {
    name: "correctRememberedObservation",
    description: "Correct a remembered observation in place (the person's words win). Keeps history and provenance; readers only see the corrected value afterward.",
    inputSchema: z.object({
      recordId: z.string().min(1),
      description: z.string().max(200).optional(),
      value: z.number().optional(),
      unit: z.enum(["hours", "minutes"]).optional(),
    }),
    async execute(input, ctx) {
      const updated = await correctObservation(
        ctx.memory,
        input.recordId,
        { description: input.description, value: input.value, unit: input.unit },
        { audit: ctx.audit, correlationId: ctx.correlationId },
      );
      if (!updated) return { ok: false, summary: "I couldn't find that to correct.", error: "not_found" };
      // Propagate the correction to the Tiger Data mirror (non-fatal if it fails).
      const sync = await syncWellnessTimeSeries({ memory: ctx.memory, userId: ctx.userId, consent: await readConsent(ctx), audit: ctx.audit, correlationId: ctx.correlationId });
      return { ok: true, summary: "Thank you — I've corrected that.", data: { recordId: updated.recordId, version: updated.version, timeSeriesSync: sync.status } };
    },
  },
  {
    name: "forgetRememberedObservation",
    description: "Delete a remembered observation at the person's request. It is removed from everything the person and caregivers see, and from trends and analytics.",
    inputSchema: z.object({ recordId: z.string().min(1) }),
    async execute(input, ctx) {
      const ok = await deleteObservation(ctx.memory, input.recordId, { audit: ctx.audit, correlationId: ctx.correlationId });
      // Remove it from the Tiger Data mirror too, so it leaves every trend.
      const sync = ok
        ? await syncWellnessTimeSeries({ memory: ctx.memory, userId: ctx.userId, consent: await readConsent(ctx), audit: ctx.audit, correlationId: ctx.correlationId })
        : null;
      return ok
        ? { ok: true, summary: "I've forgotten that, as you asked.", data: { recordId: input.recordId, timeSeriesSync: sync?.status } }
        : { ok: false, summary: "I couldn't find that to forget.", error: "not_found" };
    },
  },
  {
    name: "getWellnessTrends",
    description:
      "Get weekly or monthly sleep and energy trends from the time series (Tiger Data), comparing the current period with the person's own history. Returns averages with observation counts, the evidence behind them, and explicit uncertainty. Descriptive only, never a medical judgement.",
    inputSchema: z.object({ granularity: z.enum(["weekly", "monthly"]).default("weekly") }),
    async execute(input, ctx) {
      // Run the sync job first so the mirror reflects the current canonical record.
      const consent = await readConsent(ctx);
      const sync = await syncWellnessTimeSeries({ memory: ctx.memory, userId: ctx.userId, consent, audit: ctx.audit, correlationId: ctx.correlationId });
      if (sync.status === "purged_no_consent") {
        return { ok: true, summary: "Trend tracking is turned off in your privacy settings, so I'm not keeping a time series.", data: { sync } };
      }
      const [sleep, energy] = await Promise.all(
        (["sleep", "energy"] as const).map((metric) =>
          getLongitudinalTrend({ memory: ctx.memory, userId: ctx.userId, metric, granularity: input.granularity, consent }),
        ),
      );
      return {
        ok: true,
        summary: `${sleep.narrative} (confidence: ${sleep.uncertainty.confidence})`,
        data: { sleep, energy, sync, backend: getTimeSeriesProvider().backend },
      };
    },
  },
  {
    name: "updateHouseholdAnalytics",
    description:
      "Publish this month's authorized, de-identified household aggregates (averages and counts only — never raw conversations) to Snowflake, if the person consents. If analytics consent is off, previously published aggregates are withdrawn.",
    inputSchema: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
    async execute(input, ctx) {
      const consent = await readConsent(ctx);
      const res = await updateHouseholdAnalytics({
        memory: ctx.memory,
        userId: ctx.userId,
        consent,
        period: input.period,
        audit: ctx.audit,
        correlationId: ctx.correlationId,
      });
      return { ok: res.ok, summary: res.detail, data: res };
    },
  },
  {
    name: "speakWellnessReply",
    description:
      "Speak a warm, non-diagnostic reply aloud for the person, using Cartesia voice synthesis when configured. Live Cartesia returns audio the client plays; otherwise a sandbox result tells the client to speak it with the browser's SpeechSynthesis. A voice failure never blocks the conversation or touches the canonical record.",
    inputSchema: z.object({ text: z.string().min(1).max(2000) }),
    async execute(input, ctx) {
      const voice = getVoiceProvider();
      let result;
      try {
        result = await voice.speak(input.text);
      } catch (err) {
        // Voice is never allowed to break the turn — report honestly and move on.
        result = {
          ok: false,
          mode: "sandbox" as const,
          spoken: input.text.slice(0, 2000),
          playback: "browser-speech-synthesis" as const,
          detail: `Voice synthesis failed safely: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await ctx.audit?.record({
        actor: "wellness",
        action: "wellness.speak",
        correlationId: ctx.correlationId,
        detail: { backend: voice.backend, mode: result.mode, ok: result.ok, chars: result.spoken.length },
      });
      return {
        ok: true,
        summary: result.ok ? "Spoken with Cartesia voice." : "Prepared for the browser to speak.",
        data: {
          backend: voice.backend,
          mode: result.mode,
          spoken: result.spoken,
          playback: result.playback,
          audioBase64: result.audioBase64,
          contentType: result.contentType,
          detail: result.detail,
        },
      };
    },
  },
  {
    name: "confirmWellnessIdentity",
    description:
      "Confirm who Wellness is speaking with and under what authentication. The agent runs with the authenticated userId provided by the runtime; this reports that identity and whether it came from a live Auth0 session or the sandbox demo user, so sensitive actions are honestly attributed to the right person. Makes no direct Auth0 calls.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const user = getCurrentUser();
      const auth = auth0Status();
      await ctx.audit?.record({
        actor: "wellness",
        action: "wellness.identity",
        correlationId: ctx.correlationId,
        detail: { userId: ctx.userId, authMode: user.authMode, auth: auth.mode },
      });
      return {
        ok: true,
        summary:
          user.authMode === "live"
            ? `Speaking with ${user.name} (verified Auth0 session).`
            : `Speaking with ${user.name} (sandbox demo user — Auth0 not configured).`,
        data: {
          userId: ctx.userId,
          name: user.name,
          role: user.role,
          authMode: user.authMode,
          auth: { mode: auth.mode, detail: auth.detail },
        },
      };
    },
  },
];
