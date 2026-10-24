/**
 * npm run demo:agents
 *
 * Agent-to-agent messaging: Margaret tells Wellness she has no one to help with
 * groceries. Wellness records consent and sends a typed AssistanceRequest across
 * the bridge; Guardian accepts and coordinates a helper, replying with a matching
 * AssistanceResponse. Also shows a request being rejected without consent.
 *
 * Sandbox (in-process) by default. Set FETCHAI_BRIDGE_URL to route through the
 * live Python uAgents service (services/uagents) instead.
 */

import { fetchaiStatus } from "@/lib/env";
import { AuditLog } from "@/agents/base/audit";
import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { SandboxBridge, requestAssistance } from "@/integrations/fetchai";

function line(c = "─") {
  console.log(c.repeat(68));
}

async function main() {
  const data = createInMemoryDataLayer();
  const USER = "demo-margaret";

  line("═");
  console.log(`KINLINE — Agent-to-agent messaging demo`);
  console.log(`Fetch.ai: ${fetchaiStatus().mode} — ${fetchaiStatus().detail}`);
  line("═");

  const bridge = new SandboxBridge(data, DEFAULT_CONSENT);
  console.log(`\nMargaret tells Wellness: "I don't have anyone to help me get groceries."`);

  const { request, response, userMessage } = await requestAssistance(bridge, {
    userId: USER,
    need: "I don't have anyone to help me get groceries",
  });

  console.log(`\nWellness -> Guardian  AssistanceRequest`);
  console.log(`  request_id=${request.request_id} need="${request.need}" urgency=${request.urgency} consent_ref=${request.consent_ref}`);
  console.log(`Guardian -> Wellness  AssistanceResponse`);
  console.log(`  request_id=${response.request_id} task_id=${response.task_id} status=${response.status}`);
  console.log(`\nWellness tells Margaret:\n  ${userMessage}`);

  const guardian = createAgent("guardian", { data, userId: USER });
  const tasks = await guardian.taskService.list();
  const task = tasks.find((t) => t.correlationId === request.request_id);
  console.log(`\nGuardian coordination task: ${task ? `${task.id} — "${task.title}"` : "(none)"}`);

  // Rejection path: no consent.
  const noConsentBridge = new SandboxBridge(data, { ...DEFAULT_CONSENT, wellnessToGuardianAssist: false });
  const rejected = await noConsentBridge.send({
    request_id: "req-no-consent", from_agent: "wellness", to_agent: "guardian",
    user_id: USER, need: "help with groceries", consent_ref: "c", urgency: "soon",
  });
  console.log(`\nWithout consent: status=${rejected.status} (${rejected.reason})`);

  line();
  console.log("Bridge message log (both agents):");
  const audit = await new AuditLog(data.memory, USER).list();
  for (const e of audit.filter((a) => a.actor.startsWith("bridge:"))) {
    console.log(`  [${e.actor}] ${e.action} (req ${e.correlationId})`);
  }

  line("═");
  const ok =
    response.status === "accepted" &&
    response.request_id === request.request_id &&
    !!task &&
    rejected.status === "rejected";
  console.log(ok ? "✓ Typed messages exchanged, response matched the request, consent enforced." : "✗ Demo FAILED.");
  line("═");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
