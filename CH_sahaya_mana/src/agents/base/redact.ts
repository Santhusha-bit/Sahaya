/**
 * Deterministic redaction of forgotten values from stored conversation content (shared by the local stores and
 * the Convex functions). Replaces every case-insensitive occurrence of each term inside string values, recursively,
 * without touching structural fields (block types, ids, tool_use ↔ tool_result pairing, tool names), so replayed
 * history stays valid for the model API.
 */
const STRUCTURAL_KEYS = new Set(["type", "id", "tool_use_id", "name", "role", "channel", "agentId", "userId"]);

function escape(term: string) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildRedactor(terms: string[], replacement = "[forgotten]") {
  const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2))].sort((a, b) => b.length - a.length);
  if (!clean.length) return null;
  // Word-ish boundaries so "Ann" doesn't hit "Annual"; inner spaces match any whitespace.
  const pattern = new RegExp(clean.map((t) => `(?<![\\p{L}\\p{N}])${escape(t).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`).join("|"), "giu");
  return (s: string) => s.replace(pattern, replacement);
}

/** Returns [redactedValue, changed]. */
export function redactDeep(value: unknown, redact: (s: string) => string): [unknown, boolean] {
  if (typeof value === "string") {
    const out = redact(value);
    return [out, out !== value];
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const [r, c] = redactDeep(v, redact);
      changed ||= c;
      return r;
    });
    return [out, changed];
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRUCTURAL_KEYS.has(k)) {
        out[k] = v;
        continue;
      }
      const [r, c] = redactDeep(v, redact);
      changed ||= c;
      out[k] = r;
    }
    return [out, changed];
  }
  return [value, false];
}
