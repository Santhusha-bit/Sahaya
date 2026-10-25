/**
 * Deterministic document extraction. Reads statement / EOB text line by line
 * with explicit patterns and keeps the exact source line for every fact, so
 * each number in a finding can be traced to a quote and a document hash.
 *
 * Claude can extract formats this parser does not know (see analyst.ts), but
 * its output is only accepted after groundExtraction() confirms every amount,
 * code and date really appears in the document.
 */

import { createHash } from "node:crypto";
import type { BillLine, DocKind, EobLine, ExtractedBill, ExtractedEob } from "./types";

export const MAX_DOCUMENT_CHARS = 60_000;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function money(s: string): number {
  return Math.round(Number(s.replace(/[$,\s]/g, "")) * 100) / 100;
}

export function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDate(mdY: string): string {
  const [m, d, y] = mdY.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export function detectKind(text: string): DocKind | null {
  if (/explanation of benefits/i.test(text)) return "eob";
  if (/(patient statement|amount you owe|amount due|itemized bill|invoice)/i.test(text)) return "bill";
  return null;
}

const AMT = String.raw`-?\$?\s?([\d,]+\.\d{2})`;
const BILL_LINE = new RegExp(String.raw`^\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+([0-9A-Z]{5})\s+(.+?)\s+\$([\d,]+\.\d{2})\s*$`);
const EOB_LINE = new RegExp(
  String.raw`^\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+([0-9A-Z]{5})\s+(.+?)\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})(?:\s+([A-Z]{1,3}\d{1,3}))?\s*$`,
);

function field(text: string, label: RegExp): string | undefined {
  const m = text.match(label);
  return m?.[1]?.trim();
}

function amountAfter(text: string, label: string): number | undefined {
  const m = text.match(new RegExp(`${label}[^\\n]*?${AMT}\\s*$`, "im"));
  return m ? money(m[1]) : undefined;
}

export type ExtractResult<T> = { ok: true; doc: T } | { ok: false; errors: string[] };

export function parseBill(text: string, docId: string): ExtractResult<ExtractedBill> {
  const lines = text.split(/\r?\n/);
  const errors: string[] = [];
  const billLines: BillLine[] = [];
  for (const raw of lines) {
    const m = raw.match(BILL_LINE);
    if (!m) continue;
    billLines.push({
      lineId: `B${billLines.length + 1}`,
      serviceDate: isoDate(m[1]),
      code: m[2],
      description: m[3].trim(),
      amount: money(m[4]),
      sourceText: raw.trim(),
    });
  }
  if (!billLines.length) errors.push("No itemized charge lines (date, code, description, amount) were found.");

  const charges = amountAfter(text, "Total charges");
  const insurancePaid = amountAfter(text, "Insurance payments?") ?? 0;
  const adjustments = amountAfter(text, "(?:Insurance )?adjustments?") ?? 0;
  const amountDue = amountAfter(text, "(?:Amount you owe|Amount due|Balance due)");
  if (charges === undefined) errors.push('No "Total charges" line was found.');
  if (amountDue === undefined) errors.push('No "Amount you owe" line was found.');
  if (errors.length) return { ok: false, errors };

  // The billing contact is taken ONLY from the provider's letterhead (the lines
  // before the statement body), so an address written elsewhere in a document
  // can never become the recipient of an outbound letter.
  const header = lines.slice(0, Math.max(1, lines.findIndex((l) => /patient statement|statement date/i.test(l)))).join("\n");
  const contactLine = header.split("\n").find((l) => /billing/i.test(l)) ?? "";
  const accountRaw = field(text, /Account (?:number|no\.?|#):?\s*([0-9X*\- ]{4,})/i);
  const accountDigits = accountRaw?.replace(/\D/g, "") ?? "";

  return {
    ok: true,
    doc: {
      kind: "bill",
      docId,
      provider: {
        name: titleCase(lines.find((l) => l.trim())?.trim() ?? "Provider"),
        billingEmail: contactLine.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0],
        phone: contactLine.match(/\(\d{3}\)\s?\d{3}-\d{4}/)?.[0],
      },
      patientName: field(text, /^\s*Patient:\s*(.+)$/im) ?? "",
      accountLast4: accountDigits.length >= 4 ? accountDigits.slice(-4) : undefined,
      statementDate: toIso(field(text, /Statement date:\s*([\d/]+)/i)),
      claimNumber: field(text, /Claim (?:number|#|no\.?):?\s*([A-Z0-9-]+)/i),
      lines: billLines,
      totals: { charges: charges!, insurancePaid, adjustments, amountDue: amountDue! },
      extractedBy: "parser",
    },
  };
}

export function parseEob(text: string, docId: string): ExtractResult<ExtractedEob> {
  const lines = text.split(/\r?\n/);
  const errors: string[] = [];
  const eobLines: EobLine[] = [];
  for (const raw of lines) {
    const m = raw.match(EOB_LINE);
    if (!m) continue;
    eobLines.push({
      lineId: `E${eobLines.length + 1}`,
      serviceDate: isoDate(m[1]),
      code: m[2],
      description: m[3].trim(),
      billed: money(m[4]),
      allowed: money(m[5]),
      planPaid: money(m[6]),
      patientResp: money(m[7]),
      remarkCode: m[8],
      sourceText: raw.trim(),
    });
  }
  if (!eobLines.length) errors.push("No claim lines (date, code, billed, allowed, plan paid, you owe) were found.");

  const totalsLine = lines.find((l) => /^\s*totals?\b/i.test(l));
  const totalAmounts = totalsLine ? [...totalsLine.matchAll(/\$([\d,]+\.\d{2})/g)].map((m) => money(m[1])) : [];
  const responsibility = amountAfter(text, "(?:Your total responsibility|Total you owe|Patient responsibility)");
  const sum = (k: keyof Pick<EobLine, "billed" | "allowed" | "planPaid" | "patientResp">) => cents(eobLines.reduce((s, l) => s + l[k], 0));
  if (errors.length) return { ok: false, errors };

  const remarks: Record<string, string> = {};
  const remarkStart = lines.findIndex((l) => /remark codes?/i.test(l));
  if (remarkStart >= 0) {
    for (const raw of lines.slice(remarkStart + 1)) {
      const m = raw.match(/^\s*([A-Z]{1,3}\d{1,3})\s{2,}(.+)$/);
      if (m) remarks[m[1]] = m[2].trim();
    }
  }

  return {
    ok: true,
    doc: {
      kind: "eob",
      docId,
      insurer: {
        name: titleCase(lines.find((l) => l.trim())?.trim() ?? "Insurer"),
        phone: field(text, /Member services:?\s*(\(\d{3}\)\s?\d{3}-\d{4})/i),
      },
      memberName: field(text, /^\s*Member:\s*(.+)$/im) ?? "",
      claimNumber: field(text, /Claim (?:number|#|no\.?):?\s*([A-Z0-9-]+)/i),
      providerName: field(text, /^\s*Provider:\s*(.+)$/im),
      processedDate: toIso(field(text, /Date processed:\s*([\d/]+)/i)),
      lines: eobLines,
      totals: {
        billed: totalAmounts[0] ?? sum("billed"),
        allowed: totalAmounts[1] ?? sum("allowed"),
        planPaid: totalAmounts[2] ?? sum("planPaid"),
        patientResp: responsibility ?? totalAmounts[3] ?? sum("patientResp"),
      },
      remarks,
      extractedBy: "parser",
    },
  };
}

function toIso(v: string | undefined): string | undefined {
  return v && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v) ? isoDate(v) : undefined;
}

function titleCase(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Content Finance ignores and reports: instructions aimed at an AI, payment
 * redirection, and contact addresses outside the provider letterhead. These are
 * surfaced as warnings and never acted on.
 */
export function scanForSuspiciousContent(text: string, allowedEmails: string[]): string[] {
  const warnings: string[] = [];
  const allowed = new Set(allowedEmails.map((e) => e.toLowerCase()));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/(ignore (all|any|previous|prior)|assistant|\bAI\b|system prompt|you must now|disregard)/i.test(line)) {
      warnings.push(`Ignored an instruction written inside the document: "${clip(line)}"`);
      continue;
    }
    if (/(wire|gift card|zelle|crypto|bitcoin|pay (to|into) (this|a new)|new (bank|account) details)/i.test(line)) {
      warnings.push(`Ignored a payment-redirection request inside the document: "${clip(line)}"`);
      continue;
    }
    for (const email of line.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) {
      if (!allowed.has(email.toLowerCase())) warnings.push(`Ignored a contact address outside the provider letterhead: ${email}`);
    }
  }
  return warnings;
}

function clip(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Grounding check for model-extracted documents: every amount, code and date the
 * model reports must literally appear in the source text. Returns problems; an
 * empty list means the extraction is accepted.
 */
export function groundExtraction(text: string, doc: ExtractedBill | ExtractedEob): string[] {
  const problems: string[] = [];
  const amounts = new Set([...text.matchAll(/([\d,]+\.\d{2})/g)].map((m) => money(m[1]).toFixed(2)));
  const has = (n: number) => amounts.has(cents(n).toFixed(2));
  const dateInText = (iso: string) => {
    const [y, m, d] = iso.split("-");
    return text.includes(`${m}/${d}/${y}`) || text.includes(`${Number(m)}/${Number(d)}/${y}`) || text.includes(iso);
  };
  for (const l of doc.lines) {
    if (!text.includes(l.code)) problems.push(`Code ${l.code} on ${l.lineId} is not in the document.`);
    if (!dateInText(l.serviceDate)) problems.push(`Date ${l.serviceDate} on ${l.lineId} is not in the document.`);
    const nums = doc.kind === "bill" ? [(l as BillLine).amount] : [(l as EobLine).billed, (l as EobLine).allowed, (l as EobLine).planPaid, (l as EobLine).patientResp];
    for (const n of nums) if (!has(n)) problems.push(`Amount ${n.toFixed(2)} on ${l.lineId} is not in the document.`);
  }
  const totals = doc.kind === "bill" ? [doc.totals.charges, doc.totals.amountDue] : [doc.totals.patientResp];
  for (const n of totals) if (!has(n)) problems.push(`Total ${n.toFixed(2)} is not in the document.`);
  if (!doc.lines.length) problems.push("No line items.");
  return problems;
}
