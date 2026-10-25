// Force sandbox mode for deterministic tests (no network, no external keys).
delete process.env.ANTHROPIC_API_KEY;
delete process.env.NEXT_PUBLIC_CONVEX_URL;
delete process.env.CARTESIA_API_KEY;
delete process.env.GEMINI_API_KEY;
