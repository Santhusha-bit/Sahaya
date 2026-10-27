/**
 * Convex verifies Auth0 ID tokens (RS256, issuer https://<AUTH0_DOMAIN>/, audience = the Auth0 application's
 * client id, expiry) before any function sees `ctx.auth`. Set these as Convex deployment environment variables
 * (Convex dashboard → Settings → Environment Variables), not in code:
 *   AUTH0_DOMAIN     e.g. your-tenant.us.auth0.com   (no https://)
 *   AUTH0_CLIENT_ID  the Regular Web Application's client id
 * See docs.convex.dev/auth/auth0.
 */
const authConfig = {
  providers: [
    {
      // Same form as docs.convex.dev/auth/auth0: the tenant domain without a scheme.
      domain: process.env.AUTH0_DOMAIN ?? "",
      applicationID: process.env.AUTH0_CLIENT_ID ?? "",
    },
  ],
};

export default authConfig;
