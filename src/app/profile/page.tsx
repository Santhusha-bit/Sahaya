"use client";

import { useEffect, useState } from "react";
import type { IntegrationStatus } from "@/lib/env";
import { BrandLogo } from "@/components/BrandLogo";

interface StatusResponse {
  user: { name: string; role: string; authMode: string };
  backend: string;
  integrations: IntegrationStatus[];
}

const MODE_STYLE: Record<string, { bg: string; color: string }> = {
  live: { bg: "#d1fae5", color: "#065f46" },
  sandbox: { bg: "#fef3c7", color: "#92400e" },
  unavailable: { bg: "#fee2e2", color: "#991b1b" },
};

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

export default function ProfilePage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  // null = still reading localStorage, then true/false.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState(DEMO_USER.email);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setSignedIn(window.localStorage.getItem(AUTH_KEY) === "1");
  }, []);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

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
          {DEMO_USER.name.charAt(0)}
        </div>
        <div className="relative">
          <div className="text-[20px] font-extrabold tracking-tight">{DEMO_USER.name}</div>
          <div className="mt-0.5 text-[13px] text-white/85">{DEMO_USER.email}</div>
          <div className="mt-0.5 text-[13px] capitalize text-white/85">
            {DEMO_USER.role} · member since {DEMO_USER.memberSince}
          </div>
        </div>
      </div>

      <h2 className="eyebrow mt-7">Account</h2>
      <section className="mt-3 flex flex-col gap-2.5">
        <div className="card flex items-center gap-2 p-3.5">
          <span className="text-[15px]">📧</span>
          <div className="text-[14px] font-medium">Email</div>
          <div className="ml-auto text-[14px] text-[var(--muted)]">{DEMO_USER.email}</div>
        </div>
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
      </section>

      <h2 className="eyebrow mt-7">Integrations</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--muted)]">
        Honest status of every external service (prompt acceptance criterion 12).
      </p>
      <section className="mt-3 flex flex-col gap-2.5">
        {status?.integrations.map((i, idx) => {
          const s = MODE_STYLE[i.mode];
          return (
            <div key={i.key} className={`card fade-up stagger-${Math.min(idx + 1, 4)} p-3.5`}>
              <div className="flex items-center gap-2">
                <BrandLogo brandKey={i.key} label={i.label} />
                <div className="text-[15px] font-bold tracking-tight">{i.label}</div>
                <span className="pill ml-auto px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide" style={{ background: s.bg, color: s.color }}>
                  {i.mode}
                </span>
              </div>
              <div className="mt-1 text-[13px] leading-snug text-[var(--muted)]">{i.detail}</div>
            </div>
          );
        })}
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
