// Force sandbox mode for deterministic tests (no network, no external keys).
delete process.env.ANTHROPIC_API_KEY;
delete process.env.NEXT_PUBLIC_CONVEX_URL;
delete process.env.CARTESIA_API_KEY;
for (const k of ["CRS_USERNAME", "CRS_USER", "CRS_PASSWORD", "CRS_PASS", "CRS_BASE_URL", "CRS_TEST_PERSONAS", "CRS_LINKED_PERSONA"]) delete process.env[k];
