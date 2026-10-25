/**
 * Home repair and household help — pure domain logic (no I/O): service kinds and trade names, intent and emergency
 * detection, deterministic safety steps, arrival windows, validation, and the records kept in `care.homeServices`.
 * Wording rules for replies live in src/agents/guardian/guardianPrompt.ts (HOME_REPAIR_WORDING_RULES).
 */
import { hashValue } from "@/lib/ids";
import { addLocalDays, localDateOf, zonedTimeToUtc } from "./time";

export const SERVICE_KINDS = ["plumbing", "electrical", "handyman", "appliance", "hvac", "tech", "cleaning", "chores"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const SERVICE_LABEL: Record<ServiceKind, string> = {
  plumbing: "Plumbing repair",
  electrical: "Electrical repair",
  handyman: "Handyman repair",
  appliance: "Appliance repair",
  hvac: "Heating and cooling repair",
  tech: "Tech help",
  cleaning: "Home cleaning",
  chores: "Household chores",
};

/** Who comes (used for "Plumber booked" etc.). */
export const TRADE: Record<ServiceKind, string> = {
  plumbing: "Plumber",
  electrical: "Electrician",
  handyman: "Handyman",
  appliance: "Appliance technician",
  hvac: "Heating and cooling technician",
  tech: "Tech helper",
  cleaning: "Cleaner",
  chores: "Home helper",
};
export const bookedTitle = (k: ServiceKind) => `${TRADE[k]} booked`;

/** Older records used "maintenance". */
export function normalizeService(s: string): ServiceKind | null {
  if (s === "maintenance") return "handyman";
  return (SERVICE_KINDS as readonly string[]).includes(s) ? (s as ServiceKind) : null;
}

const INTENT: Array<[ServiceKind, RegExp]> = [
  ["appliance", /\b(fridge|refrigerator|freezer|washer|washing machine|dryer|dishwasher|oven|stove|cooktop|microwave|garbage disposal|appliance\w*)\b/i],
  ["plumbing", /\b(plumb\w*|leak\w*|drip\w*|sink|tap|faucet|toilet|drain\w*|pipe\w*|clog\w*|water heater|shower|bathtub)\b/i],
  ["electrical", /\b(electric\w*|outlet|socket|breaker|fuse|wiring|light switch|sparks?|sparking|power (is )?out|no power|flickering)\b/i],
  ["hvac", /\b(hvac|heat(er|ing)?|furnace|boiler|air ?condition\w*|a\/c|ac unit|thermostat|heat pump|no heat|cooling)\b/i],
  ["tech", /\b(wi-?fi|internet|router|modem|computer|laptop|printer|tablet|ipad|smartphone|phone setup|tv remote|television|smart speaker|tech help|email (is|isn't|won't))\b/i],
  ["cleaning", /\b(clean\w*|tidy\w*|vacuum\w*|mop\w*|dust\w*|deep clean|housekeep\w*|maid)\b/i],
  ["chores", /\b(chores?|laundry|errands?|yard ?work|rake|raking|mow\w*|take out the (trash|bins)|household tasks?)\b/i],
  ["handyman", /\b(handyman|repair\w*|fix\w*|maintenance|gutter\w*|light ?bulb|shelf|shelves|hinge|door|smoke alarm|assembl\w*|install\w*|mount\w*|ceiling)\b/i],
];

/** Natural-language routing: which home service (if any) the person is asking about. */
export function classifyHomeService(text: string): ServiceKind | null {
  for (const [kind, re] of INTENT) if (re.test(text)) return kind;
  return null;
}

export type EmergencyKind = "gas" | "sparks" | "ceiling" | "flooding";
const EMERGENCY: Array<[EmergencyKind, RegExp]> = [
  ["gas", /\b(smell(s|ing)? (of |like )?gas|gas (smell|leak)|rotten eggs?)\b/i],
  ["sparks", /\b(sparks?|sparking|arcing|burning smell|smell(s|ing)? (of )?burning|smoke (is )?coming|electrical fire|outlet (is )?(smoking|melting))\b/i],
  ["ceiling", /\b(ceiling (is )?(sagging|bulging|bowing|cracking|coming down|collaps\w*)|sagging ceiling|bulging ceiling)\b/i],
  ["flooding", /\b(flood\w*|water (is )?(pouring|gushing|rising|everywhere)|burst pipe|pipe (has )?burst)\b/i],
];

export function detectEmergencies(text: string): EmergencyKind[] {
  return EMERGENCY.filter(([, re]) => re.test(text)).map(([k]) => k);
}

/** Emergency guidance. Every line says to get out and call 911 or the utility. Always shown first. */
export const EMERGENCY_STEPS: Record<EmergencyKind, string> = {
  gas: "If you smell gas, get out of the house now. Don't switch lights or appliances on or off. Once you're outside, call 911 or your gas company.",
  sparks: "If you see sparks or smell burning, don't touch anything. Get out and call 911 or your power company.",
  ceiling: "If the ceiling is sagging, get out of that room now and keep others out. Call 911 or your water company if water is pouring through.",
  flooding: "If water is rising fast or reaching outlets, get out and call 911 or your water company. Don't walk through water near anything electrical.",
};

/** Plain first steps per service (from the wording rules in guardianPrompt.ts). */
export const SAFETY_STEPS: Record<ServiceKind, string[]> = {
  plumbing: [
    "If it's safe, turn off the valve under the sink or toilet, or the main water shutoff.",
    "Keep away from outlets and anything electrical near the water.",
    "Move valuables and anything you care about away from the water.",
  ],
  electrical: ["Don't touch the outlet or switch.", "If your hands and the floor are dry, switch that circuit off at the breaker.", "Keep children and pets away from it."],
  appliance: ["If you can reach the plug safely, unplug it.", "If it's leaking, turn off its water valve and keep away from outlets near the water."],
  hvac: ["Switch the system off at the thermostat.", "Keep warm or cool safely in the meantime — blankets, a fan, plenty of water."],
  handyman: ["Keep the area clear so nobody trips or gets hurt."],
  tech: ["Leave it as it is for now, and don't install anything a pop-up asks you to."],
  cleaning: [],
  chores: [],
};

export function safetyFor(kind: ServiceKind, text: string): { emergency: boolean; steps: string[] } {
  const emergencies = detectEmergencies(text);
  // A leak described anywhere gets the leak steps, whatever the service.
  const leak = kind !== "plumbing" && /\b(leak\w*|water)\b/i.test(text) ? SAFETY_STEPS.plumbing : [];
  return { emergency: emergencies.length > 0, steps: [...emergencies.map((e) => EMERGENCY_STEPS[e]), ...SAFETY_STEPS[kind], ...leak] };
}

/** Words that look like health details. Ordinary household requests never need them. */
const MEDICAL = /\b(diagnos\w*|dementia|alzheimer\w*|diabet\w*|insulin|medication\w*|prescri\w*|cancer|chemo\w*|dialysis|seizure\w*|hiv|surgery|blood pressure|heart condition)\b/i;
/** A street address (number + street word). Not collected. */
const STREET = /\b\d{1,6}\s+([a-z0-9.'-]+\s+){0,4}(st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|way|pl|place|terrace|cir|circle|hwy)\b/i;

export function validateRequest(d: { description: string; householdNotes?: string; preferredTiming?: string }): string[] {
  const p: string[] = [];
  if (d.description.trim().length < 3) p.push("Please tell me a little about the problem.");
  const all = `${d.description} ${d.householdNotes ?? ""} ${d.preferredTiming ?? ""}`;
  if (MEDICAL.test(all)) p.push("There's no need to share health details for a repair.");
  if (STREET.test(all)) p.push("There's no need to share your street address here.");
  return p;
}

export interface TimeWindow {
  windowId: string;
  label: string;
  start: number;
  end: number;
}

const SLOTS = [9, 12, 15];
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? " am" : " pm"}`;
const rangeLabel = (h: number) => {
  const a = hourLabel(h);
  const b = hourLabel(h + 2);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
};

function dayLabel(date: string, today: string, timeZone: string) {
  if (date === today) return "Today";
  if (date === addLocalDays(today, 1)) return "Tomorrow";
  const noon = zonedTimeToUtc(date, "12:00", timeZone);
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "short", day: "numeric" }).format(new Date(noon));
}

export function windowFor(windowId: string, now: number, timeZone: string): TimeWindow | null {
  const m = /^win_(\d{4}-\d{2}-\d{2})_(09|12|15)$/.exec(windowId);
  if (!m) return null;
  const hour = Number(m[2]);
  const start = zonedTimeToUtc(m[1], `${m[2]}:00`, timeZone);
  const end = zonedTimeToUtc(m[1], `${String(hour + 2).padStart(2, "0")}:00`, timeZone);
  return { windowId, label: `${dayLabel(m[1], localDateOf(now, timeZone), timeZone)}, ${rangeLabel(hour)}`, start, end };
}

/** The next three two-hour arrival windows at least two hours from now (09–11, 12–2, 3–5 local). */
export function offerTimeWindows(now: number, timeZone: string, count = 3): TimeWindow[] {
  const out: TimeWindow[] = [];
  const today = localDateOf(now, timeZone);
  for (let d = 0; d < 14 && out.length < count; d++) {
    const date = addLocalDays(today, d);
    for (const h of SLOTS) {
      const w = windowFor(`win_${date}_${String(h).padStart(2, "0")}`, now, timeZone)!;
      if (w.start >= now + 2 * 60 * 60_000 && out.length < count) out.push(w);
    }
  }
  return out;
}

/** A window id is acceptable if it's a real slot that starts at least 2 h from now and within 14 days. */
export function acceptableWindow(windowId: string, now: number, timeZone: string): TimeWindow | null {
  const w = windowFor(windowId, now, timeZone);
  if (!w || w.start < now + 2 * 60 * 60_000 || w.start > now + 14 * 24 * 60 * 60_000) return null;
  return w;
}

export type BookingStatus = "booked" | "on_the_way" | "done";
export const STATUS_LABEL: Record<BookingStatus, string> = { booked: "Booked", on_the_way: "On the way", done: "Done" };

/** Status follows the clock: Booked → On the way (30 min before the window) → Done (after the window). */
export function statusAt(window: { start: number; end: number }, now: number): BookingStatus {
  if (now >= window.end) return "done";
  if (now >= window.start - 30 * 60_000) return "on_the_way";
  return "booked";
}

export interface HomeRequest {
  kind: "request";
  id: string;
  version: number;
  service: ServiceKind;
  description: string;
  householdNotes?: string;
  preferredTiming?: string;
  emergency: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface HomeProposal {
  kind: "proposal";
  id: string;
  requestId: string;
  requestVersion: number;
  service: ServiceKind;
  issue: string;
  window: TimeWindow;
  provider: string;
  estimateCents: number | null;
  hash: string;
  status: "proposed" | "approval_requested" | "superseded" | "declined" | "booked";
  approvalId?: string;
  bookingId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HomeBooking {
  kind: "booking";
  id: string;
  proposalId: string;
  service: ServiceKind;
  title: string;
  issue: string;
  provider: string;
  window: TimeWindow;
  reference: string;
  estimateCents: number | null;
  status: BookingStatus;
  history: Array<{ status: BookingStatus; at: number }>;
  createdAt: number;
  updatedAt: number;
}

export const money = (c: number | null) => (c === null ? "Not known yet" : `$${(c / 100).toFixed(2)}`);

export function issueSummary(description: string) {
  const s = description.replace(/\s+/g, " ").trim();
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 120);
}

/** The approval input: every detail shown on the approval card, bound by the proposal hash. */
export function approvalInput(p: HomeProposal) {
  return { proposalId: p.id, proposalHash: p.hash, service: p.service, issue: p.issue, windowId: p.window.windowId, windowLabel: p.window.label, provider: p.provider, estimateCents: p.estimateCents };
}

export function proposalHash(p: Omit<HomeProposal, "hash" | "status" | "approvalId" | "bookingId" | "createdAt" | "updatedAt">) {
  return hashValue({ id: p.id, requestId: p.requestId, version: p.requestVersion, service: p.service, issue: p.issue, windowId: p.window.windowId, start: p.window.start, provider: p.provider, estimateCents: p.estimateCents });
}

/** Approval card summary — what the person is asked to approve (no system talk). */
export function approvalSummary(i: { service: ServiceKind; issue: string; windowLabel: string; provider: string; estimateCents: number | null }) {
  return `${SERVICE_LABEL[i.service]} — ${i.issue} — ${i.windowLabel} — ${i.provider}${i.estimateCents !== null ? ` — estimated ${money(i.estimateCents)}` : ""}`;
}
