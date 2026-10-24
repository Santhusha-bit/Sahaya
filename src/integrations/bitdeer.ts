/**
 * Bitdeer AI Model Studio inference provider (Part 5, Track A).
 *
 * Bitdeer exposes an OpenAI-compatible serverless inference API. Verified against
 * the official developer docs (https://developers.bitdeer.ai):
 *   - Base URL:  https://api-inference.bitdeer.ai/v1
 *   - Endpoint:  POST /chat/completions
 *   - Auth:      Authorization: Bearer <BITDEER_API_KEY>
 *   - Models:    e.g. deepseek-ai/DeepSeek-V4-Flash, GLM-5.2, Qwen3.5-397B-A17B
 *                (set BITDEER_MODEL to any model from your Studio catalog)
 *   - Structured output: OpenAI-compatible response_format json_object, plus our
 *                own strict zod validation + evidence grounding downstream.
 *
 * We call it with plain fetch (no new SDK dependency). The adapter ONLY performs
 * inference and returns the raw candidate observations; it makes NO trust
 * decision. All validation happens in observationPolicy.ts. This keeps the model
 * strictly advisory, exactly like the scam-signal / policy split in Guardian.
 */

import type { IntegrationMode } from "@/lib/env";
import { bitdeerStatus } from "@/lib/env";

export interface WellnessInferenceRequest {
  /** Already privacy-minimized text (see privacyFilter.ts). */
  text: string;
}

export interface WellnessInferenceResult {
  /** Raw, UNTRUSTED candidate observations as returned by the provider. */
  raw: unknown;
  provider: string;
  model: string;
  mode: "live" | "sandbox";
}

/** The provider contract both the real and sandbox adapters implement. */
export interface WellnessInferenceProvider {
  readonly name: string;
  readonly model: string;
  readonly mode: "live" | "sandbox";
  infer(req: WellnessInferenceRequest): Promise<WellnessInferenceResult>;
}

export const BITDEER_BASE_URL = process.env.BITDEER_BASE_URL?.trim() || "https://api-inference.bitdeer.ai/v1";
export const BITDEER_MODEL = process.env.BITDEER_MODEL?.trim() || "deepseek-ai/DeepSeek-V4-Flash";

const EXTRACTION_SYSTEM = `You extract structured wellness observations from a short message by an older adult.
Return ONLY JSON: {"observations":[...]}. Each observation has:
- "type": one of sleep_duration, sleep_quality, energy, mood, appetite, pain, social, activity, other
- "value" (number) and "unit" ("hours" or "minutes") ONLY for sleep_duration and ONLY if the number is explicitly stated
- "description" (short phrase quoting the person) for qualitative observations
- "source": "self_report"
- "requires_confirmation": true if the message is vague
Rules: Never invent numbers. Never convert a vague feeling into a numeric rating. Never add a medical diagnosis or medication advice. Only report what the message actually says.`;

/** Real Bitdeer adapter. Used only when BITDEER_API_KEY is configured. */
export class BitdeerInferenceAdapter implements WellnessInferenceProvider {
  readonly name = "bitdeer";
  readonly mode = "live" as const;
  readonly model: string;

  constructor(
    private readonly apiKey: string,
    model: string = BITDEER_MODEL,
    private readonly baseUrl: string = BITDEER_BASE_URL,
  ) {
    this.model = model;
  }

  async infer(req: WellnessInferenceRequest): Promise<WellnessInferenceResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM },
          { role: "user", content: req.text },
        ],
        temperature: 0,
        max_tokens: 500,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bitdeer inference failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      // Malformed JSON is passed through as-is; the policy engine rejects it safely.
      raw = { observations: [], _parseError: true, _content: content.slice(0, 300) };
    }
    return { raw, provider: this.name, model: this.model, mode: "live" };
  }
}

/**
 * Sandbox adapter: a deterministic, offline extractor with the SAME interface.
 * It only extracts what is explicitly present (so the demo and tests run without
 * any API key) and is honestly labeled "sandbox". It never invents numbers.
 */
export class SandboxWellnessInferenceAdapter implements WellnessInferenceProvider {
  readonly name = "sandbox";
  readonly mode = "sandbox" as const;
  readonly model = "deterministic-rule-extractor";

  async infer(req: WellnessInferenceRequest): Promise<WellnessInferenceResult> {
    const text = req.text;
    const low = text.toLowerCase();
    const observations: Record<string, unknown>[] = [];

    // Sleep duration: an explicit "<n> hours" / "<word> hours" of sleep.
    const sleepMatch =
      low.match(/\b(\d+(?:\.\d+)?)\s*(hours?|hrs?)\b/) ||
      low.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(hours?|hrs?)\b/);
    const mentionsSleep = /sleep|slept|sleeping|rest|bed|awake/.test(low);
    if (sleepMatch && mentionsSleep) {
      const words: Record<string, number> = {
        one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
        eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
      };
      const n = words[sleepMatch[1]] ?? parseFloat(sleepMatch[1]);
      if (!Number.isNaN(n)) {
        observations.push({ type: "sleep_duration", value: n, unit: "hours", source: "self_report", requires_confirmation: false });
      }
    }

    // Qualitative signals -> descriptions quoting the message (no invented numbers).
    const QUAL: { type: string; re: RegExp; describe: (m: RegExpMatchArray) => string }[] = [
      { type: "energy", re: /\b(tired|exhausted|worn out|no energy|low energy|fatigued|drained)\b/, describe: (m) => `felt ${m[1]}` },
      { type: "energy", re: /\b(energetic|full of energy|lots of energy)\b/, describe: (m) => `felt ${m[1]}` },
      { type: "mood", re: /\b(lonely|sad|down|blue|low|anxious|worried|upset)\b/, describe: (m) => `felt ${m[1]}` },
      { type: "mood", re: /\b(happy|good|cheerful|content|grateful|lovely|wonderful)\b/, describe: (m) => `felt ${m[1]}` },
      { type: "sleep_quality", re: /\b(couldn'?t sleep|trouble sleeping|poor sleep|didn'?t sleep well|restless|kept waking)\b/, describe: () => "poor sleep quality reported" },
      { type: "appetite", re: /\b(not eating|no appetite|skipped (?:a )?meal|not hungry|didn'?t eat)\b/, describe: () => "reduced appetite reported" },
      { type: "pain", re: /\b(pain|ache|aching|sore|hurts?)\b/, describe: (m) => `mentioned ${m[1]}` },
      { type: "social", re: /\b(visit|visited|called|saw|friend|family|grandkid|neighbor|church)\b/, describe: (m) => `social contact: ${m[1]}` },
      { type: "social", re: /\b(alone|nobody|no one|isolated|haven'?t seen anyone)\b/, describe: () => "feeling isolated" },
    ];
    const seen = new Set<string>();
    for (const q of QUAL) {
      const m = low.match(q.re);
      if (m && !seen.has(q.type + m[1])) {
        seen.add(q.type + m[1]);
        observations.push({ type: q.type, description: q.describe(m), source: "self_report", requires_confirmation: false });
      }
    }

    return { raw: { observations }, provider: this.name, model: this.model, mode: "sandbox" };
  }
}

/** Process-wide provider (swappable in tests/demos, like the incident index). */
const GLOBAL_KEY = "__kinline_wellness_inference__";

export function getWellnessInferenceProvider(): WellnessInferenceProvider {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as WellnessInferenceProvider;
  const status = bitdeerStatus();
  const provider =
    status.mode === "live" && process.env.BITDEER_API_KEY
      ? new BitdeerInferenceAdapter(process.env.BITDEER_API_KEY)
      : new SandboxWellnessInferenceAdapter();
  g[GLOBAL_KEY] = provider;
  return provider;
}

/** For tests/demos: inject a specific provider (e.g. a hallucinating stub). */
export function setWellnessInferenceProvider(provider: WellnessInferenceProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = provider;
}

/** For tests: clear the cached provider so it is re-resolved from env. */
export function resetWellnessInferenceProvider(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}

export type { IntegrationMode };
