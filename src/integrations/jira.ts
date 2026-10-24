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
  type WorkItem,
  type WorkItemStore,
} from "@/agents/base/workItems";

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
      const search = await this.api(`/search?jql=${encodeURIComponent(`labels=${label}`)}&fields=key`);
      if (search.ok) {
        const data = (await search.json()) as { issues?: { key: string }[] };
        if (data.issues?.length) return data.issues[0].key;
      }
      const res = await this.api(`/issue`, {
        method: "POST",
        body: JSON.stringify({
          fields: {
            project: { key: this.cfg.projectKey },
            summary: `[Kinline] ${item.requestedAction}`.slice(0, 250),
            description: adf(
              `Requesting agent: ${item.requestingAgent}\nAssigned agent: ${item.assignedAgent}\nScope: ${item.permissionScope}\nRequired reviewer role: ${item.requiredRole}\nInput hash: ${item.inputHash}`,
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
    const updated = await this.mirror.patch(id, patch);
    if (updated?.externalKey && patch.status) {
      await this.comment(updated.externalKey, `Status: ${patch.status}${patch.result ? ` — ${patch.result}` : ""}`);
    }
    return updated;
  }

  async list(userId: string): Promise<WorkItem[]> {
    return this.mirror.list(userId);
  }
}

/** Build the right store for the current environment (honest live/sandbox). */
export function createWorkItemStore(): { service: WorkItemService; backend: "sandbox" | "jira" } {
  const cfg = readConfig();
  if (cfg && jiraStatus().mode === "live") {
    const store = new JiraWorkItemStore(cfg);
    return { service: new WorkItemService(store), backend: "jira" };
  }
  return { service: new WorkItemService(new SandboxWorkItemStore()), backend: "sandbox" };
}
