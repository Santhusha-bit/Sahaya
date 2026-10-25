import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { MAX_IMAGE_BYTES, stashPantryImage } from "@/agents/care/pantryImages";
import { SUPPORTED_IMAGE_TYPES } from "@/integrations/gemini";
import { pantryIntegrationStatuses } from "@/lib/env";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Care pantry-photo -> dinner flow. Every step runs through Care's real tools
 * (validated, audited, scoped to the caller), so this route is not a backdoor:
 *   GET                      latest scan, preferences, integration status
 *   POST multipart "photo"   scan a photo (or JSON { action: "scan", imageBase64, mimeType })
 *   POST { action: "confirm", confirm?, reject?, add?, confirmAllUncertain? }
 *   POST { action: "plan" }
 *   POST { action: "preferences", preferences }
 */

async function snapshot(service: AgentService) {
  const { record } = await service.runTool("care", "getPantryScan", {});
  const data = (record.output ?? {}) as { scan?: unknown; preferences?: unknown };
  return { scan: data.scan ?? null, preferences: data.preferences ?? null, integrations: pantryIntegrationStatuses() };
}

export async function GET() {
  const user = getCurrentUser();
  const service = await AgentService.forUser(user.id);
  return NextResponse.json(await snapshot(service));
}

export async function POST(req: Request) {
  const user = getCurrentUser();
  const service = await AgentService.forUser(user.id);
  const contentType = req.headers.get("content-type") ?? "";

  let body: Record<string, unknown>;
  let image: { base64: string; mimeType: string } | null = null;
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("photo");
      if (!(file instanceof Blob)) return NextResponse.json({ error: "photo file required" }, { status: 400 });
      if (file.size > MAX_IMAGE_BYTES) return NextResponse.json({ error: "Photo is too large (max 3 MB)." }, { status: 413 });
      image = { base64: Buffer.from(await file.arrayBuffer()).toString("base64"), mimeType: file.type || "image/jpeg" };
      body = { action: "scan" };
    } else {
      body = (await req.json()) as Record<string, unknown>;
      if (body.action === "scan") {
        const b64 = String(body.imageBase64 ?? "").replace(/^data:[^;]+;base64,/, "");
        if (!b64) return NextResponse.json({ error: "imageBase64 required" }, { status: 400 });
        if (Math.floor((b64.length * 3) / 4) > MAX_IMAGE_BYTES) {
          return NextResponse.json({ error: "Photo is too large (max 3 MB)." }, { status: 413 });
        }
        image = { base64: b64, mimeType: String(body.mimeType ?? "image/jpeg") };
      }
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  let record;
  if (body.action === "scan") {
    if (!image || !SUPPORTED_IMAGE_TYPES.includes(image.mimeType)) {
      return NextResponse.json({ error: "Please upload a JPEG, PNG, WebP or HEIC photo." }, { status: 415 });
    }
    const imageId = stashPantryImage(user.id, image.base64, image.mimeType);
    ({ record } = await service.runTool("care", "scanPantryPhoto", { imageId }));
  } else if (body.action === "confirm") {
    ({ record } = await service.runTool("care", "confirmPantryItems", {
      confirm: body.confirm ?? [],
      reject: body.reject ?? [],
      add: body.add ?? [],
      confirmAllUncertain: !!body.confirmAllUncertain,
    }));
  } else if (body.action === "plan") {
    ({ record } = await service.runTool("care", "planDinnerFromPantry", {}));
  } else if (body.action === "preferences") {
    ({ record } = await service.runTool("care", "updateFoodPreferences", body.preferences ?? {}));
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  return NextResponse.json({
    ok: record.status === "success",
    summary: record.summary,
    error: record.error ?? null,
    output: record.output ?? null,
    ...(await snapshot(service)),
  });
}
