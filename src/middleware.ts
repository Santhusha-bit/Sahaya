import { NextResponse, type NextRequest } from "next/server";
import { auth0 } from "@/lib/auth0";

/**
 * Endpoints that authenticate themselves and are called by machines, not a
 * signed-in browser: the uAgents bridge (x-sahaya-bridge-token) and the x402
 * paid services (X-PAYMENT).
 */
const PUBLIC_PREFIXES = ["/api/bridge/guardian/assistance", "/api/x402/"];

export async function middleware(request: NextRequest) {
  // Demo mode: no Auth0, no sign-in.
  if (!auth0) return NextResponse.next();

  // Mounts /auth/login, /auth/callback, /auth/logout, /auth/profile and keeps
  // the rolling session cookie fresh on every other request.
  const authRes = await auth0.middleware(request);
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/auth/")) return authRes;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return authRes;

  const session = await auth0.getSession(request);
  if (session) return authRes;

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthenticated", login: "/auth/login" }, { status: 401 });
  }
  const login = new URL("/auth/login", request.nextUrl.origin);
  login.searchParams.set("returnTo", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|manifest.webmanifest|sw.js|icons/|logos/|samples/).*)",
  ],
};
