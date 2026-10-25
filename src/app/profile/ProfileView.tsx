"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/** Dummy profile used for the demo sign-in flow (no real backend). */
const DEMO_USER = {
  name: "Eleanor Hartwell",
  email: "eleanor@sahaya.app",
  password: "sahaya123",
  role: "Elder",
  phone: "+1 (415) 555-0142",
  location: "San Francisco, CA",
  memberSince: "March 2024",
};

const AUTH_KEY = "sahaya-demo-auth";

/** The signed-in Auth0 user; absent in sandbox (demo) mode. */
export interface LiveProfileUser {
  name: string;
  email: string;
  role: string;
}

export function ProfileView({ liveUser }: { liveUser?: LiveProfileUser }) {
  // null = still reading localStorage, then true/false. Auth0 users are always signed in here.
  const [signedIn, setSignedIn] = useState<boolean | null>(liveUser ? true : null);
  const [email, setEmail] = useState(DEMO_USER.email);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const profile = liveUser ?? DEMO_USER;

  useEffect(() => {
    if (!liveUser) setSignedIn(window.localStorage.getItem(AUTH_KEY) === "1");
  }, [liveUser]);

  function signIn(e: React.FormEvent) {
    e.preventDefault();
    const okEmail = email.trim().toLowerCase() === DEMO_USER.email.toLowerCase();
    const okPassword = password === DEMO_USER.password;
    if (okEmail && okPassword) {
      window.localStorage.setItem(AUTH_KEY, "1");
      setSignedIn(true);
      setError("");
      setPassword("");
    } else {
      setError("Incorrect email or password. Try the demo hint below.");
    }
  }

  function logOut() {
    if (liveUser) {
      // Clears the Auth0 session and returns through Auth0's logout endpoint.
      window.location.assign("/auth/logout");
      return;
    }
    window.localStorage.removeItem(AUTH_KEY);
    setSignedIn(false);
    setEmail(DEMO_USER.email);
    setPassword("");
  }

  // Avoid a flash of the wrong view while we read localStorage.
  if (signedIn === null) {
    return <main className="px-5 pt-8" />;
  }

  if (!signedIn) {
    return (
      <main className="px-5 pt-8">
        <h1 className="text-[28px] font-extrabold tracking-tight">Welcome back</h1>
        <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--muted)]">
          Sign in to your Sahaya account to continue.
        </p>

        <form onSubmit={signIn} className="card fade-up mt-6 flex flex-col gap-4 p-5">
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-2.5 text-[15px] outline-none focus:border-[var(--brand)]"
              placeholder="you@example.com"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-2.5 text-[15px] outline-none focus:border-[var(--brand)]"
              placeholder="••••••••"
            />
          </label>

          {error && <div className="text-[13px] font-medium text-red-600">{error}</div>}

          <button
            type="submit"
            className="btn mt-1 rounded-xl py-3 text-[15px] font-bold text-white"
            style={{ background: "var(--brand-grad)", boxShadow: "var(--shadow-brand)" }}
          >
            Sign in
          </button>

          <div className="rounded-xl bg-[var(--brand-soft)] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[var(--muted)]">
            <span className="font-semibold text-[var(--brand-ink)]">Demo login</span> — email{" "}
            <span className="font-mono">{DEMO_USER.email}</span>, password{" "}
            <span className="font-mono">{DEMO_USER.password}</span>
          </div>
        </form>
      </main>
    );
  }

  return (
    <main className="px-5 pt-8">
      <h1 className="text-[28px] font-extrabold tracking-tight">Profile</h1>

      <div
        className="fade-up relative mt-5 flex items-center gap-4 overflow-hidden rounded-[24px] p-5 text-white"
        style={{ background: "var(--brand-grad)", boxShadow: "var(--shadow-lg)" }}
      >
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-12 h-36 w-36 rounded-full bg-white/15 blur-2xl" />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-white/20 text-[26px] font-extrabold backdrop-blur">
          {profile.name.charAt(0)}
        </div>
        <div className="relative">
          <div className="text-[20px] font-extrabold tracking-tight">{profile.name}</div>
          <div className="mt-0.5 text-[13px] text-white/85">{profile.email}</div>
          <div className="mt-0.5 text-[13px] capitalize text-white/85">
            {liveUser ? `${liveUser.role} · signed in with Auth0` : `${DEMO_USER.role} · member since ${DEMO_USER.memberSince}`}
          </div>
        </div>
      </div>

      <h2 className="eyebrow mt-7">Account</h2>
      <section className="mt-3 flex flex-col gap-2.5">
        <div className="card flex items-center gap-2 p-3.5">
          <span className="text-[15px]">📧</span>
          <div className="text-[14px] font-medium">Email</div>
          <div className="ml-auto text-[14px] text-[var(--muted)]">{profile.email}</div>
        </div>
        {!liveUser && (
        <>
        <div className="card flex items-center gap-2 p-3.5">
          <span className="text-[15px]">📞</span>
          <div className="text-[14px] font-medium">Phone</div>
          <div className="ml-auto text-[14px] text-[var(--muted)]">{DEMO_USER.phone}</div>
        </div>
        <div className="card flex items-center gap-2 p-3.5">
          <span className="text-[15px]">📍</span>
          <div className="text-[14px] font-medium">Location</div>
          <div className="ml-auto text-[14px] text-[var(--muted)]">{DEMO_USER.location}</div>
        </div>
        </>
        )}
      </section>

      <h2 className="eyebrow mt-7">System</h2>
      <section className="mt-3 flex flex-col gap-2.5">
        <Link href="/dashboard" className="card card-interactive flex items-center gap-2 p-3.5">
          <span className="text-[15px]">🩺</span>
          <div>
            <div className="text-[14px] font-bold tracking-tight">Service status</div>
            <div className="text-[12.5px] leading-snug text-[var(--muted)]">Live health of every integration</div>
          </div>
          <span className="ml-auto text-[18px] text-[var(--faint)]">›</span>
        </Link>
      </section>

      <div className="card mt-6 overflow-hidden p-5">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--brand-soft)] text-[18px]">📲</span>
          <div className="text-[15px] font-bold tracking-tight">Install Sahaya</div>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">
          This is an installable app. In your browser&apos;s menu, choose &ldquo;Add to Home Screen&rdquo; / &ldquo;Install Sahaya&rdquo;
          to use it full-screen like a native app — it works offline for the shell.
        </p>
      </div>

      <button
        onClick={logOut}
        className="btn mt-6 w-full rounded-xl border border-[var(--line)] bg-white py-3 text-[15px] font-bold text-red-600"
      >
        Log out
      </button>

      <p className="mt-6 text-center text-[12px] text-[var(--faint)]">
        Sahaya · four independent agents, one companion app.
      </p>
    </main>
  );
}
