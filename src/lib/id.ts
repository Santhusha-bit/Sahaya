/** Small id + time helpers used across the agent runtime. */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function id(prefix = ""): string {
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return prefix ? `${prefix}_${out}` : out;
}

export function now(): number {
  return Date.now();
}

export function correlationId(): string {
  return id("corr");
}
