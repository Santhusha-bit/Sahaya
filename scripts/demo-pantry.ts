/**
 * npm run demo:pantry [-- path/to/fridge.jpg]
 *
 * Margaret's pantry-photo -> dinner flow end to end through Care's real tools:
 * Gemini proposes ingredients, the policy holds back uncertain items, Margaret
 * confirms them, the deterministic planner proposes a dinner and drafts a list
 * of missing items. With GEMINI_API_KEY set and a photo path, it makes a REAL
 * Gemini vision request; otherwise the labeled sandbox sample fridge is used.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { geminiStatus } from "@/lib/env";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { getPantryVisionProvider } from "@/integrations/gemini";
import { stashPantryImage } from "@/agents/care/pantryImages";

function line(c = "─") {
  console.log(c.repeat(70));
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic" };

async function main() {
  const status = geminiStatus();
  const provider = getPantryVisionProvider();
  const photoPath = process.argv[2];

  line("═");
  console.log(`SAHAYA: Care pantry photo -> dinner (Gemini vision: ${status.mode})`);
  console.log(status.detail);
  console.log(`Provider: ${provider.name}  |  Model: ${provider.model}`);
  line("═");

  const userId = "margaret";
  const care = createAgent("care", { data: createInMemoryDataLayer(), userId });
  await care.initialize();

  const bytes = photoPath ? readFileSync(photoPath) : Buffer.from("sample");
  const mime = photoPath ? MIME[extname(photoPath).toLowerCase()] ?? "image/jpeg" : "image/jpeg";
  if (!photoPath && provider.mode === "live") {
    console.log("Tip: pass a photo path to analyze a real image: npm run demo:pantry -- fridge.jpg");
  }

  console.log("\n1. Margaret takes a photo of her refrigerator.");
  const scan = await care.executeTool("scanPantryPhoto", { imageId: stashPantryImage(userId, bytes.toString("base64"), mime) });
  console.log(`   Care: ${scan.result.summary}`);
  const view = scan.result.data as { uncertain: { name: string; confidence: number | null }[]; rejectedByPolicy: { value: string; reason: string }[] } | undefined;
  if (!scan.result.ok || !view) {
    console.log(`   (scan failed: ${scan.result.error})`);
    process.exitCode = 1;
    return;
  }
  for (const r of view.rejectedByPolicy) console.log(`   [policy] ignored "${r.value}" (${r.reason})`);

  console.log("\n2. Care tries to plan before the uncertain items are checked:");
  const early = await care.executeTool("planDinnerFromPantry", {});
  console.log(`   ${early.result.ok ? "planned (no uncertain items)" : `refused: ${early.result.summary}`}`);

  if (view.uncertain.length) {
    // Margaret confirms the first uncertain items and says no to the last one.
    const confirm = view.uncertain.slice(0, -1).map((u) => u.name);
    const reject = view.uncertain.slice(-1).map((u) => u.name);
    console.log(`\n3. Margaret answers: yes to ${confirm.join(", ") || "none"}; no to ${reject.join(", ")}.`);
    const c = await care.executeTool("confirmPantryItems", { confirm, reject });
    console.log(`   Care: ${c.result.summary}`);
  }

  console.log("\n4. Care plans dinner from confirmed items + her preferences:");
  const plan = await care.executeTool("planDinnerFromPantry", {});
  console.log(`   Care: ${plan.result.summary}`);
  const data = plan.result.data as
    | { plan: { dinner: { name: string; using: string[]; steps: string[]; tips: string[] }; missingItems: { item: string; productName: string | null; price: number | null; optional: boolean }[]; excluded: { recipe: string; reason: string }[] }; preferences: Record<string, unknown> }
    | undefined;
  if (plan.result.ok && data) {
    line();
    console.log(`   ${data.plan.dinner.name}  (uses ${data.plan.dinner.using.join(", ")})`);
    data.plan.dinner.steps.forEach((s, i) => console.log(`     ${i + 1}. ${s}`));
    data.plan.dinner.tips.forEach((t) => console.log(`     tip: ${t}`));
    console.log("   Shopping list (drafted, NOT ordered):");
    for (const m of data.plan.missingItems) {
      console.log(`     - ${m.productName ?? m.item}${m.price !== null ? `  $${m.price.toFixed(2)}` : ""}${m.optional ? "  (optional)" : ""}`);
    }
    for (const e of data.plan.excluded) console.log(`   [filtered] ${e.recipe}: ${e.reason}`);
    line();
  }

  const orders = await care.memory.list("orders");
  console.log(`\nOrders placed: ${orders.length} (ordering still requires Margaret's approval).`);
  const audit = (await care.memory.readShared("audit")).filter((a) => String(a.data.action).startsWith("pantry."));
  console.log(`Audit trail: ${audit.map((a) => a.data.action).reverse().join(" -> ")}`);
  if (!plan.result.ok || orders.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
