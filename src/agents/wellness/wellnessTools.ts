import { z } from "zod";
import type { AgentTool } from "../base/types";

const SIGNALS: { key: string; pattern: RegExp; valence: "positive" | "negative" | "neutral" }[] = [
  { key: "sleep_poor", pattern: /can'?t sleep|trouble sleeping|awake all night|insomnia|tired/i, valence: "negative" },
  { key: "sleep_good", pattern: /slept well|good sleep|rested/i, valence: "positive" },
  { key: "mood_low", pattern: /sad|lonely|down|blue|depressed|cry|hopeless/i, valence: "negative" },
  { key: "mood_good", pattern: /happy|good day|cheerful|enjoyed|grateful/i, valence: "positive" },
  { key: "pain", pattern: /pain|hurts|ache|sore/i, valence: "negative" },
  { key: "appetite_low", pattern: /not eating|no appetite|skipped meal|not hungry/i, valence: "negative" },
  { key: "social", pattern: /visit|called|saw|friend|family|grandkid|church|neighbor/i, valence: "positive" },
  { key: "isolation", pattern: /alone|nobody|no one|isolated|haven'?t seen anyone/i, valence: "negative" },
];

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
    description: "Extract mood, sleep, pain, appetite and social signals from what the person said.",
    inputSchema: z.object({ text: z.string().min(1) }),
    async execute(input) {
      const observations = SIGNALS.filter((s) => s.pattern.test(input.text)).map((s) => ({ signal: s.key, valence: s.valence }));
      const concern = observations.some((o) => o.valence === "negative");
      return {
        ok: true,
        summary: observations.length
          ? `Noticed: ${observations.map((o) => o.signal).join(", ")}.`
          : "No strong well-being signals in that message.",
        data: { observations, concern },
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
];
