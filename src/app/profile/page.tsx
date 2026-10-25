import { getCurrentUser } from "@/lib/user";
import { ProfileView } from "./ProfileView";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const user = await getCurrentUser();
  // Live Auth0: show the signed-in person. Sandbox: the demo sign-in flow.
  const liveUser =
    user.authMode === "live" ? { name: user.name, email: user.email ?? "", role: user.role } : undefined;
  return <ProfileView liveUser={liveUser} />;
}
