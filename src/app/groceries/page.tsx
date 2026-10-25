"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { IntegrationStatus } from "@/lib/env";
import { CheckIcon, XIcon } from "@/components/icons";

/** Shapes returned by Care's discoverGroceryProducts / prepareGroceryCart tools. */
interface Option {
  offerId: string;
  name: string;
  brand: string | null;
  size: string | null;
  price: number | null;
  currency: string | null;
  pricePer: string | null;
  retailer: string | null;
  storeLocation: string | null;
  availability: string;
  priceObservedAt: string | null;
  sourceUrl: string;
  imageUrl: string | null;
  matchScore: number;
}
interface DiscoveredItem {
  query: string;
  quantity: number;
  status: "priced" | "unpriced" | "not_found" | "error";
  options: Option[];
}
interface Discovery {
  discoveryId: string;
  backend: "apify" | "local" | "sandbox";
  run: { runId: string; consoleUrl: string; status: string; datasetId: string } | null;
  items: DiscoveredItem[];
  warnings: string[];
}
interface CartLine {
  query: string;
  name: string;
  quantity: number;
  price: number;
  lineTotal: number;
  pricePer: string | null;
  retailer: string | null;
  sourceUrl: string;
  estimated: boolean;
  reason: string;
}
interface Cart {
  cartId: string;
  approvalId: string | null;
  total: number;
  lines: CartLine[];
  missing: { query: string; reason: string }[];
  retailers: string[];
}

const CARE = { accent: "#4779b8", ink: "#2f5586", soft: "#e8f0fa" };

const BACKEND_BADGE: Record<Discovery["backend"], { label: string; bg: string; color: string }> = {
  apify: { label: "Live Apify run", bg: "#d1fae5", color: "#065f46" },
  local: { label: "Actor code, local (not Apify)", bg: "#fef3c7", color: "#92400e" },
  sandbox: { label: "Offline sandbox", bg: "#fee2e2", color: "#991b1b" },
};

const AVAILABILITY: Record<string, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  recently_seen: "Seen on shelf recently",
  previously_seen: "Seen on shelf earlier",
  unknown: "Availability unknown",
};

function money(n: number | null | undefined): string {
  return typeof n === "number" ? `$${n.toFixed(2)}` : "no price";
}

export default function GroceriesPage() {
  const [list, setList] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  const [busy, setBusy] = useState<null | "discover" | "cart" | "decide" | "save">(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/care/groceries")
      .then((r) => r.json())
      .then((d: { status: IntegrationStatus; usual: string[] }) => {
        setStatus(d.status);
        setList(d.usual);
      })
      .catch(() => setError("Couldn't load your usual groceries."));
  }, []);

  useEffect(() => {
    if (busy !== "discover") return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [busy]);

  const addItem = () => {
    const parts = draft.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    setList((l) => [...l, ...parts.filter((p) => !l.some((x) => x.toLowerCase() === p.toLowerCase()))]);
    setDraft("");
  };

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/care/groceries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function discover() {
    if (!list.length) return;
    setBusy("discover");
    setError(null);
    setNotice(null);
    setCart(null);
    setDecision(null);
    setElapsed(0);
    try {
      const d = await post({ action: "discover", items: list });
      if (!d.ok) throw new Error(d.record?.error || d.record?.summary || "Product search failed");
      setDiscovery(d.record.output as Discovery);
      if (d.status) setStatus(d.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function prepareCart() {
    if (!discovery) return;
    setBusy("cart");
    setError(null);
    try {
      const d = await post({ action: "cart", discoveryId: discovery.discoveryId });
      if (!d.ok) throw new Error(d.record?.summary || "Couldn't build a cart");
      setCart(d.record.output as Cart);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function decide(choice: "approve" | "reject") {
    if (!cart?.approvalId) return;
    setBusy("decide");
    try {
      const res = await fetch(`/api/agents/care/approvals/${cart.approvalId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: choice }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Approval failed");
      setDecision(choice === "approve" ? "approved" : "rejected");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveUsual() {
    setBusy("save");
    try {
      const d = await post({ action: "saveUsual", items: list });
      setNotice(d.ok ? "Saved as your usual groceries." : "Couldn't save the list.");
    } finally {
      setBusy(null);
    }
  }

  const modeStyle =
    status?.mode === "live" ? { bg: "#d1fae5", color: "#065f46" } : { bg: "#fef3c7", color: "#92400e" };

  return (
    <main className="px-5 pb-28 pt-8">
      <div className="flex items-center gap-2">
        <Link
          href="/agents/care"
          className="btn flex h-9 w-9 items-center justify-center rounded-full bg-white text-[18px] text-[var(--muted)] shadow-sm"
          style={{ border: "1px solid var(--line)" }}
          aria-label="Back to Care"
        >
          ‹
        </Link>
        <h1 className="text-[28px] font-extrabold tracking-tight">Grocery run</h1>
      </div>
      <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--muted)]">
        Care looks up fresh product prices for your list, compares them, and builds a cart for you to approve.
      </p>

      {status && (
        <div className="card mt-4 p-3.5">
          <div className="flex items-center gap-2">
            <div className="text-[14px] font-bold tracking-tight">{status.label}</div>
            <span
              className="ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide"
              style={{ background: modeStyle.bg, color: modeStyle.color }}
            >
              {status.mode}
            </span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--muted)]">{status.detail}</p>
        </div>
      )}

      <h2 className="eyebrow mt-6">Shopping list</h2>
      <section className="card mt-3 p-4">
        <div className="flex flex-wrap gap-2">
          {list.map((item) => (
            <span
              key={item}
              className="flex items-center gap-1.5 rounded-full py-1.5 pl-3 pr-2 text-[14px] font-semibold"
              style={{ background: CARE.soft, color: CARE.ink }}
            >
              {item}
              <button
                className="btn flex h-5 w-5 items-center justify-center rounded-full"
                onClick={() => setList((l) => l.filter((x) => x !== item))}
                aria-label={`Remove ${item}`}
              >
                <XIcon width={12} height={12} />
              </button>
            </span>
          ))}
          {!list.length && <span className="text-[14px] text-[var(--muted)]">Your list is empty.</span>}
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addItem();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add an item, e.g. 2 x eggs"
            className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2.5 text-[15px] outline-none"
            style={{ border: "1px solid var(--line-strong)" }}
            aria-label="Add grocery item"
          />
          <button type="submit" className="btn rounded-xl px-4 text-[14px] font-bold" style={{ background: CARE.soft, color: CARE.ink }}>
            Add
          </button>
        </form>
        <div className="mt-3 flex gap-2">
          <button
            onClick={discover}
            disabled={!list.length || busy !== null}
            className="btn flex-1 rounded-xl py-3 text-[15px] font-bold text-white disabled:opacity-50"
            style={{ background: CARE.accent }}
          >
            {busy === "discover" ? `Finding fresh prices… ${elapsed}s` : "Find fresh prices"}
          </button>
          <button
            onClick={saveUsual}
            disabled={!list.length || busy !== null}
            className="btn rounded-xl px-3 text-[13px] font-semibold text-[var(--muted)] disabled:opacity-50"
            style={{ border: "1px solid var(--line)" }}
          >
            Save as usual
          </button>
        </div>
        {notice && <p className="mt-2 text-[13px] text-[var(--muted)]">{notice}</p>}
      </section>

      {error && (
        <div className="card mt-4 p-3.5 text-[14px]" style={{ color: "#991b1b", background: "#fee2e2" }}>
          {error}
        </div>
      )}

      {discovery && (
        <>
          <div className="mt-6 flex items-center gap-2">
            <h2 className="eyebrow">Products found</h2>
            <span
              className="ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-bold"
              style={{ background: BACKEND_BADGE[discovery.backend].bg, color: BACKEND_BADGE[discovery.backend].color }}
            >
              {BACKEND_BADGE[discovery.backend].label}
            </span>
          </div>
          {discovery.run && (
            <p className="mt-1.5 text-[13px] text-[var(--muted)]">
              Apify run{" "}
              <a href={discovery.run.consoleUrl} target="_blank" rel="noreferrer" className="font-semibold underline">
                {discovery.run.runId}
              </a>{" "}
              · {discovery.run.status} · dataset {discovery.run.datasetId}
            </p>
          )}
          <section className="mt-3 flex flex-col gap-2.5">
            {discovery.items.map((item, idx) => (
              <div key={item.query} className={`card fade-up stagger-${Math.min(idx + 1, 4)} p-3.5`}>
                <div className="flex items-baseline gap-2">
                  <div className="text-[15px] font-bold capitalize tracking-tight">
                    {item.quantity > 1 ? `${item.quantity} x ` : ""}
                    {item.query}
                  </div>
                  <div className="ml-auto text-[12px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                    {item.status === "priced" ? "priced" : item.status === "unpriced" ? "no recent price" : item.status.replace("_", " ")}
                  </div>
                </div>
                <ul className="mt-2 flex flex-col gap-2">
                  {item.options.map((o) => (
                    <li key={o.offerId} className="flex gap-3">
                      {o.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={o.imageUrl} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" style={{ background: "var(--bg-tint)" }} />
                      ) : (
                        <div className="h-11 w-11 shrink-0 rounded-lg" style={{ background: "var(--bg-tint)" }} />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <div className="truncate text-[14px] font-semibold">{o.name}</div>
                          <div className="ml-auto shrink-0 text-[14px] font-bold">
                            {money(o.price)}
                            {o.price != null && o.pricePer && o.pricePer !== "unit" ? `/${o.pricePer === "kilogram" ? "kg" : o.pricePer === "pound" ? "lb" : "L"}` : ""}
                          </div>
                        </div>
                        <div className="truncate text-[12px] text-[var(--muted)]">
                          {[o.brand, o.size, o.retailer, o.storeLocation].filter(Boolean).join(" · ")}
                        </div>
                        <div className="text-[12px] text-[var(--muted)]">
                          {AVAILABILITY[o.availability] ?? o.availability}
                          {o.priceObservedAt ? ` (${o.priceObservedAt})` : ""} ·{" "}
                          <a href={o.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                            source
                          </a>
                        </div>
                      </div>
                    </li>
                  ))}
                  {!item.options.length && <li className="text-[13px] text-[var(--muted)]">No matching products found.</li>}
                </ul>
              </div>
            ))}
          </section>
          {discovery.warnings.length > 0 && (
            <p className="mt-2 text-[12px] text-[var(--faint)]">{discovery.warnings.slice(0, 3).join(" · ")}</p>
          )}
          {!cart && (
            <button
              onClick={prepareCart}
              disabled={busy !== null}
              className="btn mt-4 w-full rounded-xl py-3 text-[15px] font-bold text-white disabled:opacity-50"
              style={{ background: CARE.accent }}
            >
              {busy === "cart" ? "Comparing…" : "Compare and prepare cart"}
            </button>
          )}
        </>
      )}

      {cart && (
        <>
          <h2 className="eyebrow mt-6">Your cart</h2>
          <section className="card mt-3 p-4">
            <ul className="flex flex-col gap-2.5">
              {cart.lines.map((l) => (
                <li key={l.query}>
                  <div className="flex items-baseline gap-2">
                    <div className="text-[14px] font-semibold">
                      {l.quantity > 1 ? `${l.quantity} x ` : ""}
                      {l.name}
                    </div>
                    <div className="ml-auto text-[14px] font-bold">{money(l.lineTotal)}</div>
                  </div>
                  <div className="text-[12px] text-[var(--muted)]">
                    {l.retailer ?? "Store unknown"} · {l.reason}{" "}
                    <a href={l.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                      source
                    </a>
                  </div>
                </li>
              ))}
            </ul>
            {cart.missing.length > 0 && (
              <p className="mt-3 text-[13px] text-[var(--muted)]">Not in cart: {cart.missing.map((m) => m.query).join(", ")}</p>
            )}
            <div className="mt-3 flex items-baseline border-t pt-3" style={{ borderColor: "var(--line)" }}>
              <div className="text-[15px] font-bold">Total</div>
              <div className="ml-auto text-[20px] font-extrabold tracking-tight">{money(cart.total)}</div>
            </div>
            {decision ? (
              <p className="mt-3 text-[14px] font-semibold" style={{ color: decision === "approved" ? "#065f46" : "#991b1b" }}>
                {decision === "approved"
                  ? "Approved. Care placed the order and asked Finance to review the payment."
                  : "Declined. Nothing was ordered."}
              </p>
            ) : (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => decide("approve")}
                  disabled={busy !== null}
                  className="btn flex flex-1 items-center justify-center gap-1.5 rounded-xl py-3 text-[15px] font-bold text-white disabled:opacity-50"
                  style={{ background: CARE.accent }}
                >
                  <CheckIcon width={16} height={16} /> Approve order
                </button>
                <button
                  onClick={() => decide("reject")}
                  disabled={busy !== null}
                  className="btn flex items-center justify-center gap-1.5 rounded-xl px-4 text-[15px] font-semibold text-[var(--muted)] disabled:opacity-50"
                  style={{ border: "1px solid var(--line)" }}
                >
                  <XIcon width={16} height={16} /> Not now
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
