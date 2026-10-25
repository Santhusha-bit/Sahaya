import { z } from "zod";
import type { CrsSubject } from "@/integrations/crs";

/**
 * CRS test identities Finance is allowed to use.
 *
 * Sahaya never sends a real person's identity to CRS. The account holder is
 * linked to one CRS sandbox persona (CRS_LINKED_PERSONA, default P13), and every
 * request is built from that persona's fixed fields, never from model or user text.
 *
 * Built-in: P13, whose fields appear in recorded CRS Cal Hacks sandbox responses.
 * More personas from the CRS-provided Postman collection (P01..P20) can be added
 * without code changes via CRS_TEST_PERSONAS (a JSON object keyed by persona id).
 */

export interface CrsTestIdentity extends CrsSubject {
  label: string;
  source: "built-in" | "env";
}

/** SSA never issues SSNs in the 666 area, which is why CRS test personas use it. */
export function isSandboxTestSsn(ssn: string): boolean {
  return /^666\d{6}$/.test(ssn);
}

const BUILT_IN: Record<string, CrsTestIdentity> = {
  P13: {
    personaId: "P13",
    label: "CRS sandbox persona P13",
    firstName: "KAYLA",
    middleName: "D",
    lastName: "BRENNAN",
    ssn: "666701013",
    birthDate: "1999-12-24",
    email: "kb.9921x@example.com",
    address: { addressLine1: "9021 KINGSTON PIKE", city: "KNOXVILLE", state: "TN", postalCode: "37923" },
    source: "built-in",
  },
};

const envPersona = z.object({
  firstName: z.string().min(1),
  middleName: z.string().optional(),
  lastName: z.string().min(1),
  ssn: z.string().refine(isSandboxTestSsn, "must be a CRS test SSN (666xxxxxx)"),
  birthDate: z.string().optional(),
  email: z.string().optional(),
  phoneNumber: z.string().optional(),
  address: z.object({
    addressLine1: z.string().min(1),
    city: z.string().min(1),
    state: z.string().length(2),
    postalCode: z.string().min(5),
  }),
});

/** All allowlisted test identities. Invalid env entries are skipped, never trusted. */
export function testIdentities(): Record<string, CrsTestIdentity> {
  const out: Record<string, CrsTestIdentity> = { ...BUILT_IN };
  const raw = process.env.CRS_TEST_PERSONAS?.trim();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [personaId, value] of Object.entries(parsed)) {
      if (!/^P\d{2}$/.test(personaId)) continue;
      const r = envPersona.safeParse(value);
      if (r.success) out[personaId] = { ...r.data, personaId, label: `CRS sandbox persona ${personaId}`, source: "env" };
    }
  } catch {
    // Malformed JSON: fall back to the built-in allowlist.
  }
  return out;
}

export function findTestIdentity(personaId: string): CrsTestIdentity | undefined {
  return testIdentities()[personaId];
}

/** The persona linked to the Sahaya account holder. */
export function linkedPersonaId(): string {
  return process.env.CRS_LINKED_PERSONA?.trim() || "P13";
}
