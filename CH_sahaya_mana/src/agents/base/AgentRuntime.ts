import { resolveIntegrations, type IntegrationId, type IntegrationMode } from "@/integrations/status";
import { newId } from "@/lib/ids";
import { AgentEventBus } from "./AgentEventBus";
import { ScopedAgentStore, type AgentStore } from "./AgentStore";
import { namespacesFor, type AgentDeps, type BaseAgent, type AgentDefinition } from "./BaseAgent";
import { AgentError } from "./errors";
import type { LLMClient } from "./llm";
import type { AgentContext, AgentId, CaregiverScope, ScheduledJob } from "./types";

export type AgentFactory = (deps: AgentDeps) => BaseAgent;

export interface RuntimeOptions {
  store: AgentStore;
  llm: LLMClient;
  now?: () => number;
  integrationMode?: (id: IntegrationId) => IntegrationMode;
}

/**
 * Shared infrastructure host. Owns the root store and event bus, and gives each agent only
 * its own scoped store, a source-pinned publish function, and the shared LLM transport.
 * Agents never hold references to each other; collaboration goes through the bus.
 */
export class AgentRuntime {
  readonly bus: AgentEventBus;
  private agents = new Map<AgentId, BaseAgent>();
  private readonly now: () => number;

  constructor(private readonly opts: RuntimeOptions) {
    this.now = opts.now ?? Date.now;
    this.bus = new AgentEventBus(opts.store, this.now);
    this.bus.setDispatcher(async (event) => this.get(event.targetAgent).handleEvent(event));
  }

  register(definition: AgentDefinition, factory: AgentFactory): BaseAgent {
    if (this.agents.has(definition.id)) throw new Error(`${definition.id} already registered`);
    const modes = new Map(resolveIntegrations().map((i) => [i.id, i.mode]));
    const deps: AgentDeps = {
      store: new ScopedAgentStore(this.opts.store, definition.id, namespacesFor(definition)),
      permissions: { getCaregiverPermission: (...a) => this.opts.store.getCaregiverPermission(...a) },
      publish: (target, type, payload, ctx) => this.bus.publish(definition.id, target, type, payload, ctx),
      llm: this.opts.llm,
      now: this.now,
      integrationMode: this.opts.integrationMode ?? ((id) => modes.get(id) ?? "unavailable"),
    };
    const agent = factory(deps);
    if (agent.id !== definition.id) throw new Error(`factory for ${definition.id} built ${agent.id}`);
    this.bus.registerAgent(definition.id, definition.events);
    this.agents.set(definition.id, agent);
    return agent;
  }

  get(id: AgentId): BaseAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new AgentError("NOT_FOUND", `agent ${id} is not registered`);
    return agent;
  }

  list(): BaseAgent[] {
    return [...this.agents.values()];
  }

  async initializeAll(ctx: AgentContext) {
    for (const agent of this.agents.values()) await agent.initialize(ctx);
  }

  /** Route an approval decision to the agent that owns it. */
  async resolveApproval(ctx: AgentContext, approvalId: string, decision: "approve" | "deny") {
    const approval = await this.opts.store.getApproval(approvalId);
    if (!approval) throw new AgentError("NOT_FOUND", `approval ${approvalId} not found`);
    return this.get(approval.agentId).resolveApproval(ctx, approvalId, decision);
  }

  /** Run all due scheduled jobs, each by its owning agent. */
  async runDueJobs(): Promise<ScheduledJob[]> {
    const due = await this.opts.store.listDueJobs(this.now());
    const results: ScheduledJob[] = [];
    for (const job of due) results.push(await this.get(job.agentId).runJob(job.id));
    return results;
  }

  /** Declared cross-agent routes with the user's current consent state. */
  async listConsentRoutes(userId: string) {
    const grants = await this.opts.store.listConsents(userId);
    return this.bus.listRoutes().map((r) => ({
      ...r,
      enabled: grants.some(
        (g) => g.sourceAgent === r.source && g.targetAgent === r.target && g.eventType === r.type && g.enabled,
      ),
    }));
  }

  /**
   * Owner-only grant/revoke of a caregiver's scoped access to one agent. The caregiver is named by their
   * verified identity id (validated by the caller); never inferred from names, relationships or model output.
   * Revoking keeps an audit row but grants nothing.
   */
  async setCaregiverGrant(
    ctx: AgentContext,
    grant: { caregiverId: string; agentId: AgentId; scopes: CaregiverScope[]; canApprove: boolean; revoke?: boolean; expiresAt?: number; recipientLabel?: string },
  ) {
    if (ctx.actor.role !== "older_adult" || ctx.actor.id !== ctx.userId) {
      throw new AgentError("PERMISSION_DENIED", "only the person can grant or revoke caregiver access");
    }
    if (grant.caregiverId === ctx.userId || grant.caregiverId.startsWith(`${ctx.userId}#`)) {
      throw new AgentError("VALIDATION_FAILED", "you can't grant access to yourself");
    }
    const scopes = grant.revoke ? [] : [...new Set(grant.scopes)];
    // An approve scope only makes sense with the matching view scope.
    for (const s of scopes) {
      if (s.endsWith(":approve") && !scopes.includes(s.replace(/:approve$/, "") as CaregiverScope)) {
        throw new AgentError("VALIDATION_FAILED", "Approving requires the matching view permission.");
      }
    }
    if (grant.expiresAt !== undefined && grant.expiresAt <= this.now()) throw new AgentError("VALIDATION_FAILED", "The end date must be in the future.");
    const canApprove = !grant.revoke && grant.canApprove && scopes.some((s) => s.endsWith(":approve"));
    await this.opts.store.setCaregiverPermission({
      userId: ctx.userId,
      caregiverId: grant.caregiverId,
      agentId: grant.agentId,
      canViewSummaries: scopes.length > 0,
      canApprove,
      scopes,
      ...(scopes.length && grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
      ...(scopes.length && grant.recipientLabel ? { recipientLabel: grant.recipientLabel.slice(0, 60) } : {}),
    });
    await this.opts.store.appendLog({
      id: newId("log"),
      agentId: grant.agentId,
      userId: ctx.userId,
      kind: "audit",
      level: "info",
      message: scopes.length ? "Caregiver access granted" : "Caregiver access revoked",
      data: { caregiver: grant.caregiverId, scopes, canApprove, expiresAt: grant.expiresAt ?? null },
      at: this.now(),
    });
    return { revoked: scopes.length === 0, scopes, canApprove };
  }

  /** The person's own grants (incl. revoked/expired) and recent security audit entries — owner only. */
  async caregiverOverview(ctx: AgentContext) {
    if (ctx.actor.role !== "older_adult" || ctx.actor.id !== ctx.userId) throw new AgentError("PERMISSION_DENIED", "only the person can see this");
    const now = this.now();
    const grants = (await this.opts.store.listGrantsForOwner(ctx.userId)).map((g) => ({
      caregiverId: g.caregiverId,
      agentId: g.agentId,
      scopes: g.scopes ?? [],
      canApprove: g.canApprove,
      grantedAt: g.grantedAt ?? null,
      expiresAt: g.expiresAt ?? null,
      revokedAt: g.revokedAt ?? null,
      recipientLabel: g.recipientLabel ?? null,
      active: !g.revokedAt && (g.expiresAt === undefined || g.expiresAt > now) && (g.scopes ?? []).length > 0,
    }));
    const audit = (await this.opts.store.listLogs({ userId: ctx.userId, agentId: "care", limit: 500 }))
      // Caregiver activity only (grants, views, decisions); other audit entries (e.g. household-service demo) have their own view.
      .filter((l) => l.kind === "audit" && typeof (l.data as { caregiver?: unknown } | undefined)?.caregiver === "string")
      .slice(-30)
      .reverse()
      .map((l) => ({ at: l.at, message: l.message, caregiver: (l.data as { caregiver?: string } | undefined)?.caregiver ?? null }));
    return { grants, audit };
  }

  /** People who granted this caregiver access (active grants only). A caregiver can only choose among these. */
  async recipientsFor(caregiverId: string) {
    return (await this.opts.store.listGrantsForCaregiver(caregiverId))
      .filter((g) => g.agentId === "care")
      .map((g) => ({ recipientId: g.userId, label: g.recipientLabel ?? null, scopes: g.scopes ?? [], expiresAt: g.expiresAt ?? null }));
  }

  /** User-facing consent toggle for one declared cross-agent route. */
  async setConsent(ctx: AgentContext, source: AgentId, target: AgentId, eventType: string, enabled: boolean) {
    if (ctx.actor.role !== "older_adult" || ctx.actor.id !== ctx.userId) {
      throw new AgentError("PERMISSION_DENIED", "only the user can change cross-agent permissions");
    }
    const declared = this.bus.listRoutes().some((r) => r.source === source && r.target === target && r.type === eventType);
    if (!declared) throw new AgentError("VALIDATION_FAILED", `no declared route ${source} → ${target} "${eventType}"`);
    await this.opts.store.setConsent({
      userId: ctx.userId,
      sourceAgent: source,
      targetAgent: target,
      eventType,
      enabled,
      grantedBy: ctx.actor.id,
      updatedAt: this.now(),
    });
    await this.opts.store.appendLog({
      id: newId("log"),
      agentId: source,
      userId: ctx.userId,
      kind: "lifecycle",
      level: "info",
      message: `${enabled ? "Enabled" : "Disabled"} ${source} → ${target} "${eventType}"`,
      at: this.now(),
    });
  }
}
