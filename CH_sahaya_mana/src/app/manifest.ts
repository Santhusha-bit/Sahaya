import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sahaya",
    short_name: "Sahaya",
    description: "Four AI agents for safety, everyday care, wellbeing, and money — built for independent living.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f5f0",
    theme_color: "#3b3a8f",
    categories: ["health", "lifestyle", "finance"],
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Guardian", url: "/agents/guardian" },
      { name: "Care", url: "/agents/care" },
      { name: "Wellness", url: "/agents/wellness" },
      { name: "Finance", url: "/agents/finance" },
    ],
  };
}
