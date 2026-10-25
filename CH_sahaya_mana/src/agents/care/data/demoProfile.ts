import type { AgentStore } from "../../base/AgentStore";
import type { CaregiverPermission } from "../../base/types";
import { DEFAULT_DOSE_RULES, DEFAULT_ESCALATION, type Medication } from "../domain/medication";
import type { PantryItem } from "../domain/meals";
import { addLocalDays, localDateOf, zonedTimeToUtc } from "../domain/time";
import { catalogById } from "./catalog";
import { NS, type CareProfile, type CareRepo, type GroceryPreferences } from "../repository";
import type { CareFact } from "../memory/facts";

/**
 * Margaret — a FICTIONAL demonstration persona. Every record is flagged `demo: true` and the UI
 * labels it "Demo profile". Medications are invented names; nothing here is real patient data.
 */
export const DEMO_TIME_ZONE = "America/Los_Angeles";
export const DEMO_CAREGIVER = { id: "cg_margaret_daughter", name: "Ellen (Margaret's daughter, demo)" };
export const DEMO_LIMITED_CAREGIVER = { id: "cg_demo_neighbor", name: "Sam (neighbor, grocery-only, demo)" };
/** Opaque ids: ids appear in audit logs, so they must not name the medication. */
export const DEMO_MEDS = { morning: "med_demo_01", evening: "med_demo_02" } as const;

/** 07:55 local time on the demo date — five minutes before the morning reminder. */
export function demoStart(localDate = "2026-10-26") {
  return zonedTimeToUtc(localDate, "07:55", DEMO_TIME_ZONE);
}

export function demoMedications(now: number, enteredBy: string): Medication[] {
  const base = {
    timeZone: DEMO_TIME_ZONE,
    rules: DEFAULT_DOSE_RULES,
    pillsPerDose: 1,
    refillLeadDays: 5,
    pharmacy: { id: "pharm_maple_sbx", name: "Maple Street Pharmacy (sandbox)" },
    scheduleSource: { enteredBy, source: "prescription_label" as const, at: now },
    scheduleHistory: [],
    supplyHistory: [],
    active: true,
    demo: true,
  };
  return [
    {
      ...base,
      id: DEMO_MEDS.morning,
      name: "Calmapril 10 mg (fictional)",
      doseText: "Take 1 tablet by mouth every morning.",
      purpose: "Blood pressure (fictional demo medication)",
      schedule: [{ slot: "morning", time: "08:00" }],
      // The estimate (7) is deliberately higher than what Margaret will report (2): estimates drift.
      pillsRemaining: 7,
      rxNumber: "RX-DEMO-4471",
      lastFill: { date: addLocalDays(localDateOf(now, DEMO_TIME_ZONE), -27), quantity: 30 },
      refillsRemaining: 2,
    },
    {
      ...base,
      id: DEMO_MEDS.evening,
      name: "Nocturin 5 mg (fictional)",
      doseText: "Take 1 tablet by mouth every evening.",
      purpose: "Evening medication (fictional demo medication)",
      schedule: [{ slot: "evening", time: "20:00" }],
      pillsRemaining: 24,
      rxNumber: "RX-DEMO-5820",
      lastFill: { date: addLocalDays(localDateOf(now, DEMO_TIME_ZONE), -6), quantity: 30 },
      refillsRemaining: 3,
    },
  ];
}

export const DEMO_PREFERENCES: GroceryPreferences = {
  safety: { allergies: ["peanut"], requiredTags: [], preferredTags: ["low_sodium"] },
  preferredBrands: ["Oatfield", "Hearth & Grain"],
  notes: ["Prefers low-sodium groceries", "Prefers oat milk"],
  usualItems: [
    { productId: "p_oat_oatfield", quantity: 2 },
    { productId: "p_bread_ww_ls", quantity: 1 },
    { productId: "p_bananas", quantity: 1 },
    { productId: "p_eggs_dozen", quantity: 1 },
    { productId: "p_yogurt_greek", quantity: 1 },
    { productId: "p_spinach", quantity: 1 },
    { productId: "p_broth_ls", quantity: 2 },
    { productId: "p_beans_ns", quantity: 2 },
    { productId: "p_oats_rolled", quantity: 1 },
    { productId: "p_apples", quantity: 1 },
    { productId: "p_tea_black", quantity: 1 },
  ],
  essentials: [
    { label: "toilet paper", substituteGroup: "toilet_paper", defaultProductId: "p_toilet_paper", quantity: 1 },
    { label: "dish soap", substituteGroup: "dish_soap", defaultProductId: "p_dish_soap", quantity: 1 },
    { label: "paper towels", substituteGroup: "paper_towels", defaultProductId: "p_paper_towels", quantity: 1 },
    { label: "tea", substituteGroup: "tea", defaultProductId: "p_tea_black", quantity: 1 },
  ],
  limits: { perOrderCents: 120_00, weeklyCents: 200_00 },
  deliveryFeeCents: 499,
  demo: true,
};

function pantryItem(id: string, productId: string | null, name: string, quantity: number, unit: string, expiresOn: string | null, now: number): PantryItem {
  const p = productId ? catalogById(productId) : undefined;
  return {
    id,
    name: p?.name ?? name,
    quantity,
    unit,
    expiresOn,
    ingredients: p?.ingredients ?? null,
    allergens: p?.allergens ?? null,
    allergenInfo: p?.allergenInfo ?? "missing",
    tags: p?.tags ?? [],
    productId: p?.id,
    updatedAt: now,
    demo: true,
  };
}

export function demoPantry(now: number): PantryItem[] {
  const today = localDateOf(now, DEMO_TIME_ZONE);
  const d = (n: number) => addLocalDays(today, n);
  return [
    pantryItem("pantry_spinach", "p_spinach", "", 1, "bag", d(1), now),
    pantryItem("pantry_eggs", "p_eggs_6", "", 4, "eggs", d(2), now),
    pantryItem("pantry_broccoli", "p_broccoli", "", 1, "head", d(2), now),
    pantryItem("pantry_swiss", "p_cheese_swiss", "", 6, "slices", d(6), now),
    pantryItem("pantry_salmon", "p_salmon", "", 1, "fillet", d(1), now),
    pantryItem("pantry_potatoes", "p_potatoes", "", 4, "potatoes", d(14), now),
    pantryItem("pantry_lemons", "p_lemons", "", 1, "lemon", d(9), now),
    pantryItem("pantry_beans", "p_beans_ns", "", 1, "can", d(400), now),
    pantryItem("pantry_tomatoes", "p_tomato_ns", "", 2, "cans", d(380), now),
    pantryItem("pantry_broth", "p_broth_ls", "", 1, "carton", d(120), now),
    pantryItem("pantry_rice", "p_rice_brown", "", 1, "bag", d(200), now),
    pantryItem("pantry_penne", "p_pasta_ww", "", 1, "box", d(300), now),
    pantryItem("pantry_olive_oil", "p_olive_oil", "", 1, "bottle", d(250), now),
    pantryItem("pantry_onions", "p_onions", "", 2, "onions", d(20), now),
    pantryItem("pantry_crackers", "p_crackers", "", 1, "box", d(60), now),
    pantryItem("pantry_granola_gift", null, "Homemade granola (gift, no label)", 1, "jar", d(10), now),
    pantryItem("pantry_toilet_paper", "p_toilet_paper", "", 6, "rolls", null, now),
    pantryItem("pantry_paper_towels", "p_paper_towels", "", 2, "rolls", null, now),
  ];
}

/** Seed Care's own records (through Care's scoped repo). Idempotent: skips if a profile exists. */
export async function seedDemoCareData(repo: CareRepo, userId: string, now: number, enteredBy: string) {
  if (await repo.profile(userId)) return false;
  const profile: CareProfile = {
    displayName: "Margaret",
    isDemo: true,
    timeZone: DEMO_TIME_ZONE,
    escalation: DEFAULT_ESCALATION,
    caregiverIds: [DEMO_CAREGIVER.id],
  };
  await repo.put(userId, NS.profile, "profile", profile, "Demo profile: Margaret, 78, lives alone (fictional)");
  await repo.put(userId, NS.groceryPreferences, "preferences", DEMO_PREFERENCES, "Grocery preferences: peanut allergy; prefers low-sodium groceries and oat milk");
  for (const m of demoMedications(now, enteredBy)) await repo.saveMedication(userId, m);
  for (const p of demoPantry(now)) await repo.savePantryItem(userId, p);
  // A few learned memories so the demo's "What Care knows" section shows each status (all fictional).
  for (const f of demoFacts(now)) await repo.put(userId, NS.memory, f.id, f, "Memory (demo)");
  return true;
}

/**
 * Platform-level demo grants (root store, outside any agent): the daughter may view and approve both
 * medication and grocery matters; the neighbor may only view grocery data.
 */
export async function seedDemoPermissions(store: Pick<AgentStore, "setCaregiverPermission">, userId: string) {
  const grants: CaregiverPermission[] = [
    {
      userId,
      caregiverId: DEMO_CAREGIVER.id,
      agentId: "care",
      canViewSummaries: true,
      canApprove: true,
      scopes: ["care:medications", "care:medications:approve", "care:grocery", "care:grocery:approve"],
    },
    { userId, caregiverId: DEMO_LIMITED_CAREGIVER.id, agentId: "care", canViewSummaries: true, canApprove: false, scopes: ["care:grocery"] },
  ];
  for (const g of grants) await store.setCaregiverPermission(g);
}

function demoFacts(now: number): CareFact[] {
  const fact = (id: string, kind: CareFact["kind"], topic: string, value: string, status: CareFact["status"], link?: CareFact["link"]): CareFact => ({
    id,
    kind,
    topic,
    value,
    status,
    safetyCritical: kind === "allergy" || kind === "dietary_restriction" || kind === "caregiver",
    source: { by: "demo-seed", role: "system", via: "demo" },
    link,
    createdAt: now,
    updatedAt: now,
    confirmedAt: status === "confirmed" ? now : undefined,
    history: [{ at: now, change: "created", status, value, by: "demo-seed" }],
  });
  return [
    fact("fact_demo_name", "name", "name", "Margaret", "confirmed"),
    fact("fact_demo_peanut", "allergy", "peanut", "allergic to peanuts", "confirmed", { allergen: "peanut" }),
    fact("fact_demo_sodium", "grocery_preference", "low sodium", "low-sodium groceries", "confirmed", { tag: "low_sodium" }),
    fact("fact_demo_oat", "brand_preference", "milk", "Oatfield", "reported", { brand: "Oatfield" }),
    fact("fact_demo_daughter", "caregiver", "daughter", "Ellen is my daughter", "confirmed"),
  ];
}
