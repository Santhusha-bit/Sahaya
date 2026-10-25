import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

const SIZES = ["180", "192", "512", "maskable-512"] as const;

export function generateStaticParams() {
  return SIZES.map((size) => ({ size }));
}

/** PWA / apple-touch icons, rendered at build time. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/icons/[size]">) {
  const { size } = await ctx.params;
  if (!(SIZES as readonly string[]).includes(size)) return new Response("Not found", { status: 404 });
  const maskable = size.startsWith("maskable");
  const px = Number(size.replace("maskable-", ""));
  // Maskable icons keep content inside the central 80% safe zone.
  const mark = Math.round(px * (maskable ? 0.5 : 0.62));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#3b3a8f",
          borderRadius: maskable ? 0 : px * 0.22,
        }}
      >
        <svg width={mark} height={mark} viewBox="0 0 24 24" fill="none" stroke="#f7f5f0" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="3" />
          <circle cx="16.5" cy="9" r="2.5" />
          <path d="M2.5 20a5.5 5.5 0 0111 0M13.5 20a4 4 0 018 0" />
        </svg>
      </div>
    ),
    { width: px, height: px },
  );
}
