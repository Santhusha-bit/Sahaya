import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodRawShape } from "zod";
import type { DroidSession } from "@factory/droid-sdk/node";

/**
 * Factory Droid SDK integration: runs a bounded investigation as a separate
 * Droid execution agent from inside the running product.
 *
 * Scoping is enforced by Sahaya, not requested of the model:
 *  - The Droid runs in an empty, throwaway working directory.
 *  - Every built-in Droid tool (shell, file read/write, web, ...) is disabled.
 *    The ids come from the CLI itself (a probe session's listTools()), so a new
 *    built-in tool is disabled too.
 *  - The only tools left are Sahaya's in-process MCP tools (all read-only).
 *  - A permission handler approves only those tools; anything else is cancelled
 *    and recorded.
 *  - Documents are attached to the prompt; the Droid has no other data access.
 */

export interface DroidRunTool {
  name: string;
  description: string;
  inputShape: ZodRawShape;
  handler: (input: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface DroidRunDocument {
  name: string;
  text: string;
}

export type DroidRunEvent =
  | { kind: "status"; label: string; detail?: string }
  | { kind: "scope"; disabledToolIds: string[]; allowedTools: string[] }
  | { kind: "session"; sessionId: string }
  | { kind: "tool_call"; tool: string; input: unknown }
  | { kind: "tool_result"; tool: string; ok: boolean; preview: string }
  | { kind: "assistant"; text: string }
  | { kind: "permission"; tool: string; decision: "allowed" | "blocked" }
  | { kind: "error"; message: string };

export interface DroidRunResult {
  sessionId?: string;
  success: boolean;
  structuredOutput?: unknown;
  structuredOutputError?: string;
  text: string;
  durationMs: number;
  turnCount: number;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface DroidRunOptions {
  /** Name of the in-process MCP server that carries the tools. */
  serverName: string;
  systemPrompt: string;
  prompt: string;
  documents: DroidRunDocument[];
  tools: DroidRunTool[];
  outputSchema: Record<string, unknown>;
  onEvent: (event: DroidRunEvent) => void;
  timeoutMs?: number;
}

function has(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

export function isFactoryDroidConfigured(): boolean {
  return has("FACTORY_API_KEY");
}

/**
 * Path to the Droid CLI the SDK spawns. Order: DROID_EXEC_PATH, the platform
 * binary installed by the `droid` npm package, then `droid` on PATH.
 */
export function resolveDroidExecPath(): string {
  if (has("DROID_EXEC_PATH")) return process.env.DROID_EXEC_PATH!.trim();
  const exe = process.platform === "win32" ? "droid.exe" : "droid";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const root = join(process.cwd(), "node_modules", "@factory");
  for (const pkg of [`cli-${process.platform}-${arch}`, `cli-${process.platform}-${arch}-baseline`]) {
    for (const rel of [join("bin", exe), exe]) {
      const candidate = join(root, pkg, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "droid";
}

const PROBE_KEY = "__sahaya_droid_builtin_tools__";

/** Built-in Droid tool ids, discovered once per process from the CLI. */
async function builtinToolIds(base: { apiKey: string; execPath: string; cwd: string }): Promise<string[]> {
  const g = globalThis as Record<string, unknown>;
  if (Array.isArray(g[PROBE_KEY])) return g[PROBE_KEY] as string[];
  const sdk = await import("@factory/droid-sdk/node");
  const probe = await sdk.createSession({ ...base, autoRejectPermissionRequests: true, disableBuiltinSkills: true });
  try {
    const ids = (await probe.listTools()).map((t) => t.id);
    g[PROBE_KEY] = ids;
    return ids;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

function preview(value: unknown, max = 240): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export async function runDroidTask(opts: DroidRunOptions): Promise<DroidRunResult> {
  const startedAt = Date.now();
  const emit = opts.onEvent;
  if (!isFactoryDroidConfigured()) {
    return { success: false, text: "", durationMs: 0, turnCount: 0, error: "FACTORY_API_KEY is not set." };
  }

  const sdk = await import("@factory/droid-sdk/node");
  const apiKey = process.env.FACTORY_API_KEY!.trim();
  const execPath = resolveDroidExecPath();
  const workspace = await mkdtemp(join(tmpdir(), "sahaya-droid-"));
  const base = { apiKey, execPath, cwd: workspace };
  const allowedTools = opts.tools.map((t) => t.name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Investigation timed out.")), opts.timeoutMs ?? 240_000);
  let session: DroidSession | undefined;

  try {
    emit({ kind: "status", label: "Starting Droid", detail: `CLI: ${execPath === "droid" ? "droid (PATH)" : "bundled droid binary"}` });
    const disabledToolIds = await builtinToolIds(base);
    emit({ kind: "scope", disabledToolIds, allowedTools });

    const server = sdk.createSdkMcpServer({
      name: opts.serverName,
      tools: opts.tools.map((t) =>
        sdk.tool(
          t.name,
          t.description,
          t.inputShape,
          async (input) => {
            try {
              const out = await t.handler(input as Record<string, unknown>);
              emit({ kind: "tool_result", tool: t.name, ok: true, preview: preview(out) });
              return JSON.stringify(out);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              emit({ kind: "tool_result", tool: t.name, ok: false, preview: message });
              return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
            }
          },
          { annotations: { readOnlyHint: true } },
        ),
      ),
    });

    session = await sdk.createSession({
      ...base,
      mcpServers: [server],
      disabledToolIds,
      disableBuiltinSkills: true,
      autonomyLevel: sdk.AutonomyLevel.Low,
      systemPrompt: opts.systemPrompt,
      ...(has("FACTORY_DROID_MODEL") ? { modelId: process.env.FACTORY_DROID_MODEL!.trim() } : {}),
      abortSignal: controller.signal,
      permissionHandler: ({ toolUses }) => {
        // Only Sahaya's own investigation tools may run. Everything else is refused.
        const ok =
          toolUses.length > 0 &&
          toolUses.every((u) => {
            const d = u.details as { type?: string; serverName?: string; toolName?: string; actualToolName?: string };
            const name = d.actualToolName ?? d.toolName ?? "";
            return d.type === sdk.ToolConfirmationType.McpTool && (!d.serverName || d.serverName === opts.serverName) && allowedTools.some((t) => name.endsWith(t));
          });
        for (const u of toolUses) emit({ kind: "permission", tool: u.toolUse.name, decision: ok ? "allowed" : "blocked" });
        return ok ? sdk.ToolConfirmationOutcome.ProceedOnce : sdk.ToolConfirmationOutcome.Cancel;
      },
    });
    emit({ kind: "session", sessionId: session.id });

    let final: DroidRunResult | null = null;
    for await (const msg of session.stream(opts.prompt, {
      files: opts.documents.map((d) => ({ type: "text" as const, mediaType: "text/plain" as const, data: d.text, name: d.name })),
      outputFormat: { type: sdk.OutputFormatType.JsonSchema, schema: opts.outputSchema },
      abortSignal: controller.signal,
    })) {
      switch (msg.type) {
        case "tool_call":
          emit({ kind: "tool_call", tool: msg.name, input: msg.input });
          break;
        case "tool_result":
          // Sahaya's own tools report from their handlers; this covers anything else.
          if (!allowedTools.some((t) => msg.toolName.endsWith(t))) {
            emit({ kind: "tool_result", tool: msg.toolName, ok: !msg.isError, preview: preview(msg.content) });
          }
          break;
        case "assistant":
          if (msg.text.trim()) emit({ kind: "assistant", text: msg.text.trim() });
          break;
        case "error":
          emit({ kind: "error", message: msg.message });
          break;
        case "result":
          final = {
            sessionId: msg.sessionId,
            success: msg.success,
            structuredOutput: msg.structuredOutput,
            structuredOutputError: msg.structuredOutputError?.message,
            text: msg.text,
            durationMs: msg.durationMs,
            turnCount: msg.turnCount,
            tokenUsage: msg.tokenUsage
              ? { inputTokens: msg.tokenUsage.inputTokens, outputTokens: msg.tokenUsage.outputTokens }
              : undefined,
            error: msg.success ? undefined : (msg.error?.message ?? `Droid turn ended: ${msg.subtype}`),
          };
          break;
      }
    }
    return final ?? { sessionId: session.id, success: false, text: "", durationMs: Date.now() - startedAt, turnCount: 0, error: "Droid ended without a result." };
  } catch (err) {
    const message = controller.signal.aborted
      ? String((controller.signal.reason as Error | undefined)?.message ?? "Investigation was stopped.")
      : err instanceof Error
        ? err.message
        : String(err);
    return { sessionId: session?.id, success: false, text: "", durationMs: Date.now() - startedAt, turnCount: 0, error: message };
  } finally {
    clearTimeout(timer);
    await session?.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
