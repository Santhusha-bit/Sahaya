import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This landing app is nested inside the main repo; pin the tracing root
  // to itself so Next doesn't infer the parent workspace.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
