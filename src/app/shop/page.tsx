"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IntegrationStatus } from "@/lib/env";
import type { CartLine, TrackingStep } from "@/agents/care/shopping/types";
import { CheckIcon, ChevronLeftIcon, MicIcon, SendIcon } from "@/components/icons";
import { createRecognizer, speak, speechRecognitionSupported } from "@/lib/speech";

interface Snapshot {
  profile: { displayName: string; paymentLabel: string; spendingLimit: number; ordersInHistory: number; usualItems: { key: string; label: string }[] };
  cart: null | {
    cartId: string;
    lines: CartLine[];
    subtotal: number;
    deliveryFee: number;
    total: number;
    cartHash: string;
    searchBackend: string;
    spoken: string;
  };
  approval: null | { id: string; title: string; description: string };
  order: null | {
    orderId: string;
    order: { orderRef?: string; total?: number; itemCount?: number; notice?: string; paymentLabel?: string; placedAt?: number };
    steps: TrackingStep[];
    current: TrackingStep;
  };
  integrations: IntegrationStatus[];
}

const ACCENT = "#2f5586";
const ACCENT_BG = "linear-gradient(135deg,#3a6aa6,#4779b8)";

function money(n: number | undefined) {
  return `$${(n ?? 0).toFixed(2)}`;
}

function StepDots({ step }: { step: number }) {
  const labels = ["Ask", "Review", "Approve", "Track"];
  return (
    <ol className="mt-4 grid grid-cols-4 gap-1.5" aria-label={`Step ${step} of 4: ${labels[step - 1]}`}>
      {labels.map((l, i) => {
        const n = i + 1;
        const done = n < step;
        const active = n === step;
        return (
          <li key={l} className="flex flex-col items-center gap-1" aria-current={active ? "step" : undefined}>
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full text-[15px] font-bold"
              style={{
                background: done || active ? "#fff" : "rgba(255,255,255,.25)",
                color: done || active ? ACCENT : "#fff",
                outline: active ? "3px solid #fff" : undefined,
                outlineOffset: 2,
              }}
            >
              {done ? <CheckIcon width={18} height={18} /> : n}
            </span>
            <span className="text-[13px] font-semibold text-white">{l}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Badge({ line }: { line: CartLine }) {
  const s =
    line.decision === "usual"
      ? { bg: "#d1fae5", fg: "#065f46", text: "Your usual" }
      : line.decision === "substituted"
        ? { bg: "#fef3c7", fg: "#7c4a03", text: "Swapped" }
        : { bg: "#eceff3", fg: "#3d4a56", text: "Left off" };
  return (
    <span className="pill px-2.5 py-0.5 text-[13px] font-bold" style={{ background: s.bg, color: s.fg }}>
      {s.text}
    </span>
  );
}

export default function ShopPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [careSays, setCareSays] = useState("");
  const [typed, setTyped] = useState("");
  const [voiceOn, setVoiceOn] = useState(true);
  const lastCartId = useRef<string | null>(null);

  const say = useCallback(
    (text: string) => {
      setCareSays(text);
      if (voiceOn && text) void speak(text);
    },
    [voiceOn],
  );

  const refresh = useCallback(async (): Promise<Snapshot | null> => {
    try {
      const s = (await (await fetch("/api/care/shopping", { cache: "no-store" })).json()) as Snapshot;
      setSnap(s);
      return s;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh().then((s) => {
      lastCartId.current = s?.cart?.cartId ?? null;
    });
  }, [refresh]);

  // While an order is on its way, keep tracking fresh.
  const delivered = snap?.order?.current.stage === "delivered";
  const hasOrder = !!snap?.order;
  useEffect(() => {
    if (!hasOrder || delivered) return;
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [hasOrder, delivered, refresh]);

  const ask = useCallback(
    async (text: string, via: "voice" | "text") => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setHeard(trimmed);
      setTyped("");
      setBusy("ask");
      setCareSays("");
      try {
        const res = await fetch("/api/agents/care/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed, via }),
        });
        const data = await res.json();
        const s = await refresh();
        const newCart = s?.cart && s.cart.cartId !== lastCartId.current;
        lastCartId.current = s?.cart?.cartId ?? null;
        const replyText = String(data?.reply?.text ?? "").split("\n\n")[0];
        say(newCart && s?.cart ? `${replyText} ${s.cart.spoken}` : replyText || "Done.");
      } catch {
        say("Sorry, I couldn't reach Care just now. Please try again.");
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh, say],
  );

  const startListening = useCallback(() => {
    if (listening || busy) return;
    const rec = createRecognizer({
      onResult: (t) => void ask(t, "voice"),
      onEnd: () => setListening(false),
      onError: () => setListening(false),
    });
    if (!rec) {
      say("Voice isn't available in this browser. You can tap the big button below or type instead.");
      return;
    }
    setListening(true);
    rec.start();
  }, [listening, busy, ask, say]);

  const remove = useCallback(
    async (itemKey: string, label: string) => {
      if (!snap?.cart || busy) return;
      setBusy(`remove:${itemKey}`);
      try {
        const res = await fetch("/api/care/shopping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove", cartId: snap.cart.cartId, itemKey }),
        });
        const s = (await res.json()) as Snapshot;
        setSnap(s);
        lastCartId.current = s.cart?.cartId ?? null;
        say(`I took off the ${label.toLowerCase()}. Your new total is ${money(s.cart?.total)}.`);
      } finally {
        setBusy(null);
      }
    },
    [snap, busy, say],
  );

  const decide = useCallback(
    async (decision: "approve" | "reject") => {
      if (!snap?.approval || busy) return;
      setBusy(decision);
      try {
        const res = await fetch(`/api/agents/care/approvals/${snap.approval.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        const data = await res.json();
        await refresh();
        if (decision === "reject") say("Okay, I won't buy anything. Your cart is saved if you change your mind.");
        else say(data?.record?.summary ?? "Your order is placed.");
      } finally {
        setBusy(null);
      }
    },
    [snap, busy, refresh, say],
  );

  const cart = snap?.cart ?? null;
  const order = snap?.order ?? null;
  const showOrder = !!order;
  const step = cart && snap?.approval ? 3 : cart ? 2 : order ? 4 : 1;
  const kept = cart?.lines.filter((l) => l.decision !== "skipped") ?? [];
  const leftOff = cart?.lines.filter((l) => l.decision === "skipped") ?? [];
  const apify = snap?.integrations.find((i) => i.key === "apify");

  return (
    <main className="pb-36 text-[17px]">
      <header className="sticky top-0 z-30 rounded-b-[26px] px-4 pb-4 pt-4 text-white shadow-lg" style={{ background: ACCENT_BG }}>
        <div className="flex items-center gap-3">
          <Link
            href="/agents/care"
            className="btn flex h-11 w-11 items-center justify-center rounded-full bg-white/25 ring-1 ring-inset ring-white/30"
            aria-label="Back to Care"
          >
            <ChevronLeftIcon width={22} height={22} />
          </Link>
          <h1 className="text-[24px] font-extrabold tracking-tight">Groceries</h1>
          <button
            onClick={() => setVoiceOn((v) => !v)}
            className="btn ml-auto min-h-11 rounded-full bg-white/25 px-4 text-[15px] font-semibold ring-1 ring-inset ring-white/30"
            aria-pressed={voiceOn}
          >
            {voiceOn ? "🔊 Voice on" : "🔈 Voice off"}
          </button>
        </div>
        <StepDots step={step} />
      </header>

      {/* Care's spoken reply, also announced to screen readers. */}
      <div aria-live="polite" className="px-4">
        {(heard || careSays || busy === "ask") && (
          <section className="card fade-up mt-4 p-4">
            {heard && (
              <p className="text-[16px] text-[var(--muted)]">
                You said: <span className="font-semibold text-[var(--ink)]">“{heard}”</span>
              </p>
            )}
            <p className="mt-1.5 text-[18px] leading-relaxed">
              {busy === "ask" ? "Care is putting your cart together…" : careSays}
            </p>
          </section>
        )}
      </div>

      {/* Step 1: ask */}
      <section className="px-4" aria-labelledby="ask-h">
        <div className="card mt-4 flex flex-col items-center p-5 text-center">
          <h2 id="ask-h" className="text-[20px] font-extrabold">
            {cart ? "Want to change anything?" : `What do you need${snap ? `, ${snap.profile.displayName}` : ""}?`}
          </h2>
          <button
            onClick={startListening}
            disabled={!!busy}
            className={`btn mt-4 flex h-24 w-24 items-center justify-center rounded-full text-white disabled:opacity-50 ${listening ? "mic-live" : ""}`}
            style={{ background: listening ? "#dc2626" : ACCENT, boxShadow: "0 8px 24px rgba(47,85,134,.35)" }}
            aria-label={listening ? "Listening" : "Tap and speak"}
          >
            <MicIcon width={44} height={44} />
          </button>
          <p className="mt-2 text-[16px] font-semibold" style={{ color: ACCENT }}>
            {listening ? "Listening… go ahead" : speechRecognitionSupported() ? "Tap and speak" : "Voice not available here"}
          </p>
          <p className="mt-1 text-[15px] text-[var(--muted)]">
            {cart ? "Try “take off the eggs” or “where is my order?”" : "Try “I need my usual groceries”"}
          </p>
          {!cart && (
            <button
              onClick={() => void ask("I need my usual groceries", "text")}
              disabled={!!busy}
              className="btn mt-4 min-h-14 w-full rounded-2xl text-[18px] font-bold text-white disabled:opacity-50"
              style={{ background: ACCENT_BG }}
            >
              Order my usual groceries
            </button>
          )}
          <form
            className="mt-3 flex w-full items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(typed, "text");
            }}
          >
            <label htmlFor="shop-type" className="sr-only">
              Or type what you need
            </label>
            <input
              id="shop-type"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Or type here…"
              className="min-h-12 flex-1 rounded-xl border border-[var(--line-strong)] bg-white px-3 text-[17px] outline-none focus:border-[#2f5586]"
            />
            <button
              type="submit"
              disabled={!typed.trim() || !!busy}
              className="btn flex h-12 w-12 items-center justify-center rounded-xl text-white disabled:opacity-40"
              style={{ background: ACCENT }}
              aria-label="Send"
            >
              <SendIcon width={22} height={22} />
            </button>
          </form>
        </div>
      </section>

      {loading && <p className="px-4 pt-6 text-center text-[var(--muted)]">Loading…</p>}

      {/* Step 2 + 3: review and approve */}
      {cart && (
        <section className="px-4" aria-labelledby="cart-h">
          <div className="card mt-4 overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[var(--line)] p-4">
              <h2 id="cart-h" className="text-[22px] font-extrabold">
                Your cart
              </h2>
              <span className="text-[16px] text-[var(--muted)]">
                {kept.length} item{kept.length === 1 ? "" : "s"}
              </span>
              <button
                onClick={() => say(cart.spoken)}
                className="btn ml-auto min-h-11 rounded-full px-4 text-[15px] font-semibold"
                style={{ background: "#e8f0fa", color: ACCENT }}
              >
                🔊 Read aloud
              </button>
            </div>
            <ul>
              {cart.lines.map((l) => (
                <li key={l.itemKey} className="border-b border-[var(--line)] p-4" style={l.decision === "skipped" ? { background: "#f7f8fa" } : undefined}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[19px] font-bold leading-snug">{l.label}</span>
                        <Badge line={l} />
                      </div>
                      {l.productName && (
                        <div className="mt-0.5 text-[15px] text-[var(--muted)]">
                          {l.quantity > 1 ? `${l.quantity} × ` : ""}
                          {l.productName}
                          {l.size ? `, ${l.size}` : ""}
                        </div>
                      )}
                      {l.decision !== "usual" && <p className="mt-1.5 text-[16px] leading-snug">{l.reason}</p>}
                    </div>
                    {l.decision !== "skipped" && <div className="text-[19px] font-bold tabular-nums">{money(l.lineTotal)}</div>}
                  </div>
                  {l.decision !== "skipped" && snap?.approval && (
                    <button
                      onClick={() => void remove(l.itemKey, l.label)}
                      disabled={!!busy}
                      className="btn mt-2 min-h-11 rounded-xl border border-[var(--line-strong)] px-4 text-[15px] font-semibold text-[var(--muted)] disabled:opacity-50"
                      aria-label={`Remove ${l.label}`}
                    >
                      {busy === `remove:${l.itemKey}` ? "Removing…" : "Remove"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <dl className="space-y-1.5 p-4 text-[17px]">
              <div className="flex justify-between">
                <dt className="text-[var(--muted)]">Groceries</dt>
                <dd className="tabular-nums">{money(cart.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--muted)]">Delivery</dt>
                <dd className="tabular-nums">{cart.deliveryFee ? money(cart.deliveryFee) : "Free"}</dd>
              </div>
              <div className="flex items-baseline justify-between border-t border-[var(--line)] pt-2">
                <dt className="text-[22px] font-extrabold">Total</dt>
                <dd className="text-[32px] font-extrabold tabular-nums" style={{ color: ACCENT }}>
                  {money(cart.total)}
                </dd>
              </div>
              <div className="flex justify-between pt-1 text-[15px]">
                <dt className="text-[var(--muted)]">Pay with</dt>
                <dd className="font-semibold">{snap?.profile.paymentLabel}</dd>
              </div>
            </dl>
            {leftOff.length > 0 && (
              <p className="px-4 pb-3 text-[15px] text-[var(--muted)]">
                {leftOff.length} item{leftOff.length === 1 ? " was" : "s were"} left off and won't be charged.
              </p>
            )}
          </div>

          {snap?.approval ? (
            <div className="card mt-4 p-4" style={{ borderColor: "#a7f3d0" }}>
              <p id="approve-desc" className="text-[16px] leading-snug text-[var(--muted)]">
                Nothing is bought until you tap Approve. {snap.approval.description}
              </p>
              <button
                onClick={() => void decide("approve")}
                disabled={!!busy}
                aria-describedby="approve-desc"
                className="btn mt-3 flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-700 text-[20px] font-extrabold text-white shadow-md disabled:opacity-50"
              >
                <CheckIcon width={26} height={26} />
                {busy === "approve" ? "Placing order…" : `Approve and pay ${money(cart.total)}`}
              </button>
              <button
                onClick={() => void decide("reject")}
                disabled={!!busy}
                className="btn mt-2 min-h-12 w-full rounded-2xl bg-[var(--bg-tint)] text-[17px] font-semibold text-[var(--ink)] disabled:opacity-50"
              >
                Not now
              </button>
            </div>
          ) : (
            <button
              onClick={() => void ask("I need my usual groceries", "text")}
              disabled={!!busy}
              className="btn mt-4 min-h-14 w-full rounded-2xl text-[18px] font-bold text-white disabled:opacity-50"
              style={{ background: ACCENT_BG }}
            >
              Rebuild my cart
            </button>
          )}
        </section>
      )}

      {/* Step 4: track */}
      {showOrder && order && (
        <section className="px-4" aria-labelledby="order-h">
          <div className="card mt-4 p-4">
            <div className="flex items-baseline gap-2">
              <h2 id="order-h" className="text-[22px] font-extrabold">
                Your order
              </h2>
              <span className="ml-auto text-[17px] font-bold tabular-nums">{money(order.order.total)}</span>
            </div>
            <p className="text-[15px] text-[var(--muted)]">
              {order.order.itemCount} items · Order {order.order.orderRef}
            </p>
            <ol className="mt-4 space-y-3" aria-label="Delivery progress">
              {order.steps.map((s) => (
                <li key={s.stage} className="flex items-center gap-3">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                    style={{ background: s.done ? "#047857" : "#eceff3", color: s.done ? "#fff" : "#6b7785" }}
                    aria-hidden
                  >
                    {s.done ? <CheckIcon width={20} height={20} /> : "•"}
                  </span>
                  <span className={`text-[18px] ${s.stage === order.current.stage ? "font-extrabold" : s.done ? "font-semibold" : "text-[var(--muted)]"}`}>
                    {s.label}
                    <span className="sr-only">{s.done ? " (done)" : " (not yet)"}</span>
                  </span>
                </li>
              ))}
            </ol>
            <button
              onClick={() => void refresh().then((s) => s?.order && say(`Your order is: ${s.order.current.label.toLowerCase()}.`))}
              className="btn mt-4 min-h-12 w-full rounded-2xl text-[17px] font-semibold"
              style={{ background: "#e8f0fa", color: ACCENT }}
            >
              Check delivery status
            </button>
            {order.order.notice && (
              <p className="mt-3 rounded-xl bg-amber-50 p-3 text-[15px] leading-snug text-amber-900">{order.order.notice}</p>
            )}
          </div>
        </section>
      )}

      {/* Honest integration labels */}
      {snap && (
        <section className="px-4 pt-5" aria-label="How this works">
          <ul className="space-y-1.5 text-[14px] leading-snug text-[var(--muted)]">
            {snap.integrations.map((i) => (
              <li key={i.key}>
                <span className="font-semibold text-[var(--ink)]">{i.label}</span>: {i.mode}.{" "}
                {i.key === "apify" && cart ? `This cart's prices came from ${cart.searchBackend === "apify" ? "live Apify search" : cart.searchBackend === "mixed" ? "live Apify search plus the sandbox catalog" : "the sandbox catalog"}.` : ""}
              </li>
            ))}
          </ul>
          {apify?.mode !== "live" && <p className="mt-1 text-[13px] text-[var(--faint)]">Set APIFY_TOKEN to search live product listings.</p>}
        </section>
      )}
    </main>
  );
}
