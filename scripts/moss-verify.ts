/**
 * npm run moss:verify
 *
 * Real round-trip against the Moss control plane with the configured credentials:
 * listIndexes (credentials + index exist), then addDocs / getDocs / deleteDocs on a
 * throwaway probe doc. Prints exactly what happened; exits non-zero on failure.
 * Never prints the project key.
 */

import { MossPersonalMemory, mossConfigFromEnv } from "@/integrations/moss";
import { id } from "@/lib/id";

async function main() {
  const cfg = mossConfigFromEnv();
  if (!cfg) {
    console.log("Moss not configured: set MOSS_PROJECT_ID, MOSS_PROJECT_KEY and MOSS_INDEX_NAME. Wellness runs on the sandbox index.");
    process.exit(1);
  }
  const moss = new MossPersonalMemory(cfg);
  const v = await moss.verify();
  console.log(`${v.ok ? "✓" : "✗"} listIndexes: ${v.detail}`);
  if (!v.ok) process.exit(1);

  const probe = { id: `kc_probe_${id()}`, text: "Sahaya connectivity probe.", metadata: { subject: "probe", topic: "probe", signal: "mentioned", kind: "sahaya-probe" } };
  await moss.upsert([probe]);
  console.log("✓ addDocs accepted (async build job started).");
  const got = await moss.get([probe.id]);
  console.log(got.length ? "✓ getDocs returned the probe doc." : "… getDocs did not return the probe yet (index build is asynchronous; re-run in a moment).");
  await moss.remove([probe.id]);
  console.log("✓ deleteDocs accepted.");
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
