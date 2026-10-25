export type AgentErrorCode =
  | "VALIDATION_FAILED"
  | "PERMISSION_DENIED"
  | "ISOLATION_VIOLATION"
  | "TOOL_NOT_FOUND"
  | "APPROVAL_INVALID"
  | "INTEGRATION_UNAVAILABLE"
  | "CONSENT_REQUIRED"
  | "EVENT_REJECTED"
  | "TOOL_FAILED"
  | "NOT_FOUND"
  /** No verified identity (signed out, expired, or sign-in not configured). Fails closed. */
  | "UNAUTHENTICATED"
  /** The required persistent store is not configured or not reachable. Never falls back to local storage. */
  | "STORAGE_UNAVAILABLE"
  /** A consequential external action (booking, payment, contacting a provider) refused by demo-only enforcement. */
  | "DEMO_MODE_BLOCKED";

const BRAND = Symbol.for("sahaya.AgentError");

export class AgentError extends Error {
  readonly [BRAND] = true;
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly details?: unknown,
    /** Whether the operation may succeed if retried unchanged. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

/** Bundle-safe check: `instanceof` fails when the module is duplicated across server chunks. */
export function isAgentError(err: unknown): err is AgentError {
  return typeof err === "object" && err !== null && (err as Record<symbol, unknown>)[BRAND] === true;
}

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
