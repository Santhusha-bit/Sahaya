import "server-only";
import { isAgentError, type AgentErrorCode } from "@/agents/base/errors";

const STATUS: Record<AgentErrorCode, number> = {
  VALIDATION_FAILED: 400,
  PERMISSION_DENIED: 403,
  ISOLATION_VIOLATION: 403,
  CONSENT_REQUIRED: 403,
  TOOL_NOT_FOUND: 404,
  NOT_FOUND: 404,
  APPROVAL_INVALID: 409,
  EVENT_REJECTED: 422,
  INTEGRATION_UNAVAILABLE: 503,
  TOOL_FAILED: 502,
  UNAUTHENTICATED: 401,
  STORAGE_UNAVAILABLE: 503,
  DEMO_MODE_BLOCKED: 403,
};

/** Codes whose messages are written for people; the rest get a generic message so internals never leak. */
const PUBLIC_MESSAGE: Partial<Record<AgentErrorCode, string>> = {
  PERMISSION_DENIED: "You don't have access to that.",
  ISOLATION_VIOLATION: "You don't have access to that.",
  NOT_FOUND: "That item wasn't found. It may have been removed.",
  TOOL_NOT_FOUND: "That action isn't available.",
  EVENT_REJECTED: "That request couldn't be passed on.",
  TOOL_FAILED: "That didn't work. Nothing was changed; please try again.",
  DEMO_MODE_BLOCKED: "This is a demo: Sahaya can't book, pay for or contact anyone. Nothing was sent.",
};

export function errorResponse(err: unknown): Response {
  if (isAgentError(err)) {
    const message = PUBLIC_MESSAGE[err.code] ?? err.message;
    return Response.json({ error: message, code: err.code }, { status: STATUS[err.code], headers: { "Cache-Control": "no-store" } });
  }
  // Unexpected errors can carry personal data in their message; log the type only.
  console.error("[sahaya] internal error:", err instanceof Error ? err.name : typeof err);
  return Response.json({ error: "Something went wrong on the server.", code: "INTERNAL" }, { status: 500 });
}
