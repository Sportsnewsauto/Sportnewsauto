"use client";

import { useCallback, useEffect, useState } from "react";

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
  if (job.status === "cancelled") return "This run was cancelled because the daily episode allowance was reached.";
  return "The run failed. Check your RSS feed and verified API Connections, then try again.";
}

export default function ManualAutomationRun() {
  const [job, setJob] = useState<ManualJob | null>(null);
  const [trialAvailable, setTrialAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/automation/run", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load automation status.");
      setJob(data.job ?? null);
      setTrialAvailable(data.trial_available === true);
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
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start the automation.");
      setJob(data.job);
      setTrialAvailable(false);
      setNotice(data.message || "Your automation run has been queued.");
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the automation.");
    } finally {
      setSubmitting(false);
    }
  }

  const active = job?.status === "queued" || job?.status === "processing";

  return (
    <section className="panel manual-run-panel">
      <div className="panel-heading-row">
        <div>
          <p className="section-kicker">ON-DEMAND PRODUCTION</p>
          <h2>Run automation now</h2>
          <p>Generate an episode immediately without enabling the recurring publishing schedule.</p>
        </div>
        <span className={active ? "pill" : "status"}>{active ? (job?.status === "queued" ? "Queued" : "Generating") : "Manual run"}</span>
      </div>
      <p className="microcopy">
        {trialAvailable
          ? "Your first generated episode is your free trial. Connect your own AI and Spreaker accounts first. This episode counts toward your daily allowance."
          : "Manual runs use your connected RSS feed, AI and Spreaker accounts, and count toward your daily episode allowance."}
      </p>
      {job && <p className="auth-notice" role="status">{statusText(job)}</p>}
      {notice && <p className="auth-notice" role="status">{notice}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="btn btn-primary" onClick={() => void runNow()} disabled={loading || submitting || active}>
        {submitting ? "Starting…" : active ? "Run in progress…" : trialAvailable ? "Start free trial episode" : "Run automation now"}
      </button>
      <p className="microcopy">Requires at least one enabled HTTPS RSS feed, a verified Spreaker show, and a verified Groq or Gemini connection. Your recurring schedule stays unchanged.</p>
    </section>
  );
}
