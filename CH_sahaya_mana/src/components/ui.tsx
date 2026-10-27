import type { IntegrationMode } from "@/integrations/status";

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="px-5 pb-4 pt-8">
      <h1 className="text-3xl font-bold">{title}</h1>
      {subtitle && <p className="mt-1 text-lg text-ink-muted">{subtitle}</p>}
    </header>
  );
}

export function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="px-5 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-xl font-bold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-[var(--radius-card)] bg-surface p-4 shadow-sm ${className}`}>{children}</div>;
}

const MODE_STYLE: Record<IntegrationMode, string> = {
  live: "bg-care-soft text-ok",
  sandbox: "bg-[#fdf3dc] text-warn",
  unavailable: "bg-[#fde8e6] text-danger",
};

const MODE_LABEL: Record<IntegrationMode, string> = {
  live: "Live",
  sandbox: "Sandbox",
  unavailable: "Unavailable",
};

export function ModeBadge({ mode }: { mode: IntegrationMode }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-3 py-1 text-sm font-bold ${MODE_STYLE[mode]}`}>
      {MODE_LABEL[mode]}
    </span>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded-[var(--radius-card)] border-2 border-dashed border-line p-4 text-ink-muted">{children}</p>;
}
