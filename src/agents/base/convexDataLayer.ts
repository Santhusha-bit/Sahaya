import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type {
  AgentEvent,
  AgentId,
  AgentTask,
  Approval,
  ApprovalStore,
  ConversationMessage,
  ConversationStore,
  DataLayer,
  EventQuery,
  EventStore,
  MemoryQuery,
  MemoryRecord,
  MemoryStore,
  TaskStore,
} from "./types";

/**
 * Convex-backed persistence (prompt §5, §10: Convex as the primary backend and
 * the AgentEventBus store). Function references are built by name so this file
 * compiles without the generated `_generated/api` (which only exists after
 * `convex dev`). When NEXT_PUBLIC_CONVEX_URL is unset the app falls back to the
 * in-process layer.
 */

// Untyped references (args/returns are validated by the Convex functions
// themselves); we cast results to the DataLayer's record types.
const q = (name: string) => makeFunctionReference<"query">(name);
const m = (name: string) => makeFunctionReference<"mutation">(name);

export function createConvexDataLayer(url: string): DataLayer {
  const client = new ConvexHttpClient(url);
  const call = <R>(p: Promise<unknown>) => p as Promise<R>;

  const memory: MemoryStore = {
    put: (rec) => call(client.mutation(m("memories:put"), { record: rec })),
    get: (id) => call(client.query(q("memories:get"), { id })),
    list: (query: MemoryQuery) => call(client.query(q("memories:list"), query)),
    patch: (id, data) => call(client.mutation(m("memories:patch"), { id, data })),
    remove: (id) => call(client.mutation(m("memories:remove"), { id })),
  };

  const events: EventStore = {
    put: (evt) => call(client.mutation(m("events:put"), { event: evt })),
    list: (query: EventQuery) => call(client.query(q("events:list"), query)),
    patch: (id, patch) => call(client.mutation(m("events:patch"), { id, patch })),
  };

  const tasks: TaskStore = {
    put: (task) => call(client.mutation(m("tasks:put"), { task })),
    get: (id) => call(client.query(q("tasks:get"), { id })),
    list: (query) => call(client.query(q("tasks:list"), query)),
    patch: (id, patch) => call(client.mutation(m("tasks:patch"), { id, patch })),
  };

  const approvals: ApprovalStore = {
    put: (a) => call(client.mutation(m("approvals:put"), { approval: a })),
    get: (id) => call(client.query(q("approvals:get"), { id })),
    list: (query) => call(client.query(q("approvals:list"), query)),
    patch: (id, patch) => call(client.mutation(m("approvals:patch"), { id, patch })),
  };

  const conversations: ConversationStore = {
    append: (msg) => call(client.mutation(m("conversations:append"), { message: msg })),
    history: (query) => call(client.query(q("conversations:history"), query)),
  };

  return { memory, events, tasks, approvals, conversations, backend: "convex" };
}
