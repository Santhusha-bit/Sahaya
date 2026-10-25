import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { InMemorySearchIndex, redactPII, setIncidentIndex } from "@/integrations/search";
import {
  MARGARET_SCAM_MESSAGE,
  MARGARET_USER,
  indexSeededIncidents,
  seedMargaretScenario,
} from "@/agents/guardian/scamScenario";
import { indexIncident, runIncidentIndexJob, toIncidentDoc } from "@/agents/guardian/incidentIndexer";
import { NOT_SAME_CALLER, summarizeIncidentMatches, validateSummary } from "@/agents/guardian/incidentSummary";
import { detectSignals } from "@/agents/guardian/scamSignals";
import { setConsent } from "@/agents/consent";

let index: InMemorySearchIndex;

beforeEach(() => {
  index = new InMemorySearchIndex();
  setIncidentIndex(index);
});

async function seeded() {
  const data = createInMemoryDataLayer();
  await seedMargaretScenario(data, MARGARET_USER);
  await indexSeededIncidents(data, MARGARET_USER, index);
  const guardian = createAgent("guardian", { data, userId: MARGARET_USER });
  await guardian.initialize();
  return { data, guardian };
}

describe("incident search (Track 4)", () => {
  it("redacts PII before indexing", () => {
    const red = redactPII("Call 1-800-555-0199, SSN 123-45-6789, pay $2,000, email me@x.com");
    expect(red).not.toMatch(/555-0199/);
    expect(red).not.toMatch(/123-45-6789/);
    expect(red).not.toMatch(/2,000/);
    expect(red).not.toMatch(/me@x\.com/);
  });

  it("ranks the correct past incident first for 3 different queries, citing ids", async () => {
    await seeded();
    const cases: { query: string; expect: RegExp }[] = [
      { query: "fake grandchild asking for bail money", expect: /grandchild|bail/i },
      { query: "IRS arrest over back taxes", expect: /irs|arrest|taxes/i },
      { query: "Amazon security gift card", expect: /amazon/i },
    ];
    for (const c of cases) {
      const hits = await index.search({ query: c.query, userId: MARGARET_USER, limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].snippet).toMatch(c.expect);
      expect(hits[0].doc.incidentId).toBeTruthy();
    }
  });

  it("the Guardian tool answers with a cited incident id", async () => {
    const { guardian } = await seeded();
    const { result } = await guardian.executeTool("searchPastIncidents", {
      query: "someone impersonating my grandson for gift cards",
    });
    const d = result.data as { hits: any[] };
    expect(d.hits.length).toBeGreaterThan(0);
    expect(result.summary).toContain(d.hits[0].incidentId);
  });

  it("search is scoped to the caller's own incidents", async () => {
    await seeded();
    const other = await index.search({ query: "gift card", userId: "someone-else", limit: 5 });
    expect(other).toHaveLength(0);
  });

  it("a freshly screened incident becomes searchable", async () => {
    const { guardian } = await seeded();
    await guardian.executeTool("screenInboundMessage", {
      content: MARGARET_SCAM_MESSAGE, channel: "phone", claimant: "Jake",
    });
    const hits = await index.search({ query: "grandson gift cards trouble", userId: MARGARET_USER, limit: 5 });
    // The just-screened incident is the fake-grandchild type and should surface.
    expect(hits.some((h) => h.doc.scamType === "fake_grandchild")).toBe(true);
  });
});

describe("incident indexing job (Track 4)", () => {
  it("projects only allowlisted, redacted fields into the index", () => {
    const doc = toIncidentDoc(
      {
        id: "incident_abc",
        channel: "phone",
        riskLevel: "high",
        outcome: "scam_blocked",
        receivedAt: 1_700_000_000_000,
        rawMessage: "It's Jake, call me at 415-555-0199 and send $500 in gift cards",
        verification: { contact: "Jake", phone: "+1-555-0133" },
        visibility: { caregiversAlerted: ["Sarah"] },
        policyDecisions: [{ effect: "block" }],
      },
      "u1",
    )!;
    expect(Object.keys(doc).sort()).toEqual(
      ["channel", "incidentId", "outcome", "receivedAt", "riskLevel", "scamType", "signals", "tactics", "text", "userId"].sort(),
    );
    expect(JSON.stringify(doc)).not.toMatch(/555-0199|555-0133|\$500|Sarah/);
    expect(doc.signals).toContain("gift_card");
  });

  it("indexes nothing when the person has turned incident search off", async () => {
    const data = createInMemoryDataLayer();
    await seedMargaretScenario(data, MARGARET_USER);
    await setConsent(data, MARGARET_USER, { guardianIncidentSearch: false });
    const job = await runIncidentIndexJob(data, MARGARET_USER, index);
    expect(job.indexed).toBe(0);
    expect(await index.search({ query: "gift card", userId: MARGARET_USER })).toHaveLength(0);
  });

  it("an index outage is reported, not thrown", async () => {
    const broken = {
      backend: "elastic" as const,
      index: async () => {
        throw new Error("503");
      },
      search: async () => [],
      removeUser: async () => {},
      clear: async () => {},
    };
    const r = await indexIncident({ id: "incident_x", summary: "gift card scam" }, { userId: "u1", permitted: true, index: broken });
    expect(r.status).toBe("failed");
  });
});

describe("'has someone tried this scam before?' (Track 4)", () => {
  it("retrieves the most relevant past attempt for today's message, not itself", async () => {
    const { guardian } = await seeded();
    const screened = await guardian.executeTool("screenInboundMessage", {
      content: MARGARET_SCAM_MESSAGE, channel: "phone", claimant: "Jake",
    });
    const todayId = (screened.result.data as { incidentId: string }).incidentId;
    const { result } = await guardian.executeTool("searchPastIncidents", { query: MARGARET_SCAM_MESSAGE, excludeIncidentId: todayId });
    const d = result.data as { hits: any[] };
    expect(d.hits.map((h) => h.incidentId)).not.toContain(todayId);
    expect(d.hits[0].scamType).toBe("fake_grandchild");
    expect(d.hits[0].snippet).toMatch(/gift cards/i);
    expect(d.hits[0].sharedTactics.length).toBeGreaterThanOrEqual(3);
    expect(result.summary).toContain(d.hits[0].incidentId);
    expect(result.summary).toContain(d.hits[0].date);
    expect(result.summary).toContain(NOT_SAME_CALLER);
  });

  async function hitsFor(query: string) {
    await seeded();
    const signals = detectSignals(query).signals.map((s) => s.code);
    return index.search({ query, userId: MARGARET_USER, signals });
  }

  it("accepts a grounded Claude summary and appends the caveat in code", async () => {
    const hits = await hitsFor(MARGARET_SCAM_MESSAGE);
    const top = hits[0].doc.incidentId;
    const s = await summarizeIncidentMatches({
      question: MARGARET_SCAM_MESSAGE,
      hits,
      generate: async () => `Yes. Someone posing as a grandson asked for gift cards before [${top}].`,
    });
    expect(s.by).toBe("claude");
    expect(s.text.endsWith(NOT_SAME_CALLER)).toBe(true);
    expect(s.citedIncidentIds).toContain(top);
  });

  it("rejects a Claude summary that claims it is the same caller", async () => {
    const hits = await hitsFor(MARGARET_SCAM_MESSAGE);
    const s = await summarizeIncidentMatches({
      question: MARGARET_SCAM_MESSAGE,
      hits,
      generate: async () => `This is the same scammer who called before [${hits[0].doc.incidentId}].`,
    });
    expect(s.by).toBe("template");
    expect(s.rejected).toMatch(/same caller/);
  });

  it("rejects a Claude summary that cites an incident it was not given", async () => {
    const hits = await hitsFor(MARGARET_SCAM_MESSAGE);
    const s = await summarizeIncidentMatches({
      question: MARGARET_SCAM_MESSAGE,
      hits,
      generate: async () => `Yes, see [${hits[0].doc.incidentId}] and [incident_madeup123].`,
    });
    expect(s.by).toBe("template");
    expect(s.rejected).toMatch(/unknown incident/);
  });

  it("allows a negated mention of the same caller", () => {
    const hit = { doc: { incidentId: "incident_a" }, sharedSignals: [] } as any;
    expect(validateSummary("We can't know if it was the same person [incident_a].", [hit])).toBeNull();
  });
});
