import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AGENT_DEFINITIONS } from "@/agents";
import { AGENT_IDS } from "@/agents/base/types";
import { resolveIntegrations } from "@/integrations/status";
import { AgentCard } from "@/components/agents/AgentCard";
import type { CareAgent } from "@/agents/care/CareAgent";
import { getRuntime } from "@/lib/server/runtime";
import { getSessionContext } from "@/lib/server/session";

/** Greets the person by the name they gave Care; just "Hello." until then. */
async function Greeting() {
  await connection();
  let name: string | null = null;
  try {
    const session = await getSessionContext();
    name = await ((await getRuntime(session)).get("care") as CareAgent).displayName(session);
  } catch {
    // Signed out / not configured / database unavailable: greet without personal data.
    name = null;
  }
  return <>Hello{name ? `, ${name}` : ""}.</>;
}

/** Reads server env at request time, so it streams in after the static shell. */
async function ConnectionNotice() {
  await connection();
  const unavailable = resolveIntegrations().filter((i) => i.mode === "unavailable").length;
  if (unavailable === 0) return null;
  return (
    <Link href="/profile" className="mt-4 block text-center text-base text-ink-muted underline underline-offset-4">
      {unavailable} service{unavailable === 1 ? " isn't" : "s aren't"} connected yet — see details
    </Link>
  );
}

export default function Home() {
  return (
    <main>
      <header className="px-5 pb-2 pt-10">
        <p className="text-lg font-bold text-brand">Sahaya</p>
        <h1 className="mt-1 text-4xl font-bold leading-tight">
          <Suspense fallback={<>Hello.</>}>
            <Greeting />
          </Suspense>
        </h1>
        <p className="mt-2 text-xl text-ink-muted">Who would you like to talk to?</p>
      </header>

      <ul className="flex flex-col gap-4 px-5 py-4">
        {AGENT_IDS.map((id) => (
          <li key={id}>
            <AgentCard id={id} name={AGENT_DEFINITIONS[id].displayName} tagline={AGENT_DEFINITIONS[id].tagline} />
          </li>
        ))}
      </ul>

      <div className="px-5 pt-2">
        <a
          href="tel:911"
          className="flex min-h-14 items-center justify-center rounded-full bg-danger px-6 text-xl font-bold text-white"
        >
          Emergency? Call 911
        </a>
        <Suspense>
          <ConnectionNotice />
        </Suspense>
      </div>
    </main>
  );
}
