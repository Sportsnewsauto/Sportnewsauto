"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = "login" | "signup";

export default function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const supabase = createClient();
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          setMessage("Account created. Check your email for the confirmation link, then sign in.");
        } else {
          router.replace("/dashboard");
          router.refresh();
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const next = params.get("next");
        router.replace(next && next.startsWith("/") ? next : "/dashboard");
        router.refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <Link href="/" className="brand"><span className="brand-mark">◉</span><span>Automate Spreaker Podcast</span></Link>
        <span className="eyebrow">{mode === "signup" ? "CREATE YOUR WORKSPACE" : "WELCOME BACK"}</span>
        <h1>{mode === "signup" ? "Create your account" : "Sign in"}</h1>
        <p className="auth-description">{mode === "signup" ? "Start with your private podcast workspace. The free plan includes one episode per day." : "Sign in to manage your podcast workspace."}</p>
        {params.get("setup") === "supabase" && <p className="auth-notice">The website owner needs to finish Supabase setup before dashboard access is available.</p>}
        <form onSubmit={submit} className="auth-form">
          <label htmlFor="email">Email address</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} required value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" />
          {error && <p className="auth-error" role="alert">{error}</p>}
          {message && <p className="auth-notice" role="status">{message}</p>}
          <button className="btn btn-primary auth-submit" disabled={busy}>{busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}</button>
        </form>
        <p className="auth-switch">{mode === "signup" ? "Already have an account?" : "New to Automate Spreaker Podcast?"}{" "}<Link href={mode === "signup" ? "/login" : "/signup"}>{mode === "signup" ? "Sign in" : "Create an account"}</Link></p>
        <p className="microcopy">Your account is private. Never share your API keys or passwords with anyone.</p>
      </section>
    </main>
  );
}
