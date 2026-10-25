import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { setConsent } from "@/agents/consent";
import { CRS_FIXTURES } from "@/integrations/crsFixtures";
import { CrsError, LiveCrsClient, SandboxCrsClient, buildRequest, type CrsClient } from "@/integrations/crs";
import { runCreditReview } from "@/agents/finance/credit/creditReview";
import { interpretCreditData } from "@/agents/finance/credit/creditInterpret";
import { explainCreditReview, validateExplanation } from "@/agents/finance/credit/creditExplain";
import { findTestIdentity, testIdentities } from "@/agents/finance/credit/testIdentities";

const USER = "user-credit";
const P13 = findTestIdentity("P13")!;

async function finance() {
  const data = createInMemoryDataLayer();
  const agent = createAgent("finance", { data, userId: USER });
  await agent.initialize();
  return { data, agent };
}

function ctxOf(agent: unknown) {
  return (agent as { buildContext: (c: string, l: (s: string) => void) => any }).buildContext("corr-test", () => {});
}

afterEach(() => {
  delete process.env.CRS_TEST_PERSONAS;
  delete process.env.CRS_LINKED_PERSONA;
});

describe("CRS credit review: end-to-end (sandbox)", () => {
  it("needs approval, then requests CRS data, interprets, explains, recommends, and audits", async () => {
    const { data, agent } = await finance();

    const deferred = await agent.executeTool("reviewCreditAndIdentity", {});
    expect(deferred.record.status).toBe("awaiting_approval");
    expect((await agent.audit.list()).some((e) => e.action.startsWith("crs."))).toBe(false);

    const { result } = await agent.executeTool("reviewCreditAndIdentity", {}, { approved: true });
    expect(result.ok).toBe(true);
    const d = result.data as any;
    expect(d.mode).toBe("sandbox");
    expect(d.overall).toBe("attention");
    expect(d.requests.map((r: any) => r.endpoint)).toEqual([
      "/transunion/credit-report/standard/tu-prequal-fico9",
      "/transunion/identity-manager-verification/basic",
      "/fraud-finder/fraud-finder",
    ]);

    const ids = d.findings.map((f: any) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["inquiry-burst", "identity-mismatch", "contact-fraud-signals", "possible-identity-misuse", "credit-score"]));
    const burst = d.findings.find((f: any) => f.id === "inquiry-burst");
    expect(burst.title).toContain("9 credit inquiries");
    expect(d.facts.score).toBe(640);
    expect(d.nextSteps.map((s: any) => s.id)).toEqual(expect.arrayContaining(["confirm-inquiries", "consider-freeze", "ftc-plan"]));
    expect(result.summary).toContain("not proof of fraud");
    expect(result.summary).not.toMatch(/bank transaction/i);

    const actions = (await agent.audit.list()).map((e) => e.action);
    expect(actions).toEqual([
      "credit.review.requested",
      "credit.review.authorization",
      "crs.request",
      "crs.request",
      "crs.request",
      "credit.review.interpreted",
      "credit.review.explained",
      "credit.review.completed",
    ]);

    // The raw SSN is never persisted anywhere (memory, audit, tasks).
    const everything = JSON.stringify(await data.memory.list({ namespace: "finance", userId: USER })) +
      JSON.stringify(await agent.audit.list()) +
      JSON.stringify(await data.tasks.list({ userId: USER }));
    expect(everything).not.toContain("666701013");
    expect(everything).toContain("***-**-1013");
  });

  it("a second review reports change status against the first", async () => {
    const { agent } = await finance();
    await agent.executeTool("reviewCreditAndIdentity", {}, { approved: true });
    const second = await agent.executeTool("reviewCreditAndIdentity", {}, { approved: true });
    expect((second.result.data as any).findings.map((f: any) => f.id)).toContain("no-change");
    const history = await agent.executeTool("listCreditReviews", {});
    expect((history.result.data as any).reviews).toHaveLength(2);
    expect((history.result.data as any).auditTrail.length).toBeGreaterThanOrEqual(16);
  });

  it("the sandbox chat planner routes credit worries to an approval request", async () => {
    const { agent } = await finance();
    await agent.processMessage("Is someone applying for credit in my name?");
    const approvals = await agent.approvalService.list();
    expect(approvals.some((a: any) => a.toolName === "reviewCreditAndIdentity" && a.status === "pending")).toBe(true);
  });
});

describe("CRS credit review: authorization is enforced in code", () => {
  it("refuses a persona that is not linked to the account, before any CRS call", async () => {
    const { agent } = await finance();
    const r = await agent.executeTool("reviewCreditAndIdentity", { personaId: "P05" }, { approved: true });
    expect(r.result.ok).toBe(false);
    expect(r.result.error).toBe("not_linked_persona");
    const audit = await agent.audit.list();
    expect(audit.find((e) => e.action === "credit.review.authorization")?.detail).toMatchObject({ allowed: false });
    expect(audit.some((e) => e.action === "crs.request")).toBe(false);
  });

  it("refuses when the person has switched credit reviews off", async () => {
    const { data, agent } = await finance();
    await setConsent(data, USER, { financeCreditReview: false });
    const r = await agent.executeTool("reviewCreditAndIdentity", {}, { approved: true });
    expect(r.result.error).toBe("consent_off");
  });

  it("never accepts a non-test SSN from configuration", () => {
    process.env.CRS_TEST_PERSONAS = JSON.stringify({
      P05: { firstName: "REAL", lastName: "PERSON", ssn: "123456789", address: { addressLine1: "1 A ST", city: "X", state: "CA", postalCode: "95000" } },
      P06: { firstName: "TEST", lastName: "PERSONA", ssn: "666000006", address: { addressLine1: "1 A ST", city: "X", state: "CA", postalCode: "95000" } },
    });
    const all = testIdentities();
    expect(all.P05).toBeUndefined();
    expect(all.P06?.ssn).toBe("666000006");
  });

  it("rate-limits repeated pulls", async () => {
    const { agent } = await finance();
    for (let i = 0; i < 5; i++) expect((await agent.executeTool("reviewCreditAndIdentity", {}, { approved: true })).result.ok).toBe(true);
    const sixth = await agent.executeTool("reviewCreditAndIdentity", {}, { approved: true });
    expect(sixth.result.error).toBe("rate_limited");
  });

  it("a CRS failure is audited and partial data still produces a review", async () => {
    const { agent } = await finance();
    const sandbox = new SandboxCrsClient();
    const flaky: CrsClient = {
      mode: "sandbox",
      async call(product, subject) {
        if (product === "fraud_finder") throw new CrsError("rate limit", "rate_limited", 429);
        return sandbox.call(product, subject);
      },
    };
    const r = await runCreditReview(ctxOf(agent), { purpose: "identity_protection_review", products: ["credit_report", "identity_verification", "fraud_finder"] }, { client: flaky });
    expect(r.ok).toBe(true);
    expect((r.data as any).failures).toHaveLength(1);
    expect((await agent.audit.list()).some((e) => e.action === "crs.request.failed")).toBe(true);
  });
});

describe("CRS live client (mocked HTTP)", () => {
  function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }
  const cfg = { baseUrl: "https://api-sandbox.stitchcredit.com/api", tuConfig: "tu-prequal-fico9", fraudConfig: "fraud-finder", timeoutMs: 5000 };

  it("logs in, sends the documented request with a bearer token, and re-logs in on 401", async () => {
    const { impl, calls } = mockFetch([
      { status: 200, body: { token: "t1" } },
      { status: 401, body: {} },
      { status: 200, body: { token: "t2" } },
      { status: 200, body: CRS_FIXTURES.P13.credit_report, headers: { RequestID: "req-123" } },
    ]);
    const client = new LiveCrsClient({ username: "u", password: "p" }, cfg, impl);
    const r = await client.call("credit_report", P13);
    expect(calls.map((c) => c.url)).toEqual([
      `${cfg.baseUrl}/users/login`,
      `${cfg.baseUrl}/transunion/credit-report/standard/tu-prequal-fico9`,
      `${cfg.baseUrl}/users/login`,
      `${cfg.baseUrl}/transunion/credit-report/standard/tu-prequal-fico9`,
    ]);
    expect((calls[3].init.headers as Record<string, string>).Authorization).toBe("Bearer t2");
    const sent = JSON.parse(String(calls[3].init.body));
    expect(sent).toMatchObject({ firstName: "KAYLA", lastName: "BRENNAN", ssn: "666701013" });
    expect(sent.addresses[0]).toMatchObject({ addressLine1: "9021 KINGSTON PIKE", borrowerResidencyType: "Current" });
    expect(r.mode).toBe("live");
    expect(r.requestId).toBe("req-123");
    expect(r.requestBody.ssn).toBe("***-**-1013");
  });

  it("maps HTTP 429 to a rate-limit error", async () => {
    const { impl } = mockFetch([{ status: 200, body: { token: "t" } }, { status: 429, body: {}, headers: { "Retry-After": "12" } }]);
    const client = new LiveCrsClient({ username: "u", password: "p" }, cfg, impl);
    await expect(client.call("fraud_finder", P13)).rejects.toMatchObject({ code: "rate_limited", retryAfterSec: 12 });
  });

  it("refuses any host other than the CRS sandbox", () => {
    expect(() => new LiveCrsClient({ username: "u", password: "p" }, { ...cfg, baseUrl: "https://api.stitchcredit.com/api" })).toThrow(/sandbox/);
  });

  it("builds documented bodies for identity verification and FraudFinder", () => {
    expect(buildRequest("identity_verification", P13, cfg).body).toMatchObject({ street1: "9021 KINGSTON PIKE", zip: "37923", dob: "1999-12-24" });
    expect(buildRequest("fraud_finder", P13, cfg).body).toMatchObject({ email: "kb.9921x@example.com", address: { postalCode: "37923" } });
  });
});

describe("interpretation and guarded explanation", () => {
  const base = () =>
    interpretCreditData({
      creditReport: CRS_FIXTURES.P13.credit_report,
      identityVerification: CRS_FIXTURES.P13.identity_verification,
      fraudFinder: CRS_FIXTURES.P13.fraud_finder,
    });

  it("detects changes against a previous snapshot", () => {
    const first = base();
    const previous = { ...first.snapshot, asOf: "2026-08-01", score: 690, inquiryKeys: first.snapshot.inquiryKeys.slice(0, 2) };
    const second = interpretCreditData({ creditReport: CRS_FIXTURES.P13.credit_report, previous });
    const change = second.findings.find((f) => f.id === "change-since-last-review")!;
    expect(change.detail).toContain("score moved from 690 to 640");
    expect(change.detail).toContain("7 new inquiry(ies)");
    expect(change.severity).toBe("medium");
  });

  it("rejects drafts that invent numbers, cite unknown findings, or claim bank monitoring", () => {
    const interp = base();
    expect(validateExplanation("Your score is 712 [credit-score].", interp).join()).toMatch(/712/);
    expect(validateExplanation("Something [made-up].", interp).join()).toMatch(/unknown finding/);
    expect(validateExplanation("We checked your bank transactions [inquiry-burst].", interp).join()).toMatch(/bank/);
    expect(validateExplanation("This confirms identity theft [inquiry-burst].", interp).join()).toMatch(/confirmed/);
  });

  it("uses Claude's draft when it passes and the template when it does not", async () => {
    const interp = base();
    const good =
      "There were 9 credit inquiries in a short time [inquiry-burst]. Together with the other signs this looks like someone may be applying for credit in your name [possible-identity-misuse]. TransUnion could not fully match your details [identity-mismatch]. The phone linked to these records looks risky [contact-fraud-signals].";
    const ok = await explainCreditReview(interp, "sandbox", { draft: async () => good });
    expect(ok.source).toBe("claude");
    expect(ok.text).toContain("not proof of fraud");

    const bad = await explainCreditReview(interp, "sandbox", { draft: async () => "Your bank account shows fraud [inquiry-burst]." });
    expect(bad.source).toBe("template");
    expect(bad.rejectedReasons.length).toBeGreaterThan(0);
    expect(bad.text).toContain("[inquiry-burst]");
  });
});
