"use client";

import { useCallback, useEffect, useState } from "react";

type BillingStatus = {
  plan: "free" | "pro" | "admin";
  is_paid: boolean;
  subscription_interval: "monthly" | "yearly" | null;
  subscription_expires_at: string | null;
  days_remaining: number | null;
  mpesa_ready: boolean;
  pending_payment: { id: string; plan_interval: string; amount_ksh: number; created_at: string } | null;
  usage: {
    feeds: number; feeds_limit: number | null;
    manual_runs_used: number; manual_runs_limit: number | null; manual_runs_remaining: number | null;
    episodes_last_30_days: number; episodes_30_day_limit: number | null;
    episodes_today: number; episodes_daily_limit: number | null;
  };
};

export default function SubscriptionManager() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    try {
      const response = await fetch("/api/billing/status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load your subscription.");
      setStatus(data);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your subscription.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function startPayment(interval: "monthly" | "yearly") {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/billing/mpesa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval, phone }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start M-Pesa checkout.");
      setNotice(data.message || "M-Pesa payment prompt requested. Check your phone.");
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start M-Pesa checkout.");
    } finally {
      setBusy(false);
    }
  }

  if (!status && !error) {
    return <section className="dash-main"><p>Loading subscription…</p></section>;
  }

  const planTitle = status?.plan === "admin"
    ? "Admin"
    : status?.is_paid
      ? status.subscription_interval === "yearly" ? "Yearly" : "Monthly"
      : "Free";
  const expiry = status?.subscription_expires_at
    ? new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeZone: "Africa/Nairobi" }).format(new Date(status.subscription_expires_at))
    : null;

  return (
    <section className="dash-main">
      <div className="dash-top">
        <div><p className="section-kicker">ACCOUNT</p><h1>Subscription</h1><p>Manage your Podcasti plan, usage and renewal.</p></div>
        <span className="status">Current plan</span>
      </div>

      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p className="auth-notice" role="status">{notice}</p>}

      {status && <>
        <div className="panel subscription-panel">
          <div className="panel-heading-row">
            <div><p className="section-kicker">YOUR PLAN</p><h2>{planTitle} plan</h2></div>
            {status.plan === "admin" ? <span className="status">Platform Admin</span> : status.is_paid ? <span className="status">Active</span> : <span className="pill">Free plan</span>}
          </div>
          {status.is_paid && status.plan !== "admin" ? (
            <p>Renews by customer payment. Your current subscription expires on <strong>{expiry}</strong>{status.days_remaining !== null ? ` ( ${status.days_remaining} days remaining )` : ""}.</p>
          ) : status.plan === "admin" ? (
            <p>The platform Admin workspace is not billed through customer subscriptions.</p>
          ) : (
            <p>Free access includes three manual runs in total. Upgrade to enable automatic schedules and higher usage limits.</p>
          )}
          <div className="billing-usage-grid">
            <div><span>Manual runs</span><strong>{status.usage.manual_runs_limit === null ? "Paid access" : `${status.usage.manual_runs_used} / 3 used`}</strong></div>
            <div><span>RSS feeds</span><strong>{status.usage.feeds}{status.usage.feeds_limit === null ? " / Unlimited" : ` / ${status.usage.feeds_limit}`}</strong></div>
            <div><span>Episodes today</span><strong>{status.usage.episodes_today}{status.usage.episodes_daily_limit === null ? " / Unlimited" : ` / ${status.usage.episodes_daily_limit}`}</strong></div>
            <div><span>Episodes in 30 days</span><strong>{status.usage.episodes_last_30_days}{status.usage.episodes_30_day_limit === null ? " / Unlimited" : ` / ${status.usage.episodes_30_day_limit}`}</strong></div>
          </div>
        </div>

        {status.plan !== "admin" && <>
          <div className="panel">
            <p className="section-kicker">50% LAUNCH OFFER</p>
            <h2>Choose your Podcasti subscription</h2>
            <div className="pricing-grid subscription-pricing">
              <article className="plan">
                <h3>Monthly</h3>
                <p>Flexible monthly access. Renew each month when you need it.</p>
                <div className="price">KSh 3,000 <small>/ month</small></div>
                <p><del>KSh 6,000</del> · 50% off</p>
                <ul><li>Up to 3 episodes per day</li><li>90 episodes per rolling 30 days</li><li>20 RSS feeds</li><li>Up to 50,000 script characters</li><li>All standard Podcasti voices</li><li>Automatic scheduling and manual runs</li></ul>
                <button className="btn btn-primary" disabled={!status.mpesa_ready || busy} onClick={() => void startPayment("monthly")}>Pay KSh 3,000 with M-Pesa</button>
              </article>
              <article className="plan featured">
                <span className="eyebrow">BEST VALUE</span>
                <h3 style={{ marginTop: 14 }}>Yearly</h3>
                <p>One payment for 12 months of Podcasti access.</p>
                <div className="price">KSh 15,000 <small>/ year</small></div>
                <p><del>KSh 30,000</del> · 50% off</p>
                <ul><li>Everything in Monthly</li><li>12 months of access</li><li>Equivalent to KSh 1,250 per month</li><li>Save KSh 21,000 versus 12 monthly payments</li></ul>
                <button className="btn btn-primary" disabled={!status.mpesa_ready || busy} onClick={() => void startPayment("yearly")}>Pay KSh 15,000 with M-Pesa</button>
              </article>
            </div>
            <div className="section-form" style={{ marginTop: 20 }}>
              <label>M-Pesa phone number
                <input inputMode="tel" autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="0712345678" />
              </label>
              {!status.mpesa_ready && <p className="auth-notice">M-Pesa checkout is not configured yet. The administrator must add the Safaricom Daraja credentials and server-side Supabase key before customers can pay.</p>}
              {status.mpesa_ready && <p className="microcopy">A payment prompt will appear on this phone. Enter your M-Pesa PIN to approve it. Podcasti activates your plan only after Safaricom confirms the payment.</p>}
            </div>
            {status.pending_payment && <div className="auth-notice" style={{ marginTop: 16 }}>
              M-Pesa payment pending for the {status.pending_payment.plan_interval} plan (KSh {status.pending_payment.amount_ksh.toLocaleString()}). Complete the prompt on your phone, then refresh this page to check the result.
            </div>}
            <div className="integration-actions" style={{ marginTop: 14 }}>
              <button className="btn btn-outline" onClick={() => void refresh(true)} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh payment status"}</button>
            </div>
          </div>
          <div className="panel">
            <h2>Free plan limits</h2>
            <p>Three lifetime manual runs, up to 5,000 script characters per episode, two RSS feeds, one voice (Bella), no recurring schedule, and no more than three manual run attempts in total. Free access does not renew automatically.</p>
          </div>
        </>}
        <p className="microcopy">Payments are requested through Safaricom M-Pesa. Monthly and yearly subscriptions must be renewed by starting another payment; automatic M-Pesa deductions are not enabled.</p>
      </>}
    </section>
  );
}
