import { connection } from "next/server";
import { localModeEnabled } from "@/lib/auth/identity";

/**
 * Always-visible notices so the app can't be mistaken for something it isn't:
 *  - explicit local test mode (no sign-in);
 *
 * The signed-in "Testing version — not approved for real health information" banner is hidden at the owner's request
 * (presentation only). Real health data is still NOT approved: SAHAYA_REAL_HEALTH_DATA stays unset, and nothing in
 * auth, storage, privacy or medication safeguards depends on this banner.
 */
export async function LocalModeBanner() {
  await connection();
  if (localModeEnabled(process.env)) {
    return (
      <p role="note" className="bg-[#fdf3dc] px-5 py-2 text-center text-base font-bold text-warn">
        Local test mode — no sign-in. Don&apos;t enter real health information.
      </p>
    );
  }
  return null;
}
