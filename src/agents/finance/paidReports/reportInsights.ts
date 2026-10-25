/**
 * Incorporate a purchased financial report into Finance's analysis. PURE: given
 * a report and what the person asked about (an invoice, bill lines, a drug
 * price), return plain-language findings. No model output involved.
 */

import type { CareType, FinancialReport, Range } from "./financialReportService";

export interface ReportContext {
  /** care-facility-costs */
  monthlyCost?: number;
  careType?: CareType;
  extras?: { description: string; amount: number }[];
  /** medical-billing-benchmarks */
  lineItems?: { description: string; amount: number }[];
  /** drug-price-benchmarks */
  drug?: string;
  pricePaid?: number;
}

export interface ReportInsights {
  findings: string[];
  flags: string[];
  /** Rough amount above the typical-high end, when something looks overpriced. */
  possibleSavingsUsd: number;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const rangeText = (r: Range) => `${usd(r.low)} to ${usd(r.high)}`;

function match<T extends { keywords: string[] }>(rows: T[] | undefined, text: string): T | undefined {
  const t = text.toLowerCase();
  return rows?.find((r) => r.keywords.some((k) => t.includes(k)));
}

export function incorporateReport(report: FinancialReport, ctx: ReportContext = {}): ReportInsights {
  const findings: string[] = [];
  const flags: string[] = [];
  let savings = 0;

  if (report.reportId === "care-facility-costs" && report.careCosts) {
    const type = ctx.careType ?? "assisted-living";
    const r = report.careCosts[type];
    if (ctx.monthlyCost !== undefined) {
      const where =
        ctx.monthlyCost < r.low ? "below the typical range" : ctx.monthlyCost <= r.median ? "in the lower half of the typical range" : ctx.monthlyCost <= r.high ? "in the upper half of the typical range" : "above the typical range";
      findings.push(`${usd(ctx.monthlyCost)}/month for ${type.replace(/-/g, " ")} is ${where} for the ${report.region} region (typical ${rangeText(r)}, median ${usd(r.median)}).`);
      if (ctx.monthlyCost > r.high) {
        flags.push(`Monthly rate is ${usd(ctx.monthlyCost - r.high)} above the typical high end`);
        savings += ctx.monthlyCost - r.high;
      }
    } else {
      findings.push(`Typical ${type.replace(/-/g, " ")} cost in the ${report.region} region: ${rangeText(r)} per month (median ${usd(r.median)}).`);
    }
    for (const e of ctx.extras ?? []) {
      const b = match(report.careExtras, e.description);
      if (!b) {
        findings.push(`No benchmark for "${e.description}"; ask the facility where it appears in the contract.`);
      } else if (e.amount > b.range.high) {
        flags.push(`${e.description} (${usd(e.amount)}) is above the typical ${rangeText(b.range)} for ${b.service.toLowerCase()}`);
        savings += e.amount - b.range.high;
      } else {
        findings.push(`${e.description} (${usd(e.amount)}) is within the typical ${rangeText(b.range)}.`);
      }
    }
  }

  if (report.reportId === "medical-billing-benchmarks") {
    const seen = new Map<string, number>();
    for (const li of ctx.lineItems ?? []) {
      seen.set(li.description.toLowerCase(), (seen.get(li.description.toLowerCase()) ?? 0) + 1);
      const b = match(report.medicalServices, li.description);
      if (!b) {
        findings.push(`No benchmark for "${li.description}".`);
      } else if (li.amount > b.range.high) {
        flags.push(`${li.description} (${usd(li.amount)}) is above the typical ${rangeText(b.range)}`);
        savings += li.amount - b.range.high;
      } else {
        findings.push(`${li.description} (${usd(li.amount)}) is within the typical ${rangeText(b.range)}.`);
      }
    }
    for (const [desc, count] of seen) {
      if (count > 1) {
        const item = ctx.lineItems!.find((l) => l.description.toLowerCase() === desc)!;
        flags.push(`"${item.description}" is billed ${count} times; ask whether it's a duplicate`);
        savings += item.amount * (count - 1);
      }
    }
  }

  if (report.reportId === "drug-price-benchmarks" && ctx.drug) {
    const b = match(report.drugs, ctx.drug);
    if (!b) {
      findings.push(`The report has no benchmark for ${ctx.drug}.`);
    } else if (ctx.pricePaid === undefined) {
      findings.push(`Typical cash price for a 30-day supply of generic ${b.drug}: ${rangeText(b.range)}.`);
    } else if (ctx.pricePaid > b.range.high) {
      flags.push(`${usd(ctx.pricePaid)} for ${b.drug} is above the typical ${rangeText(b.range)} cash price`);
      savings += ctx.pricePaid - b.range.median;
    } else {
      findings.push(`${usd(ctx.pricePaid)} for ${b.drug} is within the typical ${rangeText(b.range)}.`);
    }
  }

  if (!findings.length && !flags.length) findings.push(`${report.title} for the ${report.region} region is saved for future checks.`);
  return { findings, flags, possibleSavingsUsd: Number(savings.toFixed(2)) };
}

export function describeInsights(i: ReportInsights): string {
  const parts = [...i.flags.map((f) => `Flag: ${f}.`), ...i.findings];
  if (i.possibleSavingsUsd > 0) parts.push(`Worth asking about: about ${usd(i.possibleSavingsUsd)}.`);
  return parts.join(" ");
}
