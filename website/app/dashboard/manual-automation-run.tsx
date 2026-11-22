"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type ManualJob = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  created_at?: string;
  updated_at?: string;
  free_trial?: boolean;
};

function statusText(job: ManualJob | null): string {
  if (!job) return "";
  if (job.status === "queued") return "Queued — the worker will pick it up shortly.";
  if (job.status === "processing") return "Your episode is being generated and prepared for Spreaker.";
  if (job.status === "completed") return "Your episode has been generated. Open Episodes to review or listen.";
  if (job.status === "cancelled") return "This run was cancelled because an allowance was reached.";
  return "The run failed. Check your RSS feed and verified API Connections, then try again.";
}

export default function ManualAutomationRun() {
  const [job, setJob] = useState<ManualJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [wakingWorker, setWakingWorker] = useState(false);
  const [isPaid, setIsPaid] = useState(false);
  const [manualRunsUsed, setManualRunsUsed] = useState(0);
  const [manualRunsRemaining, setManualRunsRemaining] = useState<number | null>(3);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/automation/run", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load automation status.");
      setJob(data.job ?? null);
      setIsPaid(data.is_paid === true);
      setManualRunsUsed(Number(data.manual_runs_used) || 0);
      setManualRunsRemaining(typeof data.manual_runs_remaining === "number" ? data.manual_runs_remaining : null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load automation status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!job || !["queued", "processing"].includes(job.status)) return;
    const timer = window.setInterval(() => { void refresh(); }, 10000);
    return () => window.clearInterval(timer);
  }, [job, refresh]);

  async function runNow() {
    setSubmitting(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start the automation.");
      setJob(data.job);
      setNotice(data.message || "Your automation run has been queued.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the automation.");
    } finally {
      setSubmitting(false);
    }
  }

  async function wakeWorkerNow() {
    setWakingWorker(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/automation/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not trigger the worker.");
      setNotice(data.message || "Worker triggered to check your existing job.");
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not trigger the worker.");
    } finally {
      setWakingWorker(false);
    }
  }

  const active = job?.status === "queued" || job?.status === "processing";
  const freeRunsExhausted = !isPaid && manualRunsRemaining === 0;

  return (
    <section className="panel manual-run-panel">
      <div className="panel-heading-row">
        <div><p className="section-kicker">ON-DEMAND PRODUCTION</p><h2>Run automation now</h2><p>Generate an episode immediately without enabling a recurring schedule.</p></div>
        <span className={active ? "pill" : "status"}>{active ? (job?.status === "queued" ? "Queued" : "Generating") : "Manual run"}</span>
      </div>
      <p className="microcopy">
        {isPaid
          ? "Manual runs count towards the paid plan's daily and rolling 30-day episode allowances."
          : `Free plan: ${manualRunsRemaining ?? 0} of 3 lifetime manual runs remaining. Each accepted manual run uses one of your three free runs.`}
      </p>
      <p className="microcopy">{isPaid ? `${manualRunsUsed} manual runs submitted on this account.` : `${manualRunsUsed} of 3 free manual runs used.`}</p>
      {job && <p className="auth-notice" role="status">{statusText(job)}</p>}
      {notice && <p className="auth-notice" role="status">{notice}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      {freeRunsExhausted ? (
        <div><p className="auth-error">You have used all three free manual runs. Upgrade to continue generating episodes.</p><Link className="btn btn-primary" href="/dashboard/subscription">Upgrade your plan</Link></div>
      ) : (
        <button className="btn btn-primary" onClick={() => void runNow()} disabled={loading || submitting || active}>
          {submitting ? "Starting…" : active ? "Run in progress…" : isPaid ? "Run automation now" : "Use one free manual run"}
        </button>
      )}
      {active && <button type="button" className="btn" onClick={() => void wakeWorkerNow()} disabled={loading || submitting || wakingWorker}>
        {wakingWorker ? "Waking worker…" : "Wake worker now"}
      </button>}
      <p className="microcopy">Requires at least one enabled HTTPS RSS feed, verified Spreaker, and a verified Groq or Gemini connection. Scheduled automation is available on paid subscriptions.</p>
    </section>
  );
}
