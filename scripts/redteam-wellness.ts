/**
 * npm run redteam:wellness
 *
 * Runs the Wellness adversarial suite against the REAL deterministic enforcement,
 * prints a readable report, saves it to redteam-wellness-report.md, and exits
 * non-zero if ANY case was not defended (or if there are fewer than 30 cases).
 */

import { writeFileSync } from "node:fs";
import { formatWellnessReport, runWellnessRedTeam } from "@/redteam/wellnessRunner";

async function main() {
  const report = await runWellnessRedTeam();
  const text = formatWellnessReport(report);
  console.log(text);
  writeFileSync("redteam-wellness-report.md", text + "\n", "utf8");
  console.log("\nSaved redteam-wellness-report.md");

  if (report.total < 30) {
    console.error(`\nOnly ${report.total} cases; the suite requires at least 30.`);
    process.exit(1);
  }
  if (!report.allPassed) {
    console.error(`\n${report.failed} case(s) FAILED. Fix the enforcement code, not the prompts.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
