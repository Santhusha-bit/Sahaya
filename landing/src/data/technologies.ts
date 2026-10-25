/**
 * Centralized technology catalog for the "Technology behind Sahaya" showcase.
 *
 * `status` is derived from inspecting the actual repository:
 *   - "used": a real integration module exists in src/integrations/ or it is a
 *     core dependency of the running product (confirmed in package.json / code).
 *   - "planned": referenced as a future integration, not yet in the codebase.
 *   - "dev-tool": used to build Sahaya, not part of the runtime product.
 *
 * Logos are referenced from the local /logos directory (official SVG marks).
 */

export type TechCategory =
  | "Voice & Communication"
  | "AI & Memory"
  | "Infrastructure"
  | "Security"
  | "Automation";

export type TechStatus = "used" | "planned" | "dev-tool";

export type Technology = {
  id: string;
  name: string;
  category: TechCategory;
  /** Short label under the name in the hover cloud. */
  tagline: string;
  /** What the product/service is. */
  what: string;
  /** How Sahaya uses it. */
  role: string;
  /** Why it matters to the overall solution. */
  why: string;
  /** Which Sahaya capabilities it supports. */
  capabilities: string[];
  status: TechStatus;
  website: string;
  logo: string;
  /** Fallback background tint for the logo container. */
  accent?: string;
};

export const STATUS_LABEL: Record<TechStatus, string> = {
  used: "Used in Sahaya",
  planned: "Planned Integration",
  "dev-tool": "Development Tool",
};

export const TECHNOLOGIES: Technology[] = [
  {
    id: "cartesia",
    name: "Cartesia",
    category: "Voice & Communication",
    tagline: "Voice AI Infrastructure",
    what: "A low-latency voice AI platform for real-time, natural speech.",
    role: "Cartesia powers Sahaya's natural voice conversations so older adults can speak normally instead of navigating menus. When a key is absent, Sahaya falls back to the browser's built-in speech engine.",
    why: "Natural voice interaction is central to Sahaya's accessibility, reducing dependence on complex interfaces.",
    capabilities: ["Guardian", "Care", "Wellness", "Finance"],
    status: "used",
    website: "https://cartesia.ai",
    logo: "/logos/cartesia.svg",
    accent: "#eef1ff",
  },
  {
    id: "twilio",
    name: "Twilio",
    category: "Voice & Communication",
    tagline: "Communications Infrastructure",
    what: "Programmable communications for phone calls and messaging.",
    role: "Twilio screens inbound scam-call transcripts for Guardian and powers outbound notifications to trusted contacts and family. Without credentials, these workflows run in a local sandbox.",
    why: "It connects the companion with older adults and family through familiar, trusted channels.",
    capabilities: ["Guardian", "Care", "Emergency"],
    status: "used",
    website: "https://twilio.com",
    logo: "/logos/twilio.svg",
    accent: "#fdeeee",
  },
  {
    id: "convex",
    name: "Convex",
    category: "Infrastructure",
    tagline: "Real-Time Backend",
    what: "A reactive backend for application data and live synchronization.",
    role: "Convex stores structured records (alerts, reminders, approvals, histories) and synchronizes them between Sahaya's agents and the family dashboard. Without it, an in-process store is used.",
    why: "It keeps family dashboards, alerts, and approvals timely and consistent.",
    capabilities: ["Guardian", "Care", "Wellness", "Finance"],
    status: "used",
    website: "https://convex.dev",
    logo: "/logos/convex.svg",
    accent: "#f3eefe",
  },
  {
    id: "moss",
    name: "Moss",
    category: "AI & Memory",
    tagline: "AI Memory & Retrieval",
    what: "A personal memory layer for AI applications.",
    role: "Moss helps retrieve permission-approved personal context and preferences so conversations feel continuous. It falls back to the Convex / in-process store with the same interface.",
    why: "It lets Sahaya personalize conversations without repeatedly asking for the same information.",
    capabilities: ["Wellness", "Guardian", "Care"],
    status: "used",
    website: "https://getmoss.com",
    logo: "/logos/moss.svg",
    accent: "#eef6f1",
  },
  {
    id: "backboard",
    name: "Backboard",
    category: "AI & Memory",
    tagline: "Long-Term AI Memory",
    what: "Long-term conversational context storage and retrieval.",
    role: "Backboard helps maintain permitted conversational history across interactions for personalized follow-ups. It falls back to the Convex / in-process store when no key is present.",
    why: "It supports long-term continuity in wellness check-ins and personalized assistance.",
    capabilities: ["Wellness"],
    status: "used",
    website: "https://backboard.io",
    logo: "/logos/backboard.svg",
    accent: "#eef1ff",
  },
  {
    id: "fetchai",
    name: "Fetch.ai",
    category: "Automation",
    tagline: "Agent Infrastructure",
    what: "Infrastructure for autonomous agent discovery and coordination.",
    role: "A Fetch.ai uAgents bridge lets Sahaya exchange typed messages with external agents for bounded assistance workflows. Without the bridge, the same exchange runs on the in-process bus.",
    why: "It extends Sahaya's ability to coordinate specialized tasks beyond a single conversation.",
    capabilities: ["Care", "Guardian", "Finance"],
    status: "used",
    website: "https://fetch.ai",
    logo: "/logos/fetchai.svg",
    accent: "#eef0f5",
  },
  {
    id: "bitdeer",
    name: "Bitdeer AI",
    category: "AI & Memory",
    tagline: "AI Model Inference",
    what: "An AI Model Studio offering OpenAI-compatible inference.",
    role: "Bitdeer's inference API extracts structured wellness observations from everyday conversation. Output is schema-validated and evidence-checked in code before use; a deterministic offline extractor runs when no key is set.",
    why: "It turns natural conversation into careful, verifiable wellness signals without clinical claims.",
    capabilities: ["Wellness"],
    status: "used",
    website: "https://www.bitdeer.ai",
    logo: "/logos/bitdeer.svg",
    accent: "#eaf3ff",
  },
  {
    id: "tigerdata",
    name: "Tiger Data",
    category: "Infrastructure",
    tagline: "Time-Series Analytics",
    what: "A time-series database built on PostgreSQL (TimescaleDB).",
    role: "Tiger Data stores and trends self-reported sleep and energy series over time for Wellness. Without credentials, a local time-series store computes the same trends.",
    why: "It reveals meaningful longitudinal patterns in self-reported well-being.",
    capabilities: ["Wellness"],
    status: "used",
    website: "https://www.tigerdata.com",
    logo: "/logos/tigerdata.svg",
    accent: "#fff6e8",
  },
  {
    id: "snowflake",
    name: "Snowflake",
    category: "Infrastructure",
    tagline: "Analytics Data Cloud",
    what: "A cloud data platform for analytics at scale.",
    role: "With explicit consent, only de-identified household wellness aggregates flow to Snowflake. Without credentials, aggregates are computed locally and nothing leaves the device.",
    why: "It supports authorized, privacy-preserving household analytics.",
    capabilities: ["Wellness"],
    status: "used",
    website: "https://snowflake.com",
    logo: "/logos/snowflake.svg",
    accent: "#eaf6ff",
  },
  {
    id: "elastic",
    name: "Elasticsearch",
    category: "Infrastructure",
    tagline: "Search & Retrieval",
    what: "A search and analytics engine for fast retrieval.",
    role: "PII-redacted safety incidents are indexed in Elasticsearch for keyword and semantic search by Guardian. Without credentials, a local in-memory index with the same interface is used.",
    why: "It helps surface relevant past incidents to inform safer decisions.",
    capabilities: ["Guardian"],
    status: "used",
    website: "https://elastic.co",
    logo: "/logos/elastic.svg",
    accent: "#fff3ef",
  },
  {
    id: "jira",
    name: "Atlassian Jira",
    category: "Automation",
    tagline: "Controlled Action Review",
    what: "Issue tracking for controlled, human-reviewed workflows.",
    role: "Sensitive agent work items can mirror to Jira issues for human review, gated by a hash / role / expiry / single-use execution check. Without credentials, a local sandbox work-item store is used.",
    why: "It keeps sensitive actions reviewable and under human control.",
    capabilities: ["Guardian", "Care", "Finance"],
    status: "used",
    website: "https://atlassian.com/software/jira",
    logo: "/logos/jira.svg",
    accent: "#eef1ff",
  },
  {
    id: "anthropic",
    name: "Claude",
    category: "AI & Memory",
    tagline: "Agent Reasoning (Anthropic)",
    what: "Anthropic's family of large language models.",
    role: "Claude provides the reasoning behind each Sahaya agent's planning and conversation. Without a key, agents run in a deterministic sandbox that exercises the same tools, approvals, and memory.",
    why: "Careful, steerable reasoning is essential when handling safety, health, and finances.",
    capabilities: ["Guardian", "Care", "Wellness", "Finance"],
    status: "used",
    website: "https://www.anthropic.com",
    logo: "/logos/anthropic.svg",
    accent: "#f6efe8",
  },
  {
    id: "auth0",
    name: "Auth0",
    category: "Security",
    tagline: "Authentication",
    what: "An identity and authentication platform.",
    role: "Auth0 secures access for older adults and authorized family members. Without credentials, Sahaya runs in a single-user demo mode.",
    why: "Trusted identity is foundational when permissions control access to sensitive information.",
    capabilities: ["Guardian", "Care", "Wellness", "Finance"],
    status: "used",
    website: "https://auth0.com",
    logo: "/logos/auth0.svg",
    accent: "#f1eefe",
  },
  {
    id: "nextjs",
    name: "Next.js",
    category: "Infrastructure",
    tagline: "Application Framework",
    what: "A React framework for web applications and dashboards.",
    role: "Next.js is the foundation for Sahaya's web interfaces and the family dashboard.",
    why: "It enables responsive, maintainable, and performant experiences.",
    capabilities: ["Guardian", "Care", "Wellness", "Finance"],
    status: "used",
    website: "https://nextjs.org",
    logo: "/logos/nextjs.svg",
    accent: "#f1f2f4",
  },
  {
    id: "armadin",
    name: "Armadin",
    category: "Security",
    tagline: "Adversarial Testing",
    what: "AI security and adversarial testing tooling.",
    role: "Armadin can evaluate how Sahaya handles adversarial conversations and safety-bypass attempts. Sahaya's local red-team suite runs today; Armadin is a planned integration and is never claimed as live.",
    why: "Security testing matters most when handling scams, personal data, and sensitive actions.",
    capabilities: ["Guardian", "Finance"],
    status: "planned",
    website: "https://armadin.ai",
    logo: "/logos/armadin.svg",
    accent: "#fdeeee",
  },
  {
    id: "apify",
    name: "Apify",
    category: "Automation",
    tagline: "Web Data & Automation",
    what: "A platform for structured web data extraction and automation.",
    role: "Care uses Apify to search real product listings for the person's usual groceries, so the cart shows current products and prices. Without an Apify token it uses a sandbox catalog with the same interface, and each cart says which one it used.",
    why: "It lets Sahaya build a personalized cart from real products, with substitutions chosen by deterministic rules rather than the model.",
    capabilities: ["Care"],
    status: "used",
    website: "https://apify.com",
    logo: "/logos/apify.svg",
    accent: "#eef6f1",
  },
  {
    id: "creao",
    name: "Creao AI",
    category: "Automation",
    tagline: "Workflow Automation",
    what: "A platform for reusable AI agent workflows.",
    role: "Creao AI could support structured, reusable assistance workflows for recurring tasks. It is a planned integration, not yet in the codebase.",
    why: "Reusable workflows can make recurring assistance more consistent.",
    capabilities: ["Care", "Finance"],
    status: "planned",
    website: "https://creao.ai",
    logo: "/logos/creao.svg",
    accent: "#eef1ff",
  },
  {
    id: "factory",
    name: "Factory",
    category: "Automation",
    tagline: "AI Development Tools",
    what: "AI-assisted software development tooling.",
    role: "Factory's tools can assist with building, testing, and maintaining Sahaya's software. It is a development tool, not part of the runtime product.",
    why: "It helps accelerate development and validation of Sahaya's features.",
    capabilities: ["Development"],
    status: "dev-tool",
    website: "https://factory.ai",
    logo: "/logos/factory.svg",
    accent: "#f1f2f4",
  },
];

export const TECH_CATEGORIES: ("All" | TechCategory)[] = [
  "All",
  "Voice & Communication",
  "AI & Memory",
  "Infrastructure",
  "Security",
  "Automation",
];
