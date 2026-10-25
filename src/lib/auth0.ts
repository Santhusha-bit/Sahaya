import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { isAuth0Configured } from "./env";

/**
 * The Auth0 client, or null when Auth0 is not configured (single-user demo mode).
 * Reads AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_SECRET and
 * APP_BASE_URL from the environment. Routes mounted by the middleware:
 * /auth/login, /auth/callback, /auth/logout, /auth/profile.
 */
export const auth0: Auth0Client | null = isAuth0Configured()
  ? new Auth0Client({
      authorizationParameters: { scope: "openid profile email" },
    })
  : null;
