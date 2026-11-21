"use client";

import { useState } from "react";

type ImportResult = {
  feeds: number;
  ad_positions: number;
  previous_episodes: number;
  already_present_episodes: number;
  scheduled_times: string[];
  timezone: string;
};

export default function LegacyAutomationImport() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dailyLimit, setDailyLimit] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function importAutomation() {
    const confirmed = window.confirm(
      "Copy your previous sports automation into THIS signed-in workspace? This imports 49 sports feeds, the eight daily times, four advertising markers and the old episode history. It does not copy any Spreaker, Groq or Gemini secrets. The new schedule will remain paused until you reconnect your own accounts."
    );
    if (!confirmed) return;

    setBusy(true);
    setError("");
    setNotice("");
    setResult(null);
    try {
      const response = await fetch("/api/automation/import-legacy", {
        method: "POST",
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not import the previous automation.");
      setResult(data.imported);
      setDailyLimit(Number(data.daily_episode_limit ?? 1));
      setNotice(data.message || "Your previous automation was imported.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import the previous automation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading-row">
        <div>
          <h2>Move your existing sports automation here</h2>
          <p>Copy the sports feeds, publishing schedule, advertising markers and previous episode history from the old GitHub automation into this signed-in workspace.</p>
        </div>
      </div>
      <p className="microcopy">This imports configuration and history only. Your old Spreaker, Groq and Gemini credentials are not copied. The new schedule stays paused until you connect this account's own credentials and enable it.</p>
      <button className="btn btn-primary" onClick={() => void importAutomation()} disabled={busy}>
        {busy ? "Importing your automation…" : "Move existing sports automation into this account"}
      </button>
      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p className="auth-notice" role="status">{notice}</p>}
      {result && (
        <div className="connection" style={{ marginTop: 12 }}>
          <div>
            <strong>Import complete</strong>
            <p className="microcopy">
              {result.feeds} feeds · {result.ad_positions} ad positions · {result.previous_episodes} previous episodes copied · {result.already_present_episodes} already present
            </p>
            <p className="microcopy">Schedule: {result.scheduled_times.join(" · ")} ({result.timezone}). Your current daily plan limit is {dailyLimit} episode{dailyLimit === 1 ? "" : "s"} per day.</p>
          </div>
          <span className="status">Imported</span>
        </div>
      )}
    </section>
  );
}
