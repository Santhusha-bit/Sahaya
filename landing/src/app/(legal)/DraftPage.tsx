import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Logo } from "@/components/brand/Logo";

/** Shared scaffold for the draft legal / contact pages. */
export function DraftPage({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-20">
      <Link href="/" className="inline-block">
        <Logo size={32} />
      </Link>

      <span className="mt-10 inline-flex rounded-full border border-line bg-bg-tint px-3 py-1 text-xs font-bold uppercase tracking-wide text-faint">
        Draft page
      </span>
      <h1 className="h2 mt-4">{title}</h1>

      <div className="mt-6 space-y-4 text-muted">{children}</div>

      <Link
        href="/"
        className="btn btn-secondary mt-12"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to home
      </Link>
    </main>
  );
}
