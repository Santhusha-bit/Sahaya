import Link from "next/link";
import { agentMeta, AGENT_IDS } from "@/agents/registry";
import { getCurrentUser } from "@/lib/user";
import { AGENT_ICONS, MicIcon, ShieldCheckIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function HomePage() {
  const meta = agentMeta();
  const user = getCurrentUser();
  const firstName = user.name.split(" ")[0];

  return (
    <main className="px-5 pt-7">
      {/* Brand bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-xl text-white"
            style={{ background: "var(--brand-grad)", boxShadow: "var(--shadow-brand)" }}
          >
            <ShieldCheckIcon width={19} height={19} />
          </div>
          <span className="text-[19px] font-extrabold tracking-tight">Sahaya</span>
        </div>
        <Link
          href="/profile"
          className="btn flex h-10 w-10 items-center justify-center rounded-full bg-white text-[15px] font-bold text-[var(--brand)] shadow-sm"
          style={{ border: "1px solid var(--line)" }}
          aria-label="Profile"
        >
          {firstName.charAt(0)}
        </Link>
      </div>

      {/* Hero: greeting + voice-first mic */}
      <section className="fade-up mt-8 text-center">
        <p className="eyebrow text-[var(--brand-ink)]">Sahaya</p>
        <h1 className="mt-2 text-[30px] font-extrabold leading-tight tracking-tight">
          {greeting()}, {firstName}.
        </h1>
        <p className="mt-1.5 text-[16px] leading-relaxed text-[var(--muted)]">
          How can I help you today?
        </p>

        {/* Tap to speak */}
        <div className="mt-8 flex flex-col items-center">
          <Link
            href="/agents/guardian"
            aria-label="Tap to speak with Sahaya"
            className="btn relative flex h-28 w-28 items-center justify-center"
          >
            <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-[var(--brand)]/15 [animation-duration:2.5s]" />
            <span aria-hidden className="absolute inset-3 rounded-full bg-[var(--brand)]/10" />
            <span
              className="relative flex h-20 w-20 items-center justify-center rounded-full text-white"
              style={{ background: "var(--brand-grad)", boxShadow: "var(--shadow-brand)" }}
            >
              <MicIcon width={32} height={32} />
            </span>
          </Link>
          <p className="mt-3 text-[13px] font-medium text-[var(--muted)]">Tap to speak</p>
          <Link
            href="/call"
            className="btn pill mt-4 px-4 py-2 text-[14px] font-semibold"
            style={{ background: "var(--brand-soft)", color: "var(--brand-ink)" }}
          >
            Start a protected call
          </Link>
        </div>

        <Link
          href="/shop"
          className="btn card card-interactive mt-6 flex min-h-14 items-center justify-center gap-2 px-4 text-[17px] font-bold"
          style={{ color: "#2f5586" }}
        >
          🛒 Order my groceries
        </Link>
      </section>

      {/* Agent grid (2x2) */}
      <section className="mt-9">
        <div className="mb-3">
          <h2 className="eyebrow">Your companions</h2>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {AGENT_IDS.map((id, i) => {
            const m = meta[id];
            const Icon = AGENT_ICONS[m.theme.icon] ?? AGENT_ICONS.shield;
            return (
              <Link
                key={id}
                href={`/agents/${id}`}
                className={`card card-interactive fade-up stagger-${Math.min(i + 1, 4)} flex flex-col items-center gap-3 p-4 text-center`}
              >
                <span
                  className="flex h-12 w-12 items-center justify-center rounded-2xl"
                  style={{ background: m.theme.accentSoft, color: m.theme.accent }}
                >
                  <Icon width={24} height={24} />
                </span>
                <div className="text-[16px] font-bold tracking-tight" style={{ color: m.theme.accent }}>
                  {m.displayName}
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}
