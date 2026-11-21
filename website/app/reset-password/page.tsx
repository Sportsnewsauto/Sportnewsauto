"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");

    if (password.length < 8) {
      setError("Your new password must be at least 8 characters long.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        throw new Error("This password reset link is invalid or has expired. Please request a new one.");
      }

      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;

      await supabase.auth.signOut();
      setPassword("");
      setConfirmPassword("");
      setMessage("Your password has been changed. You can now sign in with your new password.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update your password. Please request a new reset link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <Link href="/" className="brand"><span className="brand-mark">◉</span><span>Automate Spreaker Podcast</span></Link>
        <span className="eyebrow">ACCOUNT RECOVERY</span>
        <h1>Choose a new password</h1>
        <p className="auth-description">Enter your new password below. Use at least 8 characters.</p>
        <form onSubmit={submit} className="auth-form">
          <label htmlFor="new-password">New password</label>
          <input id="new-password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" />
          <label htmlFor="confirm-password">Confirm new password</label>
          <input id="confirm-password" type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Enter the password again" />
          {error && <p className="auth-error" role="alert">{error}</p>}
          {message && <p className="auth-notice" role="status">{message}</p>}
          {!message && <button className="btn btn-primary auth-submit" disabled={busy}>{busy ? "Updating password…" : "Update password"}</button>}
        </form>
        <p className="auth-switch"><Link href="/login">Back to sign in</Link></p>
      </section>
    </main>
  );
}
