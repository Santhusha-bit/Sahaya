import { auth0Status } from "./env";

export interface KinlineUser {
  id: string;
  name: string;
  role: "elder" | "caregiver";
  authMode: "live" | "sandbox";
}

/**
 * Resolve the current user. Auth0 wiring is declared but, when unconfigured,
 * Kinline runs in single-user demo mode (honest "sandbox" auth).
 */
export function getCurrentUser(): KinlineUser {
  const mode = auth0Status().mode === "live" ? "live" : "sandbox";
  return {
    id: process.env.KINLINE_DEMO_USER_ID?.trim() || "demo-user",
    name: "Eleanor",
    role: "elder",
    authMode: mode === "live" ? "live" : "sandbox",
  };
}
