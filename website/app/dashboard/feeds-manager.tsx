"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Feed = { id: string; feed_url: string };

export default function FeedsManager() {
  const supabase = useMemo(() => createClient(), []);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState<number | null>(2);
  const [isPaid, setIsPaid] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      setError("Please sign in again.");
      setFeeds([]);
      setLoading(false);
      return;
    }
    const [{ data, error }, { data: workspace }] = await Promise.all([
      supabase.from("news_feeds").select("id,feed_url").eq("owner_id", user.id).order("created_at", { ascending: false }),
      supabase.from("workspaces").select("plan,subscription_status,subscription_expires_at").eq("owner_id", user.id).maybeSingle(),
    ]);
    if (error) setError("Your RSS feeds could not be loaded. Refresh and try again.");
    else setFeeds(data ?? []);
    const isAdmin = workspace?.plan === "admin";
    const expiresAt = workspace?.subscription_expires_at ? Date.parse(workspace.subscription_expires_at) : 0;
    const paid = isAdmin || (
      ["pro", "business"].includes(workspace?.plan ?? "") &&
      workspace?.subscription_status === "active" &&
      expiresAt > Date.now()
    );
    setIsPaid(paid && !isAdmin);
    setLimit(isAdmin ? null : paid ? 20 : 2);
    setLoading(false);
  }

  useEffect(() => { void load(); }, [supabase]);

  async function addFeed(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setNotice(""); setError("");
    try {
      if (limit !== null && feeds.length >= limit) {
        throw new Error("Your current plan has reached its RSS feed limit. Upgrade to add more feeds.");
      }
      const parsed = new URL(url.trim());
      if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
        throw new Error("Enter a valid HTTPS RSS feed URL.");
      }
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) throw new Error("Please sign in again.");
      const { error: insertError } = await supabase.from("news_feeds").insert({
        owner_id: user.id,
        name: parsed.hostname.replace(/^www\\./i, ""),
        feed_url: parsed.toString(),
        sport: "General",
        league: "",
        enabled: true,
      });
      if (insertError?.code === "23505") throw new Error("This RSS feed is already in your workspace.");
      if (insertError) throw new Error(insertError.message.includes("RSS feeds") ? insertError.message : "Could not add this RSS feed.");
      setUrl("");
      setNotice("RSS feed added to your workspace.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add this RSS feed.");
    } finally {
      setBusy(false);
    }
  }

  async function removeFeed(feed: Feed) {
    setBusy(true); setNotice(""); setError("");
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      setError("Please sign in again.");
      setBusy(false);
      return;
    }
    const { error: deleteError } = await supabase.from("news_feeds").delete().eq("id", feed.id).eq("owner_id", user.id);
    if (deleteError) setError(deleteError.message);
    else { setNotice("RSS feed removed."); await load(); }
    setBusy(false);
  }

  const atLimit = limit !== null && feeds.length >= limit;

  return (
    <section className="dash-main">
      <div className="dash-top">
        <div><p className="section-kicker">CONTENT SOURCE</p><h1>RSS Feed</h1><p>Add the RSS feed URLs used to find stories for your podcast.</p></div>
        <span className="pill">{feeds.length} saved{limit === null ? "" : ` / ${limit}`}</span>
      </div>
      <form className="panel section-form" onSubmit={addFeed}>
        <label>RSS feed URL<input required type="url" inputMode="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/rss.xml" /></label>
        <p className="microcopy">{limit === null ? "Admin workspace: no feed cap." : isPaid ? "Paid plans allow up to 20 RSS feeds." : "Free accounts can save up to 2 RSS feeds. Upgrade to save more."} Enter an HTTPS RSS or Atom feed URL.</p>
        {error && <p className="auth-error" role="alert">{error}</p>}
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        <button className="btn btn-primary" disabled={busy || loading || atLimit}>{busy ? "Saving…" : atLimit ? "RSS feed limit reached" : "Add RSS feed"}</button>
        {atLimit && !isPaid && <Link className="btn btn-outline" href="/dashboard/subscription">Upgrade your plan to add more feeds</Link>}
      </form>
      <div className="panel">
        <h2>Your RSS feeds</h2>
        {loading ? <p>Loading feeds…</p> : feeds.length === 0 ? <p>No RSS feeds added yet.</p> : (
          <div className="feed-list">{feeds.map(feed => <div className="feed-row" key={feed.id}>
            <div className="feed-main"><a href={feed.feed_url} target="_blank" rel="noreferrer">{feed.feed_url}</a></div>
            <button className="btn btn-outline btn-small" disabled={busy} onClick={() => void removeFeed(feed)}>Remove</button>
          </div>)}</div>
        )}
      </div>
    </section>
  );
}
