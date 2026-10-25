import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { appEnv, type EnvLike } from "@/lib/config/env";

/**
 * The explicit local test mode's store file. New name: .data/sahaya-store.json. If only the file from before the
 * rename (.data/kinline-store.json) exists, it is moved once (same folder, atomic rename, permissions kept) so local
 * test data isn't lost. SAHAYA_STORE_PATH (or the deprecated KINLINE_STORE_PATH) still overrides the location.
 */
export function resolveLocalStorePath(env: EnvLike, dataDir: string): string {
  const explicit = appEnv(env, "STORE_PATH");
  if (explicit) return explicit;
  const current = join(dataDir, "sahaya-store.json");
  const legacy = join(dataDir, "kinline-store.json");
  if (!existsSync(current) && existsSync(legacy)) {
    try {
      renameSync(legacy, current);
    } catch {
      return legacy; // couldn't move it: keep using the old file rather than starting empty
    }
  }
  return current;
}
