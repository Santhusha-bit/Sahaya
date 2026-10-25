import { auth0 } from "./auth0";

export interface SahayaUser {
  id: string;
  name: string;
  email?: string;
  picture?: string;
  role: "elder" | "caregiver";
  authMode: "live" | "sandbox";
}

/** Optional custom claim (set by an Auth0 post-login Action) carrying the person's role. */
const ROLE_CLAIM = "https://sahaya.app/role";

export class UnauthenticatedError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "UnauthenticatedError";
  }
}

function demoUser(): SahayaUser {
  return {
    id: process.env.SAHAYA_DEMO_USER_ID?.trim() || "demo-user",
    name: "Eleanor",
    role: "elder",
    authMode: "sandbox",
  };
}

/**
 * Resolve the current user. With Auth0 configured this is the signed-in Auth0
 * user (the middleware already redirects or 401s anyone without a session).
 * Without Auth0, Sahaya runs in single-user demo mode (honest "sandbox" auth).
 */
export async function getCurrentUser(): Promise<SahayaUser> {
  if (!auth0) return demoUser();

  let session;
  try {
    session = await auth0.getSession();
  } catch {
    // Outside a request (CLI demo scripts, tests): there is no session cookie to read.
    return demoUser();
  }
  if (!session) throw new UnauthenticatedError();

  const u = session.user;
  return {
    id: u.sub,
    name: u.name || u.given_name || u.nickname || u.email || "Sahaya user",
    email: u.email,
    picture: u.picture,
    role: u[ROLE_CLAIM] === "caregiver" ? "caregiver" : "elder",
    authMode: "live",
  };
}
