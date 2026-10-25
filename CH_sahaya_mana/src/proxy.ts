import { NextResponse, type NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/auth/csrf";
import { getAuth0 } from "@/lib/auth0";
import { blockingProblems } from "@/lib/security/envCheck";

let reported = false;

/**
 * Next.js 16 proxy (formerly middleware):
 *  1. Blocks cross-site state-changing requests to /api (CSRF).
 *  2. When Auth0 is enabled, mounts its routes (/auth/login, /auth/callback, /auth/logout, …) and keeps the
 *     session rolling. Authorization itself happens on the server for every data request (fail closed).
 */
export async function proxy(request: NextRequest) {
  // Production/staging refuses to serve until its configuration is safe (no local fallbacks, no leaked keys).
  const problems = blockingProblems(process.env);
  if (problems.length) {
    if (!reported) {
      console.error(`[sahaya] refusing to serve: unsafe configuration (${problems.map((p) => p.code).join(", ")})`);
      reported = true;
    }
    if (request.nextUrl.pathname.startsWith("/api/") || request.nextUrl.pathname.startsWith("/auth/")) {
      return NextResponse.json({ error: "Sahaya isn't configured safely on this server yet.", code: "MISCONFIGURED" }, { status: 503 });
    }
    return new NextResponse(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sahaya is unavailable</title><body style="font:20px/1.5 system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem"><h1>Sahaya is unavailable</h1><p>This server isn't configured safely yet, so it isn't accepting sign-ins or storing information. Please try again later.</p><p style="color:#555">Owners: see the server log for the list of settings to fix.</p></body></html>`,
      { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  }
  if (request.nextUrl.pathname.startsWith("/api/") && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-site request blocked.", code: "CSRF" }, { status: 403 });
  }
  const auth0 = getAuth0();
  if (auth0) {
    // If the identity provider can't be reached (outage, DNS, misconfiguration), show a safe page — never a stack.
    try {
      const res = await auth0.middleware(request);
      if (res.status >= 500 && request.nextUrl.pathname.startsWith("/auth/")) return signInUnavailable();
      return res;
    } catch {
      return request.nextUrl.pathname.startsWith("/api/")
        ? NextResponse.json({ error: "Sign-in is temporarily unavailable. Please try again later.", code: "UNAUTHENTICATED" }, { status: 503 })
        : signInUnavailable();
    }
  }
  if (request.nextUrl.pathname.startsWith("/auth/")) {
    return NextResponse.json({ error: "Sign-in isn't enabled on this server.", code: "UNAUTHENTICATED" }, { status: 503 });
  }
  return NextResponse.next();
}

function signInUnavailable() {
  return new NextResponse(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in unavailable</title><body style="font:20px/1.5 system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem"><h1>Sign-in is temporarily unavailable</h1><p>Sahaya couldn't reach the sign-in service. Nothing was changed. Please try again in a few minutes.</p><p><a href="/">Back to Sahaya</a></p></body></html>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sitemap.xml|robots.txt).*)"],
};
