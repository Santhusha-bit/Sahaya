/**
 * Time-zone helpers for medication schedules. Prescriptions are written in local wall-clock time
 * ("08:00 every morning"), so every dose is computed from (local date, HH:MM, IANA zone) using the
 * platform's tz database. No fixed UTC offsets are ever stored.
 *
 * DST rules (documented and tested):
 *  - Spring forward: a wall time that does not exist that day (e.g. 02:30) moves forward by the gap (03:30).
 *  - Fall back: a wall time that happens twice that day (e.g. 01:30) uses the first occurrence.
 */

const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function wallParts(ts: number, timeZone: string): WallParts {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset of the zone from UTC at an instant, in ms (e.g. -7h for PDT). */
export function zoneOffsetMs(ts: number, timeZone: string): number {
  const p = wallParts(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

export function parseLocalDate(date: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`invalid local date "${date}"`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function parseClockTime(time: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new Error(`invalid time "${time}"`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** The UTC instant of a local wall-clock time in a zone, with the DST rules above. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): number {
  const { year, month, day } = parseLocalDate(date);
  const { hour, minute } = parseClockTime(time);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Candidate instants using the offsets in effect a day before and after (covers any transition).
  const offsets = new Set([zoneOffsetMs(wallAsUtc - DAY, timeZone), zoneOffsetMs(wallAsUtc + DAY, timeZone)]);
  const matches = [...offsets]
    .map((off) => wallAsUtc - off)
    .filter((ts) => {
      const p = wallParts(ts, timeZone);
      return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
    })
    .sort((a, b) => a - b);
  if (matches.length) return matches[0]; // fall back: first occurrence
  // Nonexistent (spring forward): interpret with the pre-transition offset, which lands after the gap.
  const before = zoneOffsetMs(wallAsUtc - DAY, timeZone);
  return wallAsUtc - before;
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDateOf(ts: number, timeZone: string): string {
  const p = wallParts(ts, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Local wall time (HH:MM) of an instant in a zone. */
export function localTimeOf(ts: number, timeZone: string): string {
  const p = wallParts(ts, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Add calendar days to a local date string (pure calendar arithmetic, zone-independent). */
export function addLocalDays(date: string, days: number): string {
  const { year, month, day } = parseLocalDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return d.toISOString().slice(0, 10);
}

/** Human-friendly local time for messages, e.g. "8:00 AM". */
export function friendlyTime(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(ts));
}

export function friendlyDateTime(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}

/**
 * Controllable clock for demos and tests. In sandbox/demo mode the runtime's `now()` reads this,
 * so reminders, follow-ups, refill and delivery transitions can be shown in seconds. It is always
 * labelled as a simulated clock in the UI and demo output.
 */
export class DemoClock {
  private offsetMs = 0;
  private fixed: number | null;

  constructor(start?: number, private readonly base: () => number = Date.now) {
    this.fixed = start ?? null;
  }

  now = (): number => (this.fixed ?? this.base()) + this.offsetMs;

  advance(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("the demo clock only moves forward");
    this.offsetMs += ms;
    return this.now();
  }

  advanceMinutes(minutes: number) {
    return this.advance(minutes * MINUTE);
  }

  /** How far the simulated clock is ahead of its starting point. */
  get simulatedOffsetMs() {
    return this.offsetMs;
  }

  get isFixed() {
    return this.fixed !== null;
  }

  set(ts: number) {
    if (this.fixed === null) throw new Error("only a fixed demo clock can be set");
    if (ts < this.now()) throw new Error("the demo clock only moves forward");
    this.fixed = ts;
    this.offsetMs = 0;
  }
}

export const minutes = (n: number) => n * MINUTE;
