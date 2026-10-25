/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Droid SDK spawns the bundled droid CLI binary; load both from node_modules at runtime.
  serverExternalPackages: ["@factory/droid-sdk", "droid"],
  outputFileTracingIncludes: {
    // Investigations start from the investigate screen or from a Finance chat turn.
    "/api/**/*": ["./node_modules/@factory/cli-*/**/*"],
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Content-Type", value: "application/manifest+json" },
        ],
      },
    ];
  },
};

export default nextConfig;
