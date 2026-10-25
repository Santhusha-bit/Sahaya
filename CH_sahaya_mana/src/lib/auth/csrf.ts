/**
 * Cross-site request protection for state-changing API calls. A browser always sends `Origin` (or
 * `Sec-Fetch-Site`) on POST/PUT/PATCH/DELETE; we require it to be this same origin. This is CSRF defence only —
 * it is not authentication (headers can be forged by non-browser clients, which still need a valid session).
 */
export function isSameOriginRequest(req: { method: string; url: string; headers: { get(name: string): string | null } }): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return true;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (!origin) return site === "same-origin";
  try {
    const host = req.headers.get("host") ?? new URL(req.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
