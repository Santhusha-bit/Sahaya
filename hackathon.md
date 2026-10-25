# Hackathon log

- **Project:** Sahaya
- **Event:** Cal Hacks 13.0
- **What it does:** A voice-first PWA where four separate AI agents (Guardian, Care, Wellness, Finance) help older adults, sharing data only through a consent-checked event bus and waiting for human approval on sensitive actions.
- **Live app:** https://sahaya-mu.vercel.app
- **Repo:** https://github.com/Santhusha-bit/Sahaya
- **Frontend:** Vercel
- **Convex deployment:** not deployed (no deployment URL in code; the app falls back to an in-process store)
- **Components:** none
- **Convex features:** schema, indexes, queries, mutations
- **Auth:** Other (Auth0 status check in `src/lib/user.ts`; full login flow not merged)
- **AI models:** claude-opus-4-8, gemini-3.8-flash, deepseek-ai/DeepSeek-V4-Flash, sonic-3, ink-whisper
- **Started:** 2026-10-24T08:45:49Z
- **Last updated:** 2026-10-25T10:49:13Z

## How we use Convex

- **Per-agent memory:** each agent reads and writes only its own `(userId, namespace)` scope, using the `memories` table and its `by_scope` index. See `convex/schema.ts` and `convex/memories.ts`.
- **Agent-to-agent event bus and /activity log:** cross-agent events, including blocked ones kept for audit, are stored via `events` mutations and read with the `by_target` index. See `convex/events.ts` and `src/agents/base/AgentEventBus.ts`.
- **Human approvals:** approval requests and decisions are stored with `approvals:put` and `approvals:patch`. See `convex/approvals.ts` and `src/agents/service.ts`.
- **Chat history:** each agent's conversation is appended and reloaded with `conversations:append` and `conversations:history`. See `convex/conversations.ts` and `src/agents/base/BaseAgent.ts`.
- **Multi-step tasks:** agent task plans and results are stored in `tasks`. See `convex/tasks.ts`.
- **Access path:** the server calls Convex over HTTP with `ConvexHttpClient` (`src/agents/base/convexDataLayer.ts`), chosen in `src/agents/base/dataLayer.ts`. No screen updates live from Convex: there is no `useQuery`, so pages fetch data through API routes on load.

## Log

- 2026-10-24 `8491767`: project brief (`prompt.md`)
- 2026-10-24 `ad4ce7d`: app scaffold with Convex schema, functions and data layer (`convex/*`, `src/agents/base/`)
- 2026-10-24 `e708e3f`: Guardian scam workflow and policy engine (`scripts/demo-scam.ts`)
- 2026-10-24 `b798857`: code-enforced execution gate (`src/agents/base/workItems.ts`)
- 2026-10-24 `4919a9c`: token streaming over SSE (`src/lib/llm.ts`, `AgentExperience.tsx`)
- 2026-10-24 `d512b59`: Vercel deploy config (`vercel.json`)
- 2026-10-24 `d883248`: Wellness integration and dashboard (`scripts/demo-wellness-full.ts`)
- 2026-10-25 `c87eb19`: marketing landing page (`landing/`)
- 2026-10-25 `7b55343`: WebRTC + Claude call screening (`src/app/api/voice/call/`)
- 2026-10-25 `83263f6`: delegated work items and dual control (`src/agents/base/workItemPolicy.ts`)
- 2026-10-25 `d55e44a`: Backboard recall verified against Convex (`scripts/demo-backboard.ts`)
- 2026-10-25 `62aaea8`: rename Kinline to Sahaya (`convex/schema.ts`, `README.md`)
- 2026-10-25 `ce625d1`: Nessie spending review (`src/agents/finance/FinanceAgent.ts`)
- 2026-10-25 `e165f8b`: bill vs. EOB investigation (`scripts/demo-finance-case.ts`)
- 2026-10-25 `6b42241`: Tiger Data wellness trends (`scripts/demo-tigerdata.ts`)
- 2026-10-25 `bc8ae97`: Cartesia STT + TTS call demo (`scripts/demo-scam-call.ts`)
- 2026-10-25 `f0d92a0`: remove Twilio, alerts in-app (`landing/src/data/technologies.ts`)
- 2026-10-25 `cb994ea`: README rewrite per service (`README.md`)
