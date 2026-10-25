import type { NormalizedListing, PriceComparison } from "@/agents/care/priceCompare";

function unit(price: number | null, label: string | null): string {
  if (price === null || !label) return "";
  return price < 0.1 ? `${(price * 100).toFixed(1)}¢/${label}` : `$${price.toFixed(2)}/${label}`;
}

const VERDICT: Record<PriceComparison["verification"]["status"], { text: string; color: string }> = {
  verified: { text: "Price verified", color: "#2f7d4f" },
  higher_than_market: { text: "Above market", color: "#b26a00" },
  lower_than_market: { text: "Below market", color: "#2f5586" },
  unverified: { text: "Unverified", color: "#8a93a6" },
};

function tag(l: NormalizedListing): string | null {
  if (l.outlier) return "suspicious price";
  if (!l.matches) return "not comparable";
  if (l.availability === "out_of_stock") return "out of stock";
  return null;
}

/** Source, freshness and per-unit comparison for a Care price check. */
export function PriceComparisonCard({ data }: { data: PriceComparison }) {
  const v = VERDICT[data.verification.status];
  const rec = data.recommendation;
  return (
    <div className="mt-2 rounded-xl border border-black/5 bg-[#f7f9fc] p-2.5 text-[12px] leading-snug">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold" style={{ color: v.color }}>{v.text}</span>
        <span className="text-[#8a93a6]">
          {data.sourceLabel} · {data.freshness.stale ? "stale, " : ""}
          {data.freshness.label}
          {data.cached ? " (cached)" : ""}
        </span>
      </div>
      <div className="mt-1 text-[#4a5368]">
        Usual: {data.candidate.name}, ${data.candidate.price.toFixed(2)} {unit(data.candidate.unitPrice, data.candidate.unitLabel)}
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {data.listings.map((l) => {
          const t = tag(l);
          const chosen = rec.choice === l.id;
          return (
            <li key={l.id} className="flex items-baseline justify-between gap-2" style={{ opacity: t ? 0.55 : 1 }}>
              <span className="min-w-0 truncate">
                {chosen ? "★ " : ""}
                <a href={l.link} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-black/20">
                  {l.merchant}
                </a>{" "}
                <span className="text-[#8a93a6]">{l.size?.label ?? ""}</span>
                {t ? <span className="ml-1 text-[#b26a00]">({t})</span> : null}
              </span>
              <span className="shrink-0 tabular-nums">
                ${l.price.toFixed(2)} <span className="text-[#8a93a6]">{unit(l.unitPrice, l.unitLabel)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {data.rejected.length > 0 && (
        <div className="mt-1 text-[#8a93a6]">{data.rejected.length} listing(s) dropped by validation.</div>
      )}
      <div className="mt-1.5 border-t border-black/5 pt-1.5 text-[#4a5368]">
        <span className="font-semibold">Recommendation:</span> {rec.choice === "candidate" ? "keep your usual product" : `${rec.merchant}, $${rec.price.toFixed(2)}`}. {rec.reason}
      </div>
    </div>
  );
}
