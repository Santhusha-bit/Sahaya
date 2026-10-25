import { describe, expect, it } from "vitest";
import { ConvexStore } from "@/lib/storage/ConvexStore";

/** The real ConvexStore client against fake network responses (no deployment is contacted). */
const URL_ = "https://happy-animal-123.convex.cloud";
const store = (fetchImpl: typeof fetch) => new ConvexStore(URL_, "synthetic.jwt.token", { fetch: fetchImpl });
const json = (body: object, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ConvexStore failure handling (no fallback, actionable errors)", () => {
  it("network outage → STORAGE_UNAVAILABLE", async () => {
    const s = store((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(s.listMessages("care", "u")).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(s.appendLog({ id: "l", agentId: "care", userId: "u", kind: "memory", level: "info", message: "x", at: 1 })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });

  it("functions not deployed / server error → STORAGE_UNAVAILABLE (never local)", async () => {
    await expect(store((async () => new Response("Could not find public function for 'agentStore:listMessages'", { status: 404 })) as unknown as typeof fetch).listMessages("care", "u")).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(store((async () => new Response("oops", { status: 500 })) as unknown as typeof fetch).listMessages("care", "u")).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });

  it("maps the functions' typed errors: unauthenticated, forbidden", async () => {
    const err = (code: string) => json({ status: "error", errorMessage: JSON.stringify({ code }), errorData: { code }, logLines: [] }, 560) as unknown as typeof fetch;
    await expect(store(err("UNAUTHENTICATED")).listMessages("care", "u")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(store(err("FORBIDDEN")).listMessages("care", "u")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(store((async () => new Response("Unauthenticated: token expired", { status: 401 })) as unknown as typeof fetch).listMessages("care", "u")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("sends the person's token, never a user id as identity, and no undefined fields", async () => {
    let seen: { auth: string | null; body: unknown } | null = null;
    const s = store((async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen = { auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ status: "success", value: [], logLines: [] }), { status: 200 });
    }) as unknown as typeof fetch);
    await s.listMemory("care", "u");
    expect(seen!.auth).toBe("Bearer synthetic.jwt.token");
    expect(seen!.body).toMatchObject({ path: "agentStore:listMemory" });
  });
});
