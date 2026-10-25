/**
 * HTTP security headers for every response (applied in next.config.ts). Pure, so it is unit-tested.
 * The CSP allows only what the app uses: Next's inline bootstrap scripts, the voice AudioWorklet (blob: module),
 * recorded/synthesised audio (blob:), Cartesia's API and WebSockets (the browser connects with a short-lived token),
 * and Auth0 only via top-level navigation. Framing is forbidden; the microphone is allowed for this origin only.
 */
type Directive = [name: string, sources: string[]];

/** https-only extras (HSTS, upgrade-insecure-requests) only when the app is really served over https. */
const httpsDeployment = (env: Partial<Record<string, string | undefined>>) => env.NODE_ENV === "production" && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(env.APP_BASE_URL ?? "");

export function contentSecurityPolicy(env: Partial<Record<string, string | undefined>>): string {
  const prod = env.NODE_ENV === "production";
  const script = ["'self'", "'unsafe-inline'", "blob:", ...(prod ? [] : ["'unsafe-eval'"])];
  const connect = ["'self'", "https://api.cartesia.ai", "wss://api.cartesia.ai", ...(prod ? [] : ["ws:"])];
  const directives: Directive[] = [
    ["default-src", ["'self'"]],
    ["script-src", script],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["media-src", ["'self'", "blob:", "data:"]],
    ["connect-src", connect],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  const csp = directives.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
  return httpsDeployment(env) ? `${csp}; upgrade-insecure-requests` : csp;
}

export function securityHeaders(env: Partial<Record<string, string | undefined>>): Array<{ key: string; value: string }> {
  const prod = httpsDeployment(env);
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(env) },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ...(prod ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
  ];
}
