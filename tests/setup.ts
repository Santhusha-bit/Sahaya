// Force sandbox mode for deterministic tests (no network, no external keys).
delete process.env.ANTHROPIC_API_KEY;
delete process.env.NEXT_PUBLIC_CONVEX_URL;
delete process.env.CARTESIA_API_KEY;
for (const k of ["FETCHAI_BRIDGE_URL", "FETCHAI_WELLNESS_URL", "FETCHAI_CARE_URL", "FETCHAI_FINANCE_URL"]) delete process.env[k];
delete process.env.MOSS_PROJECT_ID;
delete process.env.MOSS_PROJECT_KEY;
delete process.env.MOSS_API_KEY;
