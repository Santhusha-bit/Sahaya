/**
 * Atlassian / Jira adapter for the work-item store (Track 3).
 *
 * Honest integration (prompt global rule 1): this is LIVE only when real
 * ATLASSIAN_* credentials are present; otherwise the app uses the sandbox store
 * and the status page shows Jira as "unavailable". Using the Jira name without
 * working credentials is never presented as an integration.
 *
 * Even when live, the SECURITY-critical fields (input hash, required reviewer
 * role, expiry, single-use) are held in the local mirror and enforced by the code
 * gate in workItems.ts. Jira is the human review surface; a Jira "Approved" status
 * alone never authorizes execution. Sync is idempotent via the issue key stored on
 * the work item (externalKey).
 */

import { jiraStatus } from "@/lib/env";
import {
  SandboxWorkItemStore,
  WorkItemService,
  auditHead,
  type WorkItem,
  type WorkItemStore,
} from "@/agents/base/workItems";
import { ReviewerDirectory } from "@/agents/base/workItemPolicy";

interface JiraConfig {
  site: string;
  email: string;
  token: string;
  projectKey: string;
}

function readConfig(): JiraConfig | null {
  const site = process.env.ATLASSIAN_SITE?.trim();
  const email = process.env.ATLASSIAN_EMAIL?.trim();
  const token = process.env.ATLASSIAN_API_TOKEN?.trim();
  const projectKey = process.env.ATLASSIAN_PROJECT_KEY?.trim();
  if (!site || !email || !token || !projectKey) return null;
  return { site, email, token, projectKey };
}

function baseUrl(site: string): string {
  return site.startsWith("http") ? site.replace(/\/$/, "") : `https://${site}.atlassian.net`;
}

function authHeader(cfg: JiraConfig): string {
  return "Basic " + Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64");
}

function adf(text: string) {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }]}] };
}

/**
 * Keeps an authoritative local mirror (so the gate has hash/role/expiry/single-use)
 * and best-effort mirrors each work item to a Jira issue for human review.
 */
export class JiraWorkItemStore implements WorkItemStore {
  readonly backend = "jira" as const;
  private mirror = new SandboxWorkItemStore();

  constructor(private readonly cfg: JiraConfig) {}

  private async api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${baseUrl(this.cfg.site)}/rest/api/3${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(this.cfg),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  }

  /** Create a Jira issue once; idempotent via the kinline-<id> label. */
  private async ensureIssue(item: WorkItem): Promise<string | undefined> {
    if (item.externalKey) return item.externalKey;
    const label = `kinline-${item.id}`;
    try {
      const search = await this.api(`/search/jql?jql=${encodeURIComponent(`labels=${label}`)}&fields=key`);
      if (search.ok) {
        const data = (await search.json()) as { issues?: { key: string }[] };
        if (data.issues?.length) return data.issues[0].key;
      }
      const res = await this.api(`/issue`, {
        method: "POST",
        body: JSON.stringify({
          fields: {
            project: { key: this.cfg.projectKey },
            summary: `[Sahaya] ${item.requestedAction}`.slice(0, 250),
            description: adf(
              `Requesting agent: ${item.requestingAgent} | Assigned agent: ${item.assignedAgent} | Scope: ${item.permissionScope} | ` +
                `Risk: ${item.riskTier} (needs ${item.requiredApprovals} distinct ${item.requiredRole} approval(s)) | Input hash: ${item.inputHash}. ` +
                `Approve by moving this issue to ${statusNames("approve").join(" or ")}. A transition only counts if your Jira account is bound to a registered Sahaya reviewer; execution is still enforced by the Sahaya gate.`,
            ),
            issuetype: { name: "Task" },
            labels: [label],
          },
        }),
      });
      if (!res.ok) return undefined;
      const created = (await res.json()) as { key: string };
      return created.key;
    } catch {
      return undefined; // Network/API issues never break the local gate.
    }
  }

  private async comment(key: string, text: string): Promise<void> {
    try {
      await this.api(`/issue/${key}/comment`, { method: "POST", body: JSON.stringify({ body: adf(text) }) });
    } catch {
      /* best effort */
    }
  }

  async put(item: WorkItem): Promise<WorkItem> {
    const key = await this.ensureIssue(item);
    const stored = await this.mirror.put(key ? { ...item, externalKey: key } : item);
    if (key) await this.comment(key, `Work item created (${item.status}).`);
    return stored;
  }

  async get(id: string): Promise<WorkItem | null> {
    return this.mirror.get(id);
  }

  async patch(id: string, patch: Partial<WorkItem>): Promise<WorkItem | null> {
    const before = await this.mirror.get(id);
    const updated = await this.mirror.patch(id, patch);
    if (!updated?.externalKey) return updated;
    const statusChanged = patch.status && patch.status !== before?.status;
    const approvalAdded = patch.approvals && patch.approvals.length !== (before?.approvals?.length ?? 0);
    if (statusChanged || approvalAdded) {
      const last = updated.history[updated.history.length - 1];
      await this.comment(
        updated.externalKey,
        `Sahaya: ${updated.status}. ${last ? `${last.actor} ${last.action}${last.detail ? `: ${last.detail}` : ""}. ` : ""}` +
          `Approvals ${updated.approvals.length}/${updated.requiredApprovals}. Audit head ${auditHead(updated)}.`,
      );
    }
    return updated;
  }

  async list(userId: string): Promise<WorkItem[]> {
    return this.mirror.list(userId);
  }

  /**
   * Read the Jira changelog and return status transitions into an approve or
   * reject status, with the Jira accountId of whoever made them. The caller
   * (WorkItemService.applyExternalDecision) decides whether they count.
   */
  async fetchDecisions(id: string): Promise<JiraDecision[]> {
    const item = await this.mirror.get(id);
    if (!item?.externalKey) return [];
    const res = await this.api(`/issue/${item.externalKey}/changelog?maxResults=100`);
    if (!res.ok) throw new Error(`Jira changelog ${res.status}`);
    const data = (await res.json()) as {
      values?: { id: string; author?: { accountId?: string; displayName?: string }; items?: { field?: string; toString?: string }[] }[];
    };
    const approve = statusNames("approve").map((s) => s.toLowerCase());
    const reject = statusNames("reject").map((s) => s.toLowerCase());
    const out: JiraDecision[] = [];
    for (const h of data.values ?? []) {
      for (const it of h.items ?? []) {
        if (it.field !== "status" || !it.toString || !h.author?.accountId) continue;
        const to = it.toString.toLowerCase();
        const decision = approve.includes(to) ? "approve" : reject.includes(to) ? "reject" : null;
        if (decision) out.push({ eventId: h.id, accountId: h.author.accountId, displayName: h.author.displayName, decision, statusName: it.toString });
      }
    }
    return out;
  }
}

export interface JiraDecision {
  eventId: string;
  accountId: string;
  displayName?: string;
  decision: "approve" | "reject";
  statusName: string;
}

function statusNames(kind: "approve" | "reject"): string[] {
  const raw = kind === "approve" ? process.env.ATLASSIAN_APPROVE_STATUSES : process.env.ATLASSIAN_REJECT_STATUSES;
  const fallback = kind === "approve" ? "Approved,Done" : "Rejected,Declined,Won't Do";
  return (raw?.trim() || fallback).split(",").map((s) => s.trim()).filter(Boolean);
}

export interface WorkItemCoordinator {
  service: WorkItemService;
  backend: "sandbox" | "jira";
  /** Present only when live: pulls Jira decisions and applies the authorized ones. */
  syncFromJira?: (itemId: string) => Promise<{ applied: number; ignored: number; error?: string }>;
}

const GLOBAL_KEY = "__sahayaWorkItemCoordinator";

/**
 * One coordinator per process, so an item proposed by Guardian is the same item
 * a reviewer approves and Finance executes. (Sandbox state is in memory: it
 * survives across requests on one server but not across serverless instances.)
 */
export function getWorkItemCoordinator(): WorkItemCoordinator {
  const g = globalThis as unknown as Record<string, WorkItemCoordinator | undefined>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY]!;
  const directory = new ReviewerDirectory([]);
  const cfg = readConfig();
  let coordinator: WorkItemCoordinator;
  if (cfg && jiraStatus().mode === "live") {
    const store = new JiraWorkItemStore(cfg);
    const service = new WorkItemService(store, directory);
    coordinator = {
      service,
      backend: "jira",
      async syncFromJira(itemId) {
        let decisions: JiraDecision[];
        try {
          decisions = await store.fetchDecisions(itemId);
        } catch (err) {
          return { applied: 0, ignored: 0, error: err instanceof Error ? err.message : String(err) };
        }
        let applied = 0;
        let ignored = 0;
        for (const d of decisions) {
          const r = await service.applyExternalDecision(itemId, {
            decision: d.decision,
            externalAccountId: d.accountId,
            externalEventId: d.eventId,
            source: "jira",
            label: `${d.statusName} by ${d.displayName ?? d.accountId}`,
          });
          if (r.skipped) continue;
          if (r.ok) applied++;
          else ignored++;
        }
        return { applied, ignored };
      },
    };
  } else {
    coordinator = { service: new WorkItemService(new SandboxWorkItemStore(), directory), backend: "sandbox" };
  }
  g[GLOBAL_KEY] = coordinator;
  return coordinator;
}

/** Back-compat helper used by Care/Finance logging; returns the shared coordinator. */
export function createWorkItemStore(): { service: WorkItemService; backend: "sandbox" | "jira" } {
  const { service, backend } = getWorkItemCoordinator();
  return { service, backend };
}

/** Shared coordinator with the household's reviewer directory loaded. */
export function getHouseholdCoordinator(userId: string): WorkItemCoordinator {
  const c = getWorkItemCoordinator();
  c.service.directory.ensureDemoHousehold(userId);
  return c;
}
