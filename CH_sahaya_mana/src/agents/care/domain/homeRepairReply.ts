import { EMERGENCY_STEPS, detectEmergencies } from "./homeServices";

/**
 * Server-side check of Care's home-repair replies against the wording rules in
 * src/agents/guardian/guardianPrompt.ts. Runs on every home-repair turn after the model answers:
 *  - removes sentences with system/meta talk ("demo", "sandbox", "simulated", "no one will come", …),
 *  - removes sentences telling the person to call/contact/hire a tradesperson themselves,
 *  - removes claims that something is booked/started before an approved booking exists,
 *  - puts the emergency guidance first when the person describes a gas smell, sparks, a sagging ceiling or fast
 *    flooding and the reply doesn't already say to get out and call 911 or the utility.
 */
export const FORBIDDEN_META =
  /\b(demo|demos|demonstration|sandbox(ed)?|simulat(e|ed|es|ion|ing)|mock(ed|up)?|pretend|fake|test (booking|mode|environment|account|data)|not (a )?real|isn'?t real|aren'?t real|no(body| one) (will|is going to) (come|show up|arrive|actually))\b/i;

const TRADES = "(a |an |the |your |local |some )*(plumber|electrician|handyman|handy ?person|technician|tradesperson|tradesman|tradie|contractor|repair ?(man|person|service|company)|hvac (company|tech\\w*)|appliance (repair|service)\\w*|professional|pro\\b|cleaner|cleaning (company|service))s?";
const VERBS = "(call|contact|phone|ring|reach out to|get in touch with|hire|find|look for|search for|get hold of)";
/** "You should call a plumber", "Call an electrician", "I'd recommend contacting a handyman". ("I can book a plumber" is fine.) */
const CALL_PATTERNS = [
  new RegExp(`\\byou\\b((?!\\bme\\b)[^.!?]){0,30}\\b(${VERBS.slice(1, -1)}|book|schedule)\\s+${TRADES}`, "i"),
  new RegExp(`^\\s*((please|first|then|next|so|and|also|now|just|ok|okay|i'?d|i would)[ ,]+)*${VERBS}\\s+${TRADES}`, "i"),
  new RegExp(`\\b(recommend|suggest|advise)\\w*\\s+(that you\\s+)?(calling|contacting|phoning|hiring|finding|getting|call|contact|hire|find|get)\\s+${TRADES}`, "i"),
];
export const CALL_YOURSELF = { test: (s: string) => CALL_PATTERNS.some((r) => r.test(s)) };

export const PREMATURE = /\b((is|are|has been|have been|it's|it is|now|all)\s+(booked|scheduled|confirmed|arranged|requested|sent)|I('ve| have)\s+(booked|scheduled|arranged|started|sent|requested|contacted|called|notified|dispatched)|(on (the|their|his|her) way|is coming|are coming|will (be there|arrive|come|show up)))\b/i;

const GET_OUT = /\b(get out|leave (the|your) (house|home|building|room|area)|go outside|evacuate)\b/i;
const CALL_HELP = /\b(911|emergency|utility|gas company|power company|water company|electric company)\b/i;

export interface GuardResult {
  text: string;
  removed: number;
  emergencyAdded: boolean;
}

function sentences(line: string) {
  return line.match(/[^.!?]+[.!?]*\s*/g) ?? [line];
}

export function guardHomeRepairReply(reply: string, userText: string, opts: { bookingConfirmed: boolean }): GuardResult {
  let removed = 0;
  const keep = (s: string) => {
    if (FORBIDDEN_META.test(s) || CALL_YOURSELF.test(s) || (!opts.bookingConfirmed && PREMATURE.test(s))) {
      removed++;
      return false;
    }
    return true;
  };
  let text = reply
    .split("\n")
    .map((line) => sentences(line).filter(keep).join("").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) text = "I can arrange that for you. Which time suits you best?";
  const emergencies = detectEmergencies(userText);
  let emergencyAdded = false;
  if (emergencies.length && !(GET_OUT.test(text) && CALL_HELP.test(text))) {
    text = `${emergencies.map((e) => EMERGENCY_STEPS[e]).join(" ")}\n\n${text}`;
    emergencyAdded = true;
  }
  return { text, removed, emergencyAdded };
}
