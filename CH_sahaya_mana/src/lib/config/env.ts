/**
 * App settings use the SAHAYA_* names. The app was previously called Kinline, so the old KINLINE_* names are still
 * read as a DEPRECATED fallback: SAHAYA_<NAME> wins whenever it is defined (even as an empty string, so a caller
 * can switch a legacy setting off); otherwise KINLINE_<NAME> is used. Rename your env lines; the fallback will go.
 */
export type EnvLike = Partial<Record<string, string | undefined>>;

export const LEGACY_PREFIX = "KINLINE_";

/** The value of SAHAYA_<name>, or the deprecated KINLINE_<name> when SAHAYA_<name> isn't defined. */
export function appEnv(env: EnvLike, name: string): string | undefined {
  const current = env[`SAHAYA_${name}`];
  return current !== undefined ? current : env[`${LEGACY_PREFIX}${name}`];
}

/** Deprecated KINLINE_* names present in this environment (names only, never values). */
export function legacyEnvNames(env: EnvLike): string[] {
  return Object.keys(env).filter((k) => k.startsWith(LEGACY_PREFIX) && env[k] !== undefined);
}
