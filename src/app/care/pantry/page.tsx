"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IntegrationStatus } from "@/lib/env";

/** ---- Types mirrored from /api/care/pantry ---- */
interface PantryItem {
  name: string;
  displayName: string;
  confidence: number | null;
  status: "confirmed" | "uncertain" | "rejected";
  source: "vision" | "person";
  quantity?: string;
  note?: string;
}
interface PlannedRecipe {
  name: string;
  prepMinutes: number;
  servings: number;
  using: string[];
  missing: string[];
  missingOptional: string[];
  steps: string[];
  tips: string[];
}
interface MissingItem { item: string; productName: string | null; price: number | null; optional: boolean }
interface Plan {
  dinner: PlannedRecipe | null;
  alternatives: PlannedRecipe[];
  missingItems: MissingItem[];
  excluded: { recipe: string; reason: string }[];
  assumedStaples: string[];
  groceryListId?: string | null;
}
interface Scan {
  scanId: string;
  status: "needs_confirmation" | "confirmed";
  provenance: { provider: string; model: string; mode: string };
  items: PantryItem[];
  rejectedByPolicy: { value: string; reason: string }[];
  plan: Plan | null;
}
interface Preferences {
  vegetarian?: boolean;
  lowSodium?: boolean;
  softFoods?: boolean;
  allergies?: string[];
  dislikes?: string[];
  maxPrepMinutes?: number;
}
interface PantryState {
  scan: Scan | null;
  preferences: Preferences | null;
  integrations: IntegrationStatus[];
  summary?: string;
  ok?: boolean;
  error?: string | null;
}

const ACCENT = "#4779b8";
const ACCENT_INK = "#2f5586";
const ACCENT_SOFT = "#e8f0fa";
const GRADIENT = "linear-gradient(135deg,#3a6aa6,#4779b8)";

const MODE_STYLE: Record<string, { bg: string; color: string }> = {
  live: { bg: "#d1fae5", color: "#065f46" },
  sandbox: { bg: "#fef3c7", color: "#92400e" },
  unavailable: { bg: "#fee2e2", color: "#991b1b" },
};

const REJECT_LABEL: Record<string, string> = {
  instruction_text: "text in the photo, not food",
  not_food_name: "not a food name",
  low_confidence: "too unsure",
  duplicate: "duplicate",
  schema: "unreadable",
  over_limit: "too many items",
};

/** Downscale to <=1280px JPEG in the browser so uploads stay small and fast. */
async function prepareImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    // e.g. HEIC on browsers that can't decode it: send the original.
    return file;
  }
}

function RecipeCard({ recipe, primary }: { recipe: PlannedRecipe; primary?: boolean }) {
  return (
    <div className="card p-4" style={primary ? { borderColor: ACCENT, boxShadow: `0 6px 20px ${ACCENT}22` } : undefined}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[17px] font-extrabold leading-snug">{recipe.name}</div>
        <span className="pill shrink-0 px-2.5 py-0.5 text-[11px] font-bold" style={{ background: ACCENT_SOFT, color: ACCENT_INK }}>
          {recipe.prepMinutes} min
        </span>
      </div>
      {recipe.using.length > 0 && (
        <div className="mt-1 text-[13px] text-[var(--muted)]">Uses your {recipe.using.join(", ")}</div>
      )}
      {primary && (
        <>
          <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-[14px] leading-relaxed">
            {recipe.steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
          {recipe.tips.length > 0 && (
            <div className="mt-3 rounded-xl px-3 py-2 text-[13px] leading-snug" style={{ background: ACCENT_SOFT, color: ACCENT_INK }}>
              {recipe.tips.map((t) => <div key={t}>• {t}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function PantryPage() {
  const [state, setState] = useState<PantryState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [addText, setAddText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const apply = useCallback((s: PantryState) => {
    setState(s);
    if (s.summary) setMessage(s.summary);
  }, []);

  useEffect(() => {
    fetch("/api/care/pantry").then((r) => r.json()).then(setState).catch(() => {});
  }, []);

  const post = useCallback(async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    try {
      const res = await fetch("/api/care/pantry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      apply(await res.json());
    } catch {
      setMessage("I couldn't reach the server just now. Please try again.");
    } finally {
      setBusy(null);
    }
  }, [apply]);

  const onPhoto = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    setBusy("scan");
    setMessage(null);
    try {
      const form = new FormData();
      const blob = await prepareImage(file);
      form.append("photo", blob, file.name || "pantry.jpg");
      const res = await fetch("/api/care/pantry", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok && data.error) setMessage(data.error);
      else apply(data);
    } catch {
      setMessage("I couldn't upload that photo. Please try again.");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [apply]);

  const scan = state?.scan ?? null;
  const items = scan?.items ?? [];
  const confirmed = items.filter((i) => i.status === "confirmed");
  const uncertain = items.filter((i) => i.status === "uncertain");
  const gemini = state?.integrations.find((i) => i.key === "gemini");
  const prefs = state?.preferences;
  const plan = scan?.plan ?? null;

  return (
    <main className="px-4 pt-7 pb-28">
      {/* Header */}
      <header className="relative overflow-hidden rounded-[24px] p-5 text-white" style={{ background: GRADIENT, boxShadow: "var(--shadow-lg)" }}>
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-12 h-36 w-36 rounded-full bg-white/15 blur-2xl" />
        <div className="relative flex items-center gap-3">
          <span aria-hidden className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/20 text-[22px] backdrop-blur">🥕</span>
          <div>
            <h1 className="text-[22px] font-extrabold tracking-tight">What's for dinner?</h1>
            <div className="text-[13px] text-white/85">Snap your fridge or pantry and I'll suggest a meal.</div>
          </div>
        </div>
        <div className="relative mt-4 flex flex-wrap items-center gap-2">
          <Link href="/agents/care" className="btn inline-flex items-center gap-2 rounded-full bg-white/20 px-4 py-2 text-[14px] font-semibold backdrop-blur transition-colors hover:bg-white/30">
            💬 Talk to Care
          </Link>
          {gemini && (
            <span className="pill px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide" style={MODE_STYLE[gemini.mode]} title={gemini.detail}>
              Gemini vision · {gemini.mode}
            </span>
          )}
        </div>
      </header>

      {/* Step 1: photo */}
      <h2 className="eyebrow mt-7">1 · Take a photo</h2>
      <div className="card mt-2 flex flex-col items-center gap-3 p-4">
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Your pantry photo" className="max-h-56 w-full rounded-xl object-cover" />
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => onPhoto(e.target.files?.[0])}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={!!busy}
          className="btn w-full rounded-2xl py-3.5 text-[16px] font-bold text-white disabled:opacity-60"
          style={{ background: GRADIENT, boxShadow: `0 6px 18px ${ACCENT}44` }}
        >
          {busy === "scan" ? "Looking at your photo…" : scan ? "📷 Take another photo" : "📷 Photograph my fridge or pantry"}
        </button>
        <p className="text-center text-[12px] text-[var(--muted)]">
          The photo is only used to spot ingredients. It is not saved.
          {gemini?.mode === "sandbox" ? " Sandbox mode: a sample fridge is shown instead of analyzing your photo." : ""}
        </p>
      </div>

      {message && (
        <div className="fade-up mt-4 rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-[15px] leading-relaxed shadow-sm">
          <span className="mr-1.5">💙</span>{message}
        </div>
      )}

      {/* Step 2: confirm */}
      {scan && (
        <>
          <h2 className="eyebrow mt-7">2 · Check what I found</h2>
          {confirmed.length > 0 && (
            <div className="card mt-2 p-4">
              <div className="text-[13px] font-semibold text-[var(--muted)]">I can see</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {confirmed.map((i) => (
                  <span key={i.name} className="pill px-3 py-1 text-[14px] font-semibold" style={{ background: ACCENT_SOFT, color: ACCENT_INK }}>
                    ✓ {i.displayName}{i.quantity ? ` (${i.quantity})` : ""}
                  </span>
                ))}
              </div>
            </div>
          )}

          {uncertain.length > 0 && (
            <section className="mt-2.5 flex flex-col gap-2.5">
              <div className="text-[14px] font-semibold">I wasn't sure about these. Do you have them?</div>
              {uncertain.map((i) => (
                <div key={i.name} className="card fade-up p-3.5" style={{ borderColor: "#fde68a", background: "linear-gradient(180deg,#fff,#fffbeb)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[16px] font-bold">{i.displayName}?</div>
                      {i.note && <div className="text-[12px] text-[var(--muted)]">{i.note}</div>}
                    </div>
                    {i.confidence !== null && (
                      <span className="text-[11px] font-semibold text-[var(--faint)]">{Math.round(i.confidence * 100)}% sure</span>
                    )}
                  </div>
                  <div className="mt-2.5 flex gap-2">
                    <button
                      onClick={() => post(`confirm:${i.name}`, { action: "confirm", confirm: [i.name] })}
                      disabled={!!busy}
                      className="btn flex-1 rounded-xl bg-emerald-600 py-2.5 text-[15px] font-semibold text-white disabled:opacity-60"
                    >
                      Yes, I have it
                    </button>
                    <button
                      onClick={() => post(`reject:${i.name}`, { action: "confirm", reject: [i.name] })}
                      disabled={!!busy}
                      className="btn flex-1 rounded-xl bg-[var(--bg-tint)] py-2.5 text-[15px] font-semibold text-[var(--muted)] disabled:opacity-60"
                    >
                      No
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          <div className="card mt-2.5 flex items-center gap-2 p-2 pl-3">
            <input
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && addText.trim()) {
                  void post("add", { action: "confirm", add: addText.split(",").map((s) => s.trim()).filter(Boolean) });
                  setAddText("");
                }
              }}
              placeholder="Anything I missed? e.g. celery, potatoes"
              className="h-10 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--faint)]"
            />
            <button
              onClick={() => {
                if (!addText.trim()) return;
                void post("add", { action: "confirm", add: addText.split(",").map((s) => s.trim()).filter(Boolean) });
                setAddText("");
              }}
              disabled={!addText.trim() || !!busy}
              className="btn rounded-xl px-4 py-2 text-[14px] font-semibold text-white disabled:opacity-40"
              style={{ background: ACCENT }}
            >
              Add
            </button>
          </div>

          {(scan.rejectedByPolicy?.length ?? 0) > 0 && (
            <details className="mt-2 text-[12px] text-[var(--muted)]">
              <summary className="cursor-pointer">Ignored {scan.rejectedByPolicy.length} thing(s) from the photo</summary>
              <ul className="mt-1 pl-4">
                {scan.rejectedByPolicy.map((r, idx) => <li key={idx}>“{r.value}”: {REJECT_LABEL[r.reason] ?? r.reason}</li>)}
              </ul>
            </details>
          )}

          {/* Step 3: plan */}
          <h2 className="eyebrow mt-7">3 · Plan dinner</h2>
          {prefs && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {([
                ["lowSodium", "Low sodium"],
                ["softFoods", "Soft foods"],
                ["vegetarian", "Vegetarian"],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => post(`pref:${key}`, { action: "preferences", preferences: { [key]: !prefs[key] } })}
                  disabled={!!busy}
                  className="btn pill px-3 py-1 text-[13px] font-semibold"
                  style={prefs[key] ? { background: ACCENT, color: "#fff" } : { background: "#f1f3f8", color: "#8a93a6" }}
                  aria-pressed={!!prefs[key]}
                >
                  {prefs[key] ? "✓ " : ""}{label}
                </button>
              ))}
              {(prefs.dislikes ?? []).map((d) => (
                <span key={d} className="pill px-3 py-1 text-[13px] font-semibold" style={{ background: "#f1f3f8", color: "#65737e" }}>No {d}</span>
              ))}
              {(prefs.allergies ?? []).map((a) => (
                <span key={a} className="pill px-3 py-1 text-[13px] font-semibold" style={{ background: "#fee2e2", color: "#991b1b" }}>Allergy: {a}</span>
              ))}
            </div>
          )}
          <button
            onClick={() => post("plan", { action: "plan" })}
            disabled={!!busy || uncertain.length > 0}
            className="btn mt-3 w-full rounded-2xl py-3.5 text-[16px] font-bold text-white disabled:opacity-50"
            style={{ background: GRADIENT, boxShadow: `0 6px 18px ${ACCENT}44` }}
          >
            {busy === "plan" ? "Planning…" : uncertain.length ? "Answer the questions above first" : plan ? "🍽️ Plan again" : "🍽️ Suggest a dinner"}
          </button>

          {plan?.dinner && (
            <section className="fade-up mt-4 flex flex-col gap-2.5">
              <RecipeCard recipe={plan.dinner} primary />
              {plan.missingItems.length > 0 && (
                <div className="card p-4">
                  <div className="text-[15px] font-bold">Shopping list</div>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {plan.missingItems.map((m) => (
                      <li key={m.item} className="flex items-center justify-between text-[14px]">
                        <span>
                          {m.productName ?? m.item}
                          {m.optional && <span className="ml-1.5 text-[12px] text-[var(--faint)]">optional</span>}
                        </span>
                        {m.price !== null && <span className="text-[var(--muted)]">${m.price.toFixed(2)}</span>}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[12px] text-[var(--muted)]">
                    Saved to your grocery list. Nothing is ordered until you approve it.
                  </p>
                  <Link href="/agents/care" className="btn mt-2.5 inline-flex rounded-xl px-4 py-2 text-[14px] font-semibold" style={{ background: ACCENT_SOFT, color: ACCENT_INK }}>
                    Ask Care to order these
                  </Link>
                </div>
              )}
              {plan.alternatives.length > 0 && (
                <>
                  <div className="mt-1 text-[13px] font-semibold text-[var(--muted)]">Other ideas</div>
                  {plan.alternatives.map((r) => <RecipeCard key={r.name} recipe={r} />)}
                </>
              )}
              <p className="text-[12px] text-[var(--faint)]">
                Assumes you have {plan.assumedStaples.join(", ")}. Cooking ideas only, not nutrition or medical advice.
              </p>
            </section>
          )}
        </>
      )}

      {scan?.provenance && (
        <p className="mt-6 text-center text-[11px] text-[var(--faint)]">
          Ingredients proposed by {scan.provenance.provider} ({scan.provenance.model}, {scan.provenance.mode}); checked in code and by you.
        </p>
      )}
    </main>
  );
}
