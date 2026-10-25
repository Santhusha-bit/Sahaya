/**
 * Renders a company's real logo next to each integration.
 *
 * Brands with an official open-source (CC0) mark are shipped as SVG files in
 * /public/logos and rendered as <img>. Brands without a publicly available mark
 * fall back to an original monogram badge (first initial), so we never guess at
 * or imitate a logo we don't have.
 */

type Mono = { letter: string; bg: string; fg: string };

// Integration keys (see src/lib/env.ts) that have a real logo file in /public/logos.
const LOGO_FILES: Record<string, true> = {
  claude: true,
  convex: true,
  auth0: true,
  elastic: true,
  jira: true,
  snowflake: true,
  tigerdata: true,
};

// Original monogram badges for brands without a public SVG mark.
const MONOGRAMS: Record<string, Mono> = {
  cartesia: { letter: "C", bg: "#6d28d9", fg: "#ffffff" },
  twilio: { letter: "T", bg: "#f22f46", fg: "#ffffff" },
  fetchai: { letter: "F", bg: "#111b3a", fg: "#ffffff" },
  armadin: { letter: "A", bg: "#334155", fg: "#ffffff" },
  moss: { letter: "M", bg: "#2e7d32", fg: "#ffffff" },
  bitdeer: { letter: "B", bg: "#111827", fg: "#f97316" },
  backboard: { letter: "B", bg: "#0ea5e9", fg: "#ffffff" },
};

export function BrandLogo({ brandKey, label, size = 28 }: { brandKey: string; label: string; size?: number }) {
  const box: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: 8,
    flexShrink: 0,
  };

  if (LOGO_FILES[brandKey]) {
    return (
      <span
        className="flex items-center justify-center border border-[var(--line)] bg-white"
        style={box}
        aria-hidden
      >
        <img
          src={`/logos/${brandKey}.svg`}
          alt=""
          width={Math.round(size * 0.64)}
          height={Math.round(size * 0.64)}
          loading="lazy"
          decoding="async"
        />
      </span>
    );
  }

  const m = MONOGRAMS[brandKey] ?? { letter: label.charAt(0).toUpperCase(), bg: "#64748b", fg: "#ffffff" };
  return (
    <span
      className="flex items-center justify-center font-extrabold"
      style={{ ...box, background: m.bg, color: m.fg, fontSize: Math.round(size * 0.46) }}
      aria-hidden
    >
      {m.letter}
    </span>
  );
}
