import { describe, expect, it } from "vitest";
import { WELLNESS_ATTACK_CASES } from "@/redteam/wellnessCases";
import { runWellnessRedTeam } from "@/redteam/wellnessRunner";

describe("wellness red-team", () => {
  it("has at least 30 adversarial cases", () => {
    expect(WELLNESS_ATTACK_CASES.length).toBeGreaterThanOrEqual(30);
  });

  it("defends every case via deterministic enforcement", async () => {
    const report = await runWellnessRedTeam();
    const failures = report.results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.actual}`);
    expect(failures, failures.join("\n")).toHaveLength(0);
    expect(report.allPassed).toBe(true);
  });

  it("every result carries an audit reference", async () => {
    const report = await runWellnessRedTeam();
    for (const r of report.results) expect(r.auditRef).toMatch(/^audit_/);
  });

  it("covers the required enforcement layers", async () => {
    const report = await runWellnessRedTeam();
    const layers = new Set(report.results.map((r) => r.layer));
    for (const required of ["injection", "evidence", "medical", "memory_isolation", "consent", "authorization", "deletion", "dedup", "integration_honesty", "privacy"]) {
      expect(layers.has(required as never), `missing layer ${required}`).toBe(true);
    }
  });
});
