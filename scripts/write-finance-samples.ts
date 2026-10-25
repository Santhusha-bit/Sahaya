/**
 * Regenerates public/samples/*.txt from the canonical sample documents so the
 * downloadable copies never drift from what the demo and tests use.
 *   npx vite-node --config vitest.config.ts scripts/write-finance-samples.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { SAMPLE_BILL_FILENAME, SAMPLE_BILL_TEXT, SAMPLE_EOB_FILENAME, SAMPLE_EOB_TEXT } from "@/agents/finance/investigation/samples";

mkdirSync("public/samples", { recursive: true });
writeFileSync(`public/samples/${SAMPLE_BILL_FILENAME}`, SAMPLE_BILL_TEXT);
writeFileSync(`public/samples/${SAMPLE_EOB_FILENAME}`, SAMPLE_EOB_TEXT);
console.log(`Wrote public/samples/${SAMPLE_BILL_FILENAME} and public/samples/${SAMPLE_EOB_FILENAME}`);
