import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { authConfig } from "@/lib/auth/identity";

/**
 * The Auth0 client (SDK v4), created only when the owner has enabled Auth0 (SAHAYA_AUTH=auth0) and all
 * AUTH0_* settings exist. It holds configuration only — sessions live in the SDK's encrypted cookie, so there is
 * no per-user state in this module. Returns null when sign-in isn't enabled (the app then fails closed).
 */
let client: Auth0Client | null = null;
let clientKey = "";

export function getAuth0(): Auth0Client | null {
  const cfg = authConfig(process.env);
  if (cfg.provider !== "auth0") return null;
  const key = `${cfg.domain}|${cfg.clientId}`;
  if (!client || clientKey !== key) {
    client = new Auth0Client({
      domain: cfg.domain,
      clientId: cfg.clientId,
      clientSecret: process.env.AUTH0_CLIENT_SECRET,
      secret: process.env.AUTH0_SECRET,
      appBaseUrl: process.env.APP_BASE_URL || undefined,
      // Identity only: no email or extra profile claims are needed by Sahaya.
      authorizationParameters: { scope: "openid profile" },
      signInReturnToPath: "/",
      // Short, rolling sessions for a care app: sign in again after 2 h idle or 8 h total (inside the ID token's
      // default 10 h lifetime, which the database needs). Cookies: HttpOnly (always, set by the SDK), SameSite=Lax,
      // Secure in production and whenever the base URL is https.
      session: {
        rolling: true,
        inactivityDuration: 2 * 60 * 60,
        absoluteDuration: 8 * 60 * 60,
        cookie: {
          sameSite: "lax",
          path: "/",
          secure: process.env.NODE_ENV === "production" || (process.env.APP_BASE_URL ?? "").startsWith("https://"),
        },
      },
    });
    clientKey = key;
  }
  return client;
}
