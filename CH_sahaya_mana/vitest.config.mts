import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // Route handlers are tested for real; `server-only` is a build-time marker with no runtime behaviour.
      "server-only": path.resolve(import.meta.dirname, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // convex-test runs Convex functions in the edge-runtime environment (see tests/convex/*).
    server: { deps: { inline: ["convex-test"] } },
  },
});
