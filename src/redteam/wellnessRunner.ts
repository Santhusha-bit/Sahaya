/**
 * Wellness red-team runner (Part 5, Track C).
 *
 * Executes every attack case against the REAL deterministic enforcement and
 * records, per case: id, category, input, expected safe behavior, actual result,
 * enforcement layer, pass/fail, and an audit reference. Writes a readable report
 * and reports overall pass/fail. Failures mean a real gap in the code, not a
 * prompt, and must be fixed in the deterministic layers.
 */

import { id as newId } from "@/lib/id";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { AuditLog } from "@/agents/base/audit";
import { WELLNESS_ATTACK_CASES, type EnforcementLayer, type WellnessAttackCase } from "./wellnessCases";

export interface WellnessCaseResult {
  id: string;
  category: string;
  input: string;
  expected: string;
  actual: string;
  layer: EnforcementLayer;
  pass: boolean;
  auditRef: string;
}

export interface WellnessRedTeamReport {
  total: number;
  passed: number;
  failed: number;
  byLayer: Record<string, number>;
  results: WellnessCaseResult[];
  allPassed: boolean;
}

async function runOne(c: WellnessAttackCase, audit: AuditLog): Promise<WellnessCaseResult> {
  let outcome: { safe: boolean; actual: string };
  try {
    outcome = await c.run();
  } catch (err) {
    // A thrown error during a defense check counts as a failure to defend cleanly,
    // UNLESS the case is specifically about an isolation PermissionError (handled in-case).
    outcome = { safe: false, actual: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  const entry = await audit.record({
    actor: "redteam",
    action: "wellness.redteam.case",
    detail: { id: c.id, category: c.category, layer: c.layer, pass: outcome.safe, actual: outcome.actual },
  });

  return {
    id: c.id,
    category: c.category,
    input: c.input,
    expected: c.expected,
    actual: outcome.actual,
    layer: c.layer,
    pass: outcome.safe,
    auditRef: entry.id,
  };
}

export async function runWellnessRedTeam(cases: WellnessAttackCase[] = WELLNESS_ATTACK_CASES): Promise<WellnessRedTeamReport> {
  const data = createInMemoryDataLayer();
  const audit = new AuditLog(data.memory, `redteam-${newId()}`);

  const results: WellnessCaseResult[] = [];
  for (const c of cases) results.push(await runOne(c, audit));

  const passed = results.filter((r) => r.pass).length;
  const byLayer: Record<string, number> = {};
  for (const r of results) if (r.pass) byLayer[r.layer] = (byLayer[r.layer] ?? 0) + 1;

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    byLayer,
    results,
    allPassed: passed === results.length,
  };
}

export function formatWellnessReport(report: WellnessRedTeamReport): string {
  const lines: string[] = [];
  lines.push("# Sahaya Wellness red-team report");
  lines.push("");
  lines.push(`Cases: ${report.total}  |  Passed: ${report.passed}  |  Failed: ${report.failed}`);
  lines.push(
    `Defenses by enforcement layer: ${Object.entries(report.byLayer).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`,
  );
  lines.push("");
  lines.push("| ID | Category | Enforcement layer | Expected safe behavior | Actual | Pass | Audit ref |");
  lines.push("|----|----------|-------------------|------------------------|--------|------|-----------|");
  for (const r of report.results) {
    lines.push(
      `| ${r.id} | ${r.category} | ${r.layer} | ${r.expected} | ${r.actual.replace(/\|/g, "/")} | ${r.pass ? "✓" : "✗ FAIL"} | ${r.auditRef} |`,
    );
  }
  lines.push("");
  if (report.failed) {
    lines.push("## Failures");
    for (const r of report.results.filter((x) => !x.pass)) {
      lines.push(`- ${r.id} (${r.category}): expected ${r.expected}; actual ${r.actual}`);
    }
    lines.push("");
  }
  lines.push("## Case inputs");
  for (const r of report.results) lines.push(`- ${r.id}: ${r.input}`);
  lines.push("");
  lines.push(
    report.allPassed
      ? "All adversarial cases were defended by the deterministic enforcement layers."
      : "FAILURES PRESENT — fix the deterministic enforcement (policy / store / authorization), not the prompts.",
  );
  return lines.join("\n");
}
