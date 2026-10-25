// Force sandbox mode for deterministic tests (no network, no external keys).
delete process.env.ANTHROPIC_API_KEY;
delete process.env.NEXT_PUBLIC_CONVEX_URL;
delete process.env.CARTESIA_API_KEY;

// Grocery discovery: offline fixture catalog, never the network or Apify.
delete process.env.APIFY_TOKEN;
process.env.GROCERY_DISCOVERY_MODE = "sandbox";
