/**
 * The shared demo scenario (fictional data only, prompt global rule 4).
 *
 * Margaret; her real grandson Jake with a trusted phone; her daughter Sarah as a
 * caregiver holding `incidents:view`; and 8-10 past scam incidents so search and
 * the dashboard have history to show.
 */

import { id, now } from "@/lib/id";
import { getIncidentIndex, redactPII, type IncidentSearchIndex } from "@/integrations/search";
import { INCIDENTS_VIEW } from "./scamPolicy";
import type { DataLayer } from "../base/types";

export const MARGARET_USER = "demo-margaret";

export const MARGARET_SCAM_MESSAGE =
  "Grandma it's Jake, I'm in trouble. Please send $2,000 in gift cards today and don't tell mom.";

interface SeedMem {
  namespace: "guardian" | "shared";
  collection: string;
  data: Record<string, unknown>;
  tags?: string[];
}

const PAST_INCIDENTS: Record<string, unknown>[] = [
  { summary: "Gift card scam: caller claimed to be from Amazon security.", channel: "phone", riskLevel: "high", scamType: "gift_card", outcome: "scam_blocked" },
  { summary: "Fake bank fraud alert text asking to 'verify' a transfer.", channel: "text", riskLevel: "high", scamType: "fake_bank", outcome: "scam_blocked" },
  { summary: "Tech-support popup claiming the computer had a virus.", channel: "other", riskLevel: "medium", scamType: "tech_support", outcome: "suspicious_verified" },
  { summary: "Romance contact asked for money for a 'plane ticket'.", channel: "other", riskLevel: "high", scamType: "romance", outcome: "scam_blocked" },
  { summary: "Prize notification: 'You won a cruise, pay the taxes first.'", channel: "email", riskLevel: "medium", scamType: "prize", outcome: "scam_blocked" },
  { summary: "Fake grandchild call asking for bail money.", channel: "phone", riskLevel: "critical", scamType: "fake_grandchild", outcome: "scam_confirmed" },
  { summary: "IRS impersonation threatening arrest over back taxes.", channel: "phone", riskLevel: "high", scamType: "fake_bank", outcome: "scam_blocked" },
  { summary: "Medicare card 'reissue' asking for the Medicare number.", channel: "phone", riskLevel: "high", scamType: "tech_support", outcome: "scam_blocked" },
  { summary: "Crypto 'investment' promising guaranteed returns.", channel: "email", riskLevel: "medium", scamType: "prize", outcome: "suspicious_verified" },
  { summary: "Utility shutoff threat demanding immediate gift-card payment.", channel: "phone", riskLevel: "high", scamType: "gift_card", outcome: "scam_blocked" },
];

/** Seed (idempotent-ish: callers use a fresh data layer per demo/test run). */
export async function seedMargaretScenario(data: DataLayer, userId: string = MARGARET_USER): Promise<void> {
  const rows: SeedMem[] = [
    {
      namespace: "shared",
      collection: "trustedContacts",
      data: { name: "Jake", relationship: "grandson", phone: "+1-555-0133", channel: "phone" },
      tags: ["trusted"],
    },
    {
      namespace: "shared",
      collection: "trustedContacts",
      data: { name: "Sarah", relationship: "daughter", phone: "+1-555-0177", channel: "phone" },
      tags: ["trusted"],
    },
    {
      namespace: "shared",
      collection: "caregivers",
      data: { name: "Sarah", relationship: "daughter", channel: "sms", permissions: [INCIDENTS_VIEW] },
      tags: ["caregiver"],
    },
  ];

  for (const inc of PAST_INCIDENTS) {
    rows.push({
      namespace: "guardian",
      collection: "incidents",
      data: {
        ...inc,
        id: id("incident"),
        user: userId,
        receivedAt: now(),
        status: "resolved",
        past: true,
      },
      tags: ["incident", "history"],
    });
  }

  for (const r of rows) {
    await data.memory.put({
      id: id("mem"),
      namespace: r.namespace,
      collection: r.collection,
      userId,
      data: r.data,
      tags: r.tags,
      createdAt: now(),
      updatedAt: now(),
    });
  }
}

/**
 * Index the seeded past incidents so the search demo/tests have history. The live
 * flow indexes each incident as it is created; this backfills the pre-seeded ones.
 */
export async function indexSeededIncidents(
  data: DataLayer,
  userId: string = MARGARET_USER,
  index: IncidentSearchIndex = getIncidentIndex(),
): Promise<number> {
  const rows = await data.memory.list({ namespace: "guardian", userId, collection: "incidents" });
  let count = 0;
  for (const r of rows) {
    const d = r.data;
    const summary = String(d.summary ?? "");
    if (!summary) continue;
    await index.index({
      incidentId: String(d.id ?? r.id),
      userId,
      channel: String(d.channel ?? "other"),
      scamType: String(d.scamType ?? "unknown"),
      riskLevel: String(d.riskLevel ?? "medium"),
      receivedAt: Number(d.receivedAt ?? r.createdAt),
      text: redactPII(summary),
      signals: [],
    });
    count++;
  }
  return count;
}
