import { isConvexLive } from "@/lib/env";
import { createConvexDataLayer } from "./convexDataLayer";
import { createInMemoryDataLayer } from "./memoryStore";
import type { DataLayer } from "./types";

/**
 * Process-wide data layer. Prefers Convex when configured, otherwise an
 * in-process store shared across requests via a global (so conversation/task
 * state survives between API calls within one dev server process).
 */
const GLOBAL_KEY = "__Sahaya_data_layer__";

export function getDataLayer(): DataLayer {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as DataLayer;

  let layer: DataLayer;
  if (isConvexLive() && process.env.NEXT_PUBLIC_CONVEX_URL) {
    layer = createConvexDataLayer(process.env.NEXT_PUBLIC_CONVEX_URL);
  } else {
    layer = createInMemoryDataLayer();
  }
  g[GLOBAL_KEY] = layer;
  return layer;
}

/** For tests: a fresh isolated layer. */
export { createInMemoryDataLayer };
