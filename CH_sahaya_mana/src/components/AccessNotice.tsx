import { isAgentError } from "@/agents/base/errors";
import { authConfig } from "@/lib/auth/identity";

/** Safe, actionable message for signed-out / unconfigured / unavailable states (no stack traces, no data). */
export function AccessNotice({ error }: { error: unknown }) {
  const code = isAgentError(error) ? error.code : "INTERNAL";
  const message = isAgentError(error) ? error.message : "Something went wrong. Please try again.";
  const canSignIn = authConfig(process.env).provider === "auth0" && code === "UNAUTHENTICATED";
  return (
    <div role="alert" className="mx-5 my-6 rounded-[var(--radius-card)] border-2 border-line bg-surface p-5">
      <p className="text-xl font-bold">{code === "STORAGE_UNAVAILABLE" ? "Can't reach your saved information" : code === "UNAUTHENTICATED" ? "Please sign in" : "Something went wrong"}</p>
      <p className="mt-2 text-lg text-ink-muted">{message}</p>
      {canSignIn && (
        <a href="/auth/login" className="mt-4 inline-flex min-h-12 items-center rounded-full bg-brand px-6 text-lg font-bold text-white">
          Sign in
        </a>
      )}
      {!canSignIn && code === "UNAUTHENTICATED" && (
        <p className="mt-3 text-base text-ink-muted">Owners: the setup steps are in PROGRESS.md (“Setup”) in the repository.</p>
      )}
    </div>
  );
}
