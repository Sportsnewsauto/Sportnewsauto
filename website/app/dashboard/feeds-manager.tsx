"use client";

import { useMemo, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Feed = { id: string; name: string; feed_url: string; sport: string; league: string; enabled: boolean };
const presets = [
  { name: "BBC Sport – All Sports", feed_url: "https://feeds.bbci.co.uk/sport/rss.xml", sport: "General", league: "All sports" },
  { name: "Sky Sports – All Sports", feed_url: "https://www.skysports.com/rss/12040", sport: "General", league: "All sports" },
  { name: "ESPN – All Sports", feed_url: "https://www.espn.com/espn/rss/news", sport: "General", league: "All sports" },
  { name: "The Guardian – Sport", feed_url: "https://www.theguardian.com/uk/sport/rss", sport: "General", league: "All sports" },
  { name: "BBC Sport – Football", feed_url: "https://feeds.bbci.co.uk/sport/football/rss.xml", sport: "Football", league: "General" },
  { name: "BBC Sport – Premier League", feed_url: "https://feeds.bbci.co.uk/sport/football/premier-league/rss.xml", sport: "Football", league: "Premier League" },
  { name: "Sky Sports – Premier League", feed_url: "https://www.skysports.com/rss/11661", sport: "Football", league: "Premier League" },
  { name: "BBC Sport – Champions League", feed_url: "https://feeds.bbci.co.uk/sport/football/champions-league/rss.xml", sport: "Football", league: "UEFA Champions League" },
  { name: "BBC Sport – European Football", feed_url: "https://feeds.bbci.co.uk/sport/football/european/rss.xml", sport: "Football", league: "European leagues" },
  { name: "ESPN – Soccer", feed_url: "https://www.espn.com/espn/rss/soccer/news", sport: "Football", league: "International" },
  { name: "ESPNcricinfo – Cricket", feed_url: "https://www.espncricinfo.com/rss/content/story/feeds/0.xml", sport: "Cricket", league: "International" },
  { name: "BBC Sport – Cricket", feed_url: "https://feeds.bbci.co.uk/sport/cricket/rss.xml", sport: "Cricket", league: "International" },
  { name: "Formula One – Official News", feed_url: "https://www.formula1.com/en/latest/all.xml", sport: "Motorsport", league: "Formula One" },
  { name: "BBC Sport – Tennis", feed_url: "https://feeds.bbci.co.uk/sport/tennis/rss.xml", sport: "Tennis", league: "International" },
  { name: "BBC Sport – Rugby Union", feed_url: "https://feeds.bbci.co.uk/sport/rugby-union/rss.xml", sport: "Rugby", league: "Rugby Union" },
];

export default function FeedsManager() {
  const supabase = useMemo(() => createClient(), []);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [sport, setSport] = useState("Football");
  const [league, setLeague] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const { data, error } = await supabase.from("news_feeds").select("id,name,feed_url,sport,league,enabled").order("sport").order("name");
    if (error) setError("Feed storage is not ready. Apply Supabase migration 0002, then refresh.");
    else setFeeds(data ?? []);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function addFeed(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setNotice(""); setError("");
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== "https:") throw new Error("Use an HTTPS feed address.");
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Please sign in again.");
      const { error } = await supabase.from("news_feeds").insert({
        owner_id: user.id, name: name.trim(), feed_url: parsed.toString(), sport: sport.trim() || "General", league: league.trim(), enabled: true,
      });
      if (error) throw error;
      setName(""); setUrl(""); setLeague(""); setNotice("Feed added to your workspace.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add this feed.");
    } finally { setBusy(false); }
  }

  async function addStarterFeeds() {
    setBusy(true); setNotice(""); setError("");
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) { setError("Please sign in again."); setBusy(false); return; }
    const { error } = await supabase.from("news_feeds").upsert(
      presets.map(item => ({ ...item, owner_id: user.id, enabled: true })),
      { onConflict: "owner_id,feed_url", ignoreDuplicates: true },
    );
    if (error) setError("Could not add starter feeds. Apply migration 0002 and try again.");
    else { setNotice("Starter sports feeds added. Check each source before relying on it."); await load(); }
    setBusy(false);
  }

  async function toggle(feed: Feed) {
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.from("news_feeds").update({ enabled: !feed.enabled, updated_at: new Date().toISOString() }).eq("id", feed.id);
    if (error) setError(error.message); else await load();
    setBusy(false);
  }
  async function remove(feed: Feed) {
    if (!window.confirm(`Remove ${feed.name} from your feed list?`)) return;
    setBusy(true); setError(""); setNotice("");
    const { error } = await supabase.from("news_feeds").delete().eq("id", feed.id);
    if (error) setError(error.message); else { setNotice("Feed removed."); await load(); }
    setBusy(false);
  }

  return <div className="dash-main">
    <div className="dash-top"><div><p className="section-kicker">CONTENT SOURCES</p><h1>Sports News Feeds</h1><p>Add RSS feeds for every sport and league you want to cover.</p></div><span className="pill">{feeds.filter(x => x.enabled).length} enabled</span></div>
    <div className="panel"><div className="panel-heading-row"><div><h2>Starter sports feed list</h2><p>Includes general sports, football, Premier League, Champions League, cricket, Formula One, tennis and rugby sources from your existing automation configuration.</p></div><button className="btn btn-outline" onClick={() => void addStarterFeeds()} disabled={busy}>Add starter feeds</button></div></div>
    <form className="panel section-form" onSubmit={addFeed}>
      <h2>Add an RSS feed</h2>
      <label>Feed name<input required value={name} onChange={e => setName(e.target.value)} placeholder="Sports publisher or league" /></label>
      <label>Feed URL<input required type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/rss.xml" /></label>
      <div className="form-grid"><label>Sport<input value={sport} onChange={e => setSport(e.target.value)} /></label><label>League or coverage<input value={league} onChange={e => setLeague(e.target.value)} placeholder="Premier League" /></label></div>
      <button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Add feed"}</button>
    </form>
    <div className="panel"><h2>Your feeds</h2>
      {error && <p className="auth-error">{error}</p>}{notice && <p className="auth-notice">{notice}</p>}
      {loading ? <p>Loading feeds…</p> : feeds.length === 0 ? <p>No feeds have been added yet. Use Add starter feeds to begin.</p> :
        <div className="feed-list">{feeds.map(feed => <div className="feed-row" key={feed.id}>
          <div className="feed-main"><strong>{feed.name}</strong><small>{feed.sport}{feed.league ? ` · ${feed.league}` : ""}</small><a href={feed.feed_url} target="_blank" rel="noreferrer">{feed.feed_url}</a></div>
          <span className={feed.enabled ? "status" : "pill"}>{feed.enabled ? "Enabled" : "Paused"}</span>
          <button className="btn btn-outline btn-small" disabled={busy} onClick={() => void toggle(feed)}>{feed.enabled ? "Pause" : "Enable"}</button>
          <button className="btn btn-outline btn-small" disabled={busy} onClick={() => void remove(feed)}>Remove</button>
        </div>)}</div>}
    </div>
  </div>;
}
