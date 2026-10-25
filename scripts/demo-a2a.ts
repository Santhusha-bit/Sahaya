/**
 * npm run demo:a2a
 *
 * Live Fetch.ai agent-to-agent demo. Two independent uAgents (Wellness and
 * Guardian, each its own Python process with its own identity) exchange a real
 * signed message while their execution logs stream below.
 *
 *   1. Margaret tells the TS Wellness agent: "I don't have anyone to help me get groceries."
 *   2. Wellness asks for permission (a code-enforced approval); Margaret approves.
 *   3. Wellness -> its uAgent -> AssistanceRequest message -> Guardian's uAgent
 *   4. Guardian's uAgent verifies the sender and hands it to the TS Guardian agent,
 *      which creates the helper-coordination task.
 *   5. Guardian's uAgent replies with the task id + status; Wellness tells Margaret.
 *
 * Needs Python with uagents (pip install -r services/uagents/requirements.txt).
 * Ports: uAgents use UAGENT_PORT_WELLNESS / UAGENT_PORT_GUARDIAN (8020 / 8021);
 * the TS Guardian intake uses GUARDIAN_INTAKE_PORT (8031). PYTHON picks the interpreter.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";

const WELLNESS_PORT = Number(process.env.UAGENT_PORT_WELLNESS ?? 8020);
const GUARDIAN_PORT = Number(process.env.UAGENT_PORT_GUARDIAN ?? 8021);
const INTAKE_PORT = Number(process.env.GUARDIAN_INTAKE_PORT ?? 8031);
const PYTHON = process.env.PYTHON ?? "python";
const USER = "margaret";

// The Wellness TS agent reaches Guardian only through its own uAgent.
process.env.FETCHAI_WELLNESS_URL = `http://127.0.0.1:${WELLNESS_PORT}`;

const { getDataLayer } = await import("@/agents/base/dataLayer");
const { createAgent } = await import("@/agents/registry");
const { acceptAssistanceAtGuardian } = await import("@/integrations/fetchai");

const data = getDataLayer();
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const step = (n: number, s: string) => console.log(`\n${bold(`[${n}]`)} ${s}`);

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// --- TS Guardian intake: what the Guardian uAgent calls ------------------------
const intake = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/assistance") {
    res.writeHead(404).end();
    return;
  }
  const out = await acceptAssistanceAtGuardian(data, await readBody(req));
  console.log(`  ${bold("TS Guardian")}  intake -> ${out.status}${out.task_id ? ` task ${out.task_id} (${out.task_status})` : ` (${out.reason})`}`);
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
});
await new Promise<void>((r) => intake.listen(INTAKE_PORT, "127.0.0.1", r));

// --- The uAgents, each its own OS process ---------------------------------------
const servicesDir = fileURLToPath(new URL("../services/uagents/", import.meta.url));
const py = spawn(PYTHON, ["-u", "bridge.py", "wellness"], {
  cwd: servicesDir,
  env: {
    ...process.env,
    GUARDIAN_AGENT_URL: `http://127.0.0.1:${INTAKE_PORT}`,
    UAGENT_PORT_WELLNESS: String(WELLNESS_PORT),
    UAGENT_PORT_GUARDIAN: String(GUARDIAN_PORT),
    PYTHONIOENCODING: "utf-8",
    // The whole uAgents tree exits if this demo dies (stdin EOF), so no orphans hold ports.
    KINLINE_EXIT_WITH_PARENT: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let buffered = "";
py.stdout.on("data", (chunk: Buffer) => {
  buffered += chunk.toString("utf8");
  const lines = buffered.split(/\r?\n/);
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    // Show the agents' execution-log events and anything that went wrong.
    if (process.env.DEMO_VERBOSE || /\]: \[|starting|ERROR|Traceback|Error:/.test(line)) console.log(`  ${line.replace(/INFO:\s+/, "")}`);
  }
});
py.stderr.on("data", (c: Buffer) => process.stderr.write(dim(c.toString("utf8"))));

function shutdown(code: number): never {
  if (py.pid && py.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(py.pid), "/T", "/F"]);
    else py.kill("SIGTERM");
  }
  intake.close();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(130));

async function waitFor(url: string, ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (py.exitCode !== null) throw new Error(`uAgents exited (code ${py.exitCode}); is port ${WELLNESS_PORT}/${GUARDIAN_PORT} free?`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${url}`);
}

try {
  step(0, "Starting the Wellness and Guardian uAgents (two independent processes; first start can take ~30s while Python imports uagents)...");
  await waitFor(`http://127.0.0.1:${GUARDIAN_PORT}/logs`);
  await waitFor(`http://127.0.0.1:${WELLNESS_PORT}/logs`);

  const wellness = createAgent("wellness", { data, userId: USER });
  await wellness.initialize();

  step(1, `Margaret tells Wellness: ${bold(`"I don't have anyone to help me get groceries."`)}`);
  const reply = await wellness.processMessage("I don't have anyone to help me get groceries.");
  console.log(`  Wellness: ${reply.text}`);
  const approvalId = reply.approvalsRequested[0];
  if (!approvalId) throw new Error("Wellness did not ask for permission");
  const approval = await wellness.approvalService.get(approvalId);
  console.log(`  ${dim(`approval ${approvalId}: ${approval?.title}`)}`);
  console.log(`  ${dim(`  "${approval?.description}"`)}`);

  step(2, "Margaret taps Approve. Wellness sends the request to Guardian over Fetch.ai:");
  const { record, result } = await wellness.executeTool(approval!.toolName, approval!.input, {
    approved: true,
    correlationId: approval!.correlationId,
  });
  await data.approvals.patch(approvalId, { status: "approved", decidedAt: Date.now() });
  await new Promise((r) => setTimeout(r, 300)); // let the last log lines flush

  step(3, "Wellness reports back to Margaret:");
  console.log(`  Wellness: ${result.summary}`);
  const out = (result.data ?? {}) as Record<string, string>;
  console.log(`  ${dim(`backend=${out.backend} status=${out.status} task=${out.taskId} (${out.taskStatus}) coordinator=${out.coordinator?.slice(0, 18)}...`)}`);

  step(4, "Guardian's own task list (TS Guardian agent):");
  const guardian = createAgent("guardian", { data, userId: USER });
  const task = out.taskId ? await guardian.taskService.get(out.taskId) : null;
  if (task) console.log(`  ${task.id}  [${task.status}]  ${task.title}\n  steps: ${task.steps.map((s) => s.label).join(" -> ")}`);
  else console.log("  (no task)");

  const ok = record.status === "success" && out.backend === "fetchai" && !!task;
  console.log(`\n${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}: Wellness and Guardian exchanged a real uAgents message; Guardian task ${out.taskId || "missing"}.`);
  console.log(dim(`Execution logs: GET http://127.0.0.1:${WELLNESS_PORT}/logs and http://127.0.0.1:${GUARDIAN_PORT}/logs, or services/uagents/logs/*.jsonl`));
  shutdown(ok ? 0 : 1);
} catch (err) {
  console.error(`\n\x1b[31mFAIL\x1b[0m: ${err instanceof Error ? err.message : String(err)}`);
  shutdown(1);
}
