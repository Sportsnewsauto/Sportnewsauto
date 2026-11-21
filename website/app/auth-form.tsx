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

  async function resendConfirmation() {
    if (!email.trim()) {
      setError("Enter your email address first.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      setMessage("A new confirmation email has been requested. Check your inbox and use the newest email.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not resend the confirmation email. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function requestPasswordReset() {
    if (!email.trim()) {
      setError("Enter your account email address first.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });
      if (error) throw error;
      setMessage("If an account exists for that email, a password reset link has been sent. Check your inbox and spam folder.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send a password reset email. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const supabase = createClient();
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/auth/callback` } });
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
        {params.get("reset") === "success" && <p className="auth-notice">Your password has been updated. Sign in with your new password.</p>}
        <form onSubmit={submit} className="auth-form">
          <label htmlFor="email">Email address</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} required value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" />
          {mode === "login" && (
            <button type="button" className="auth-forgot" onClick={requestPasswordReset} disabled={busy}>
              Forgot password?
            </button>
          )}
          {error && <p className="auth-error" role="alert">{error}</p>}
          {message && <p className="auth-notice" role="status">{message}</p>}
          <button className="btn btn-primary auth-submit" disabled={busy}>{busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}</button>
          {mode === "signup" && (
            <button type="button" className="btn btn-outline auth-submit" onClick={resendConfirmation} disabled={busy}>
              {busy ? "Please wait…" : "Resend confirmation email"}
            </button>
          )}
        </form>
        <p className="auth-switch">{mode === "signup" ? "Already have an account?" : "New to Automate Spreaker Podcast?"}{" "}<Link href={mode === "signup" ? "/login" : "/signup"}>{mode === "signup" ? "Sign in" : "Create an account"}</Link></p>
        <p className="microcopy">Your account is private. Never share your API keys or passwords with anyone.</p>
      </section>
    </main>
  );
}
