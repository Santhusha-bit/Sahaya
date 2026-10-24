/**
 * Privacy filter for wellness text (Part 5, Track A, step 3; global data-minimization rule).
 *
 * Before any text is sent to an EXTERNAL inference provider, it is minimized:
 * personal identifiers are redacted and only the content relevant to a well-being
 * observation is kept. An external provider should never receive more personal
 * information than the task requires (red-team case 22).
 */

export interface MinimizedText {
  /** The text that is safe to send externally. */
  text: string;
  /** Count of redactions applied, for the audit trail. */
  redactions: number;
  /** Which categories were redacted (ssn, phone, email, money, name). */
  redactedKinds: string[];
}

const PATTERNS: { kind: string; re: RegExp; replace: string }[] = [
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, replace: "[redacted]" },
  { kind: "email", re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replace: "[redacted]" },
  { kind: "phone", re: /(\+?\d[\d\s().-]{7,}\d)/g, replace: "[redacted]" },
  { kind: "money", re: /\$\s?[\d,]+(?:\.\d{2})?/g, replace: "[redacted]" },
  // Street addresses ("123 Main St").
  { kind: "address", re: /\b\d{1,5}\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Lane|Ln|Dr|Drive|Ct|Court)\b/g, replace: "[redacted]" },
];

/**
 * Minimize free text for external processing. Redacts PII and caps length so a
 * whole conversation history can never be forwarded. Importantly, we keep the
 * digits inside clearly time/duration-related phrasing because sleep hours are
 * the signal we need, but we strip stand-alone money and identifiers.
 */
export function minimizeForExternal(input: string, opts?: { maxChars?: number }): MinimizedText {
  const maxChars = opts?.maxChars ?? 400;
  let text = input;
  const redactedKinds = new Set<string>();
  let redactions = 0;

  for (const { kind, re, replace } of PATTERNS) {
    text = text.replace(re, () => {
      redactions++;
      redactedKinds.add(kind);
      return replace;
    });
  }

  // Cap length: only the first maxChars of the (redacted) message cross the boundary.
  if (text.length > maxChars) text = text.slice(0, maxChars).trim();

  return { text: text.trim(), redactions, redactedKinds: [...redactedKinds] };
}
