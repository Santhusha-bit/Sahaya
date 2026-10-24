/**
 * npm run serve:guardian
 *
 * Deploys the Guardian agent as a standalone local HTTP service, independent of
 * the Next app. It reuses the real GuardianAgent (deterministic scam policy,
 * tools, audit log, incident search) — nothing is reimplemented. Honors the same
 * integration status (Claude live/sandbox, etc.) via .env.local.
 *
 * Endpoints:
 *   GET  /health             -> agent id, tool names, integration modes
 *   POST /screen  {content, channel?, claimant?}  -> full scam workflow result
 *   POST /message {text}     -> a Guardian conversational turn (LLM or sandbox)
 *   GET  /incidents          -> the Guardian's recorded incidents
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Load .env.local into process.env BEFORE importing anything that reads env,
// so a standalone run has the same live/sandbox integrations as the web app.
try {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  /* no .env.local -> runs in sandbox */
}

const { allIntegrationStatuses } = await import("@/lib/env");
const { createInMemoryDataLayer } = await import("@/agents/base/memoryStore");
const { createAgent } = await import("@/agents/registry");
const { seedMargaretScenario, indexSeededIncidents, MARGARET_USER } = await import(
  "@/agents/guardian/scamScenario"
);

const PORT = Number(process.env.GUARDIAN_PORT ?? 8030);

const data = createInMemoryDataLayer();
await seedMargaretScenario(data, MARGARET_USER);
await indexSeededIncidents(data, MARGARET_USER);
const guardian = createAgent("guardian", { data, userId: MARGARET_USER });
await guardian.initialize();

function send(res: ServerResponse, code: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, {
        agent: "guardian",
        status: "ok",
        tools: guardian.tools.map((t) => t.name),
        integrations: allIntegrationStatuses().map((i) => ({ key: i.key, mode: i.mode })),
      });
    }
    if (req.method === "POST" && url.pathname === "/screen") {
      const body = await readBody(req);
      if (!body.content) return send(res, 400, { error: "content is required" });
      const { result, record } = await guardian.executeTool("screenInboundMessage", {
        content: body.content,
        channel: body.channel ?? "other",
        claimant: body.claimant,
      });
      return send(res, 200, { summary: result.summary, data: result.data, status: record.status });
    }
    if (req.method === "POST" && url.pathname === "/message") {
      const body = await readBody(req);
      if (!body.text) return send(res, 400, { error: "text is required" });
      const reply = await guardian.processMessage(String(body.text));
      return send(res, 200, {
        text: reply.text,
        toolCalls: reply.toolCalls.map((t) => ({ name: t.toolName, status: t.status })),
      });
    }
    if (req.method === "GET" && url.pathname === "/incidents") {
      const incidents = await guardian.memory.list("incidents");
      return send(res, 200, { count: incidents.length, incidents: incidents.map((i) => i.data) });
    }
    return send(res, 404, { error: "Not found", routes: ["/health", "POST /screen", "POST /message", "/incidents"] });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => {
  const claude = allIntegrationStatuses().find((i) => i.key === "claude")?.mode;
  console.log(`Guardian agent deployed locally on http://localhost:${PORT} (Claude: ${claude})`);
  console.log(`  GET  /health`);
  console.log(`  POST /screen   {content, channel?, claimant?}`);
  console.log(`  POST /message  {text}`);
  console.log(`  GET  /incidents`);
});
