// Force sandbox mode for deterministic tests (no network, no external keys).
delete process.env.ANTHROPIC_API_KEY;
delete process.env.NEXT_PUBLIC_CONVEX_URL;
delete process.env.CARTESIA_API_KEY;
for (const k of ["FETCHAI_BRIDGE_URL", "FETCHAI_WELLNESS_URL", "FETCHAI_CARE_URL", "FETCHAI_FINANCE_URL"]) delete process.env[k];
delete process.env.MOSS_PROJECT_ID;
delete process.env.MOSS_PROJECT_KEY;
delete process.env.MOSS_API_KEY;

// Grocery discovery: offline fixture catalog, never the network or Apify.
delete process.env.APIFY_TOKEN;
process.env.GROCERY_DISCOVERY_MODE = "sandbox";
delete process.env.BRIGHTDATA_API_TOKEN;
delete process.env.GEMINI_API_KEY;
for (const k of ["CRS_USERNAME", "CRS_USER", "CRS_PASSWORD", "CRS_PASS", "CRS_BASE_URL", "CRS_TEST_PERSONAS", "CRS_LINKED_PERSONA"]) delete process.env[k];
delete process.env.FACTORY_API_KEY;

// Auth0: single-user demo mode (no sign-in) unless a test opts in.
for (const k of ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET"]) delete process.env[k];
