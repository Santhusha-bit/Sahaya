/**
 * The shared demo scenario (fictional data only, prompt global rule 4).
 *
 * Margaret; her real grandson Jake with a trusted phone; her daughter Sarah as a
 * caregiver holding `incidents:view`; and 11 past scam incidents (spread over ~7 months) so search and
 * the dashboard have history to show.
 */

import { id, now } from "@/lib/id";
import { getIncidentIndex, type IncidentSearchIndex } from "@/integrations/search";
import { runIncidentIndexJob } from "./incidentIndexer";
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

const DAY = 24 * 60 * 60 * 1000;

/** Past attempts, with how many days ago each happened (so answers carry real dates). */
const PAST_INCIDENTS: (Record<string, unknown> & { daysAgo: number })[] = [
  { daysAgo: 212, summary: "Gift card scam: caller claimed to be from Amazon security and said her account was hacked; asked for Google Play gift cards.", channel: "phone", riskLevel: "high", scamType: "gift_card", outcome: "scam_blocked" },
  { daysAgo: 187, summary: "Fake bank fraud alert text asking to 'verify' a transfer by replying with the verification code.", channel: "text", riskLevel: "high", scamType: "fake_bank", outcome: "scam_blocked" },
  { daysAgo: 160, summary: "Tech-support popup claiming the computer had a virus and asking for remote access.", channel: "other", riskLevel: "medium", scamType: "tech_support", outcome: "suspicious_verified" },
  { daysAgo: 141, summary: "Romance contact asked for money by wire transfer for a 'plane ticket'.", channel: "other", riskLevel: "high", scamType: "romance", outcome: "scam_blocked" },
  { daysAgo: 118, summary: "Prize notification: 'Congratulations, you won a cruise, pay the taxes first.'", channel: "email", riskLevel: "medium", scamType: "prize", outcome: "scam_blocked" },
  { daysAgo: 96, summary: "Fake grandchild call: 'Grandma, I'm in jail and need bail money right now, please keep it secret from Mom.'", channel: "phone", riskLevel: "critical", scamType: "fake_grandchild", outcome: "scam_confirmed" },
  { daysAgo: 74, summary: "IRS impersonation threatening arrest over back taxes unless paid immediately.", channel: "phone", riskLevel: "high", scamType: "fake_bank", outcome: "scam_blocked" },
  { daysAgo: 52, summary: "Medicare card 'reissue' call asking for the Medicare number.", channel: "phone", riskLevel: "high", scamType: "credential", outcome: "scam_blocked" },
  { daysAgo: 33, summary: "Crypto 'investment' promising guaranteed returns if she sends bitcoin.", channel: "email", riskLevel: "medium", scamType: "prize", outcome: "suspicious_verified" },
  { daysAgo: 21, summary: "Caller pretending to be her grandson said he was in a car accident and needed Target gift cards today; told her don't tell his parents.", channel: "phone", riskLevel: "critical", scamType: "fake_grandchild", outcome: "scam_confirmed" },
  { daysAgo: 9, summary: "Utility shutoff threat demanding a gift card payment immediately to keep the power on.", channel: "phone", riskLevel: "high", scamType: "gift_card", outcome: "scam_blocked" },
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

  for (const { daysAgo, ...inc } of PAST_INCIDENTS) {
    rows.push({
      namespace: "guardian",
      collection: "incidents",
      data: {
        ...inc,
        id: id("incident"),
        user: userId,
        receivedAt: now() - daysAgo * DAY,
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
 * flow indexes each incident as it is saved; this runs the same indexing job as a
 * backfill over everything already stored.
 */
export async function indexSeededIncidents(
  data: DataLayer,
  userId: string = MARGARET_USER,
  index: IncidentSearchIndex = getIncidentIndex(),
): Promise<number> {
  return (await runIncidentIndexJob(data, userId, index)).indexed;
}
