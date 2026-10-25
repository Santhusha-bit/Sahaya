/**
 * Untrusted text handling. Product descriptions, catalog entries, pharmacy messages and transcripts
 * are data, never instructions. They are:
 *  - stripped of control characters and markup-looking tags, length-capped,
 *  - flagged when they contain instruction-like phrasing,
 *  - only ever shown to Claude inside an explicit <untrusted_data> wrapper (see wrapUntrusted),
 *  - never used by deterministic code to make a decision (allergy, approval, status, spending).
 */

const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|rules|messages)/i,
  /\b(system|developer|assistant)\s*:/i,
  /you are now/i,
  /disregard (the|all|your)/i,
  /(approve|authorize|place|submit) (this|the) (order|refill|request|purchase)/i,
  /(mark|treat|consider) (this|it) (as )?(safe|allergy[- ]free|approved)/i,
  /\bnew instructions?\b/i,
  /<\/?(system|instructions?|tool|assistant)[^>]*>/i,
  /do not (tell|inform|alert) (the )?(user|caregiver)/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((r) => r.test(text));
}

export interface UntrustedText {
  text: string;
  flagged: boolean;
  source: string;
}

export function sanitizeUntrusted(raw: unknown, source: string, max = 300): UntrustedText {
  const s = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  const cleaned = s
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/<[^>]{0,200}>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return { text: cleaned, flagged: looksLikeInjection(s), source };
}

/** The only way untrusted text is placed in front of the model. */
export function wrapUntrusted(u: UntrustedText): string {
  const body = u.text.replace(/<\/?untrusted_data[^>]*>/gi, "");
  return `<untrusted_data source="${u.source}"${u.flagged ? ' flagged="possible-instructions"' : ""}>${body}</untrusted_data>`;
}
