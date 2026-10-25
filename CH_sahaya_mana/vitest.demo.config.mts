import path from "node:path";
import { defineConfig } from "vitest/config";

/** Runs the narrated, deterministic Care demos (npm run demo:medication | demo:grocery | demo:meals). */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["demos/**/*.demo.ts"],
    environment: "node",
    disableConsoleIntercept: true,
    reporters: ["dot"],
    testTimeout: 30_000,
  },
});
