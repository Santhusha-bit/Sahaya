import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { AGENT_DEFINITIONS } from "@/agents";
import { AGENT_IDS } from "@/agents/base/types";
import { resolveIntegrations } from "@/integrations/status";
import { Card, ModeBadge, PageHeader, Section } from "@/components/ui";
import { getRuntime } from "@/lib/server/runtime";
import type { CareAgent } from "@/agents/care/CareAgent";
import { getSessionContext, resolveRequest } from "@/lib/server/session";
import { AccessNotice } from "@/components/AccessNotice";

export const metadata: Metadata = { title: "Profile" };

export default function ProfilePage() {
  return (
    <Suspense fallback={<p className="p-6 text-lg text-ink-muted">Loading…</p>}>
      <ProfileContent />
    </Suspense>
  );
}

async function ProfileContent() {
  await connection();
  const integrations = resolveIntegrations();
  let data;
  try {
    const auth = await resolveRequest();
    const session = await getSessionContext();
    const runtime = await getRuntime(session);
    data = {
      auth,
      routes: await runtime.listConsentRoutes(session.userId),
      personName: await (runtime.get("care") as CareAgent).displayName(session),
    };
  } catch (err) {
    return (
      <main>
        <PageHeader title="Your profile" />
        <AccessNotice error={err} />
        <IntegrationList integrations={integrations} />
      </main>
    );
  }
  const { auth, routes, personName } = data;
  const name = (id: string) => AGENT_DEFINITIONS[id as keyof typeof AGENT_DEFINITIONS].displayName;
  const subtitle =
    auth.profile === "demo"
      ? "Demo profile with fictional sample data."
      : auth.identity.kind === "user"
        ? "Signed in."
        : "Local test mode on this computer — no sign-in. Don't enter real health information.";

  return (
    <main>
      <PageHeader title={personName ?? "Your profile"} subtitle={subtitle} />
      {auth.identity.kind === "user" && (
        <Section title="Your account">
          <Card>
            <p className="text-base text-ink-muted">Your Sahaya ID (a caregiver shares theirs with you so you can grant access):</p>
            <p className="mt-1 break-all font-mono text-base">{auth.identity.userId}</p>
            <a href="/auth/logout" className="mt-3 inline-flex min-h-12 items-center rounded-full border-2 border-line px-5 text-lg font-bold">
              Sign out
            </a>
          </Card>
        </Section>
      )}

      <Section title="What agents may share">
        <p className="mb-3 text-lg text-ink-muted">
          Agents keep their conversations private. They can only ask each other for help in these specific ways, and
          only after you turn each one on.
        </p>
        <ul className="grid gap-2">
          {routes.map((r) => (
            <li key={`${r.source}-${r.target}-${r.type}`}>
              <Card className="flex items-start justify-between gap-3">
                <span>
                  <span className="block font-bold">
                    {name(r.source)} → {name(r.target)}
                  </span>
                  <span className="block text-base text-ink-muted">{r.description}</span>
                </span>
                <span
                  className={`shrink-0 rounded-full px-3 py-1 text-sm font-bold ${r.enabled ? "bg-care-soft text-ok" : "bg-canvas text-ink-muted"}`}
                >
                  {r.enabled ? "On" : "Off"}
                </span>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="What each agent remembers">
        <ul className="grid gap-2">
          {AGENT_IDS.map((id) => (
            <li key={id}>
              <Card>
                <p className="font-bold">{AGENT_DEFINITIONS[id].displayName}</p>
                <p className="text-base text-ink-muted">
                  {AGENT_DEFINITIONS[id].memoryNamespaces.map((ns) => ns.split(".")[1].replace(/([A-Z])/g, " $1").toLowerCase()).join(" · ")}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <IntegrationList integrations={integrations} />
    </main>
  );
}

function IntegrationList({ integrations }: { integrations: ReturnType<typeof resolveIntegrations> }) {
  return (
    <Section title="Connected services">
      <ul className="grid gap-2">
        {integrations.map((i) => (
          <li key={i.id}>
            <Card className="flex items-start justify-between gap-3">
              <span>
                <span className="block font-bold">{i.name}</span>
                <span className="block text-base">{i.purpose}</span>
                <span className="block text-base text-ink-muted">{i.detail}</span>
              </span>
              <ModeBadge mode={i.mode} />
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  );
}
