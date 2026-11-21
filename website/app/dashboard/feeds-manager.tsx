"use client";

import { useMemo, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Feed = { id: string; name: string; feed_url: string; sport: string; league: string; enabled: boolean };
const presets = [
  {
    "name": "BBC Sport - All Sports",
    "feed_url": "https://feeds.bbci.co.uk/sport/rss.xml",
    "sport": "General",
    "league": ""
  },
  {
    "name": "Sky Sports - All Sports",
    "feed_url": "https://www.skysports.com/rss/12040",
    "sport": "General",
    "league": ""
  },
  {
    "name": "ESPN - All Sports",
    "feed_url": "https://www.espn.com/espn/rss/news",
    "sport": "General",
    "league": ""
  },
  {
    "name": "The Athletic - All Sports",
    "feed_url": "https://www.nytimes.com/athletic/rss/news/",
    "sport": "General",
    "league": ""
  },
  {
    "name": "Yahoo Sports",
    "feed_url": "https://sports.yahoo.com/rss/",
    "sport": "General",
    "league": ""
  },
  {
    "name": "The Guardian - Sport",
    "feed_url": "https://www.theguardian.com/uk/sport/rss",
    "sport": "General",
    "league": ""
  },
  {
    "name": "CBS Sports - All Sports",
    "feed_url": "https://www.cbssports.com/rss/headlines/",
    "sport": "General",
    "league": ""
  },
  {
    "name": "Sports Illustrated",
    "feed_url": "https://www.si.com/feed",
    "sport": "General",
    "league": ""
  },
  {
    "name": "ESPNcricinfo - Cricket",
    "feed_url": "https://www.espncricinfo.com/rss/content/story/feeds/0.xml",
    "sport": "Cricket",
    "league": "Cricket"
  },
  {
    "name": "Formula One - Official News",
    "feed_url": "https://www.formula1.com/en/latest/all.xml",
    "sport": "Motorsport",
    "league": "Formula One"
  },
  {
    "name": "Sky News - Sports",
    "feed_url": "https://feeds.skynews.com/feeds/rss/sports.xml",
    "sport": "General",
    "league": ""
  },
  {
    "name": "BBC Sport - Football",
    "feed_url": "https://feeds.bbci.co.uk/sport/football/rss.xml",
    "sport": "Football",
    "league": "Football"
  },
  {
    "name": "Sky Sports - Football",
    "feed_url": "https://www.skysports.com/rss/11095",
    "sport": "Football",
    "league": "Football"
  },
  {
    "name": "BBC Sport - Cricket",
    "feed_url": "https://feeds.bbci.co.uk/sport/cricket/rss.xml",
    "sport": "Cricket",
    "league": "Cricket"
  },
  {
    "name": "BBC Sport - Rugby Union",
    "feed_url": "https://feeds.bbci.co.uk/sport/rugby-union/rss.xml",
    "sport": "Rugby",
    "league": "Rugby"
  },
  {
    "name": "BBC Sport - Tennis",
    "feed_url": "https://feeds.bbci.co.uk/sport/tennis/rss.xml",
    "sport": "Tennis",
    "league": "Tennis"
  },
  {
    "name": "BBC Sport - Premier League",
    "feed_url": "https://feeds.bbci.co.uk/sport/football/premier-league/rss.xml",
    "sport": "Football",
    "league": "Premier League"
  },
  {
    "name": "BBC Sport - Champions League",
    "feed_url": "https://feeds.bbci.co.uk/sport/football/champions-league/rss.xml",
    "sport": "Football",
    "league": "Champions League"
  },
  {
    "name": "BBC Sport - European Football",
    "feed_url": "https://feeds.bbci.co.uk/sport/football/european/rss.xml",
    "sport": "Football",
    "league": "European Football"
  },
  {
    "name": "BBC Sport - FA Cup",
    "feed_url": "https://feeds.bbci.co.uk/sport/football/fa-cup/rss.xml",
    "sport": "General",
    "league": ""
  },
  {
    "name": "BBC Sport - Women's Football",
    "feed_url": "https://feeds.bbci.co.uk/sport/football/womens/rss.xml",
    "sport": "Football",
    "league": "Women's Football"
  },
  {
    "name": "Sky Sports - Premier League",
    "feed_url": "https://www.skysports.com/rss/11661",
    "sport": "Football",
    "league": "Premier League"
  },
  {
    "name": "Sky Sports - Formula One",
    "feed_url": "https://www.skysports.com/rss/12433",
    "sport": "Motorsport",
    "league": "Formula One"
  },
  {
    "name": "Sky Sports - Cricket",
    "feed_url": "https://www.skysports.com/rss/12123",
    "sport": "Cricket",
    "league": "Cricket"
  },
  {
    "name": "Sky Sports - Tennis",
    "feed_url": "https://www.skysports.com/rss/12110",
    "sport": "Tennis",
    "league": "Tennis"
  },
  {
    "name": "Sky Sports - Golf",
    "feed_url": "https://www.skysports.com/rss/12176",
    "sport": "Golf",
    "league": "Golf"
  },
  {
    "name": "Sky Sports - Boxing",
    "feed_url": "https://www.skysports.com/rss/12183",
    "sport": "Boxing",
    "league": "Boxing"
  },
  {
    "name": "Sky Sports - Rugby Union",
    "feed_url": "https://www.skysports.com/rss/12321",
    "sport": "Rugby",
    "league": "Rugby"
  },
  {
    "name": "Sky Sports - NFL",
    "feed_url": "https://www.skysports.com/rss/12118",
    "sport": "American Football",
    "league": "NFL"
  },
  {
    "name": "ESPN - Soccer",
    "feed_url": "https://www.espn.com/espn/rss/soccer/news",
    "sport": "Football",
    "league": "Soccer"
  },
  {
    "name": "ESPN - NBA",
    "feed_url": "https://www.espn.com/espn/rss/nba/news",
    "sport": "Basketball",
    "league": "Basketball"
  },
  {
    "name": "ESPN - NFL",
    "feed_url": "https://www.espn.com/espn/rss/nfl/news",
    "sport": "American Football",
    "league": "NFL"
  },
  {
    "name": "ESPN - MLB",
    "feed_url": "https://www.espn.com/espn/rss/mlb/news",
    "sport": "Baseball",
    "league": "MLB"
  },
  {
    "name": "ESPN - NHL",
    "feed_url": "https://www.espn.com/espn/rss/nhl/news",
    "sport": "Ice Hockey",
    "league": "NHL"
  },
  {
    "name": "ESPN - Motorsports",
    "feed_url": "https://www.espn.com/espn/rss/rpm/news",
    "sport": "Motorsport",
    "league": "Formula One"
  },
  {
    "name": "ESPN - College Basketball",
    "feed_url": "https://www.espn.com/espn/rss/ncb/news",
    "sport": "Basketball",
    "league": "Basketball"
  },
  {
    "name": "ESPN - College Football",
    "feed_url": "https://www.espn.com/espn/rss/ncf/news",
    "sport": "Football",
    "league": "College Football"
  },
  {
    "name": "MLB - Official News",
    "feed_url": "https://www.mlb.com/feeds/news/rss.xml",
    "sport": "Baseball",
    "league": "MLB"
  },
  {
    "name": "Autosport - Motorsport",
    "feed_url": "https://www.autosport.com/rss/feed/all",
    "sport": "Motorsport",
    "league": "Formula One"
  },
  {
    "name": "ProFootballTalk - NFL",
    "feed_url": "https://www.nbcsports.com/profootballtalk.rss",
    "sport": "Football",
    "league": "ProFootballTalk - NFL"
  },
  {
    "name": "Google News - Global Sports",
    "feed_url": "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=en-US&gl=US&ceid=US:en",
    "sport": "General",
    "league": ""
  },
  {
    "name": "Google News - Premier League",
    "feed_url": "https://news.google.com/rss/search?q=Premier+League+football+when%3A1d&hl=en-GB&gl=GB&ceid=GB%3Aen",
    "sport": "Football",
    "league": "Premier League"
  },
  {
    "name": "Google News - UEFA Champions League",
    "feed_url": "https://news.google.com/rss/search?q=UEFA+Champions+League+when%3A1d&hl=en-GB&gl=GB&ceid=GB%3Aen",
    "sport": "Football",
    "league": "UEFA Champions League"
  },
  {
    "name": "Google News - La Liga",
    "feed_url": "https://news.google.com/rss/search?q=La+Liga+football+when%3A1d&hl=en-GB&gl=GB&ceid=GB%3Aen",
    "sport": "Football",
    "league": "La Liga"
  },
  {
    "name": "Google News - Serie A",
    "feed_url": "https://news.google.com/rss/search?q=Serie+A+football+when%3A1d&hl=en-GB&gl=GB&ceid=GB%3Aen",
    "sport": "Football",
    "league": "Serie A"
  },
  {
    "name": "Google News - Bundesliga",
    "feed_url": "https://news.google.com/rss/search?q=Bundesliga+football+when%3A1d&hl=en-GB&gl=GB&ceid=GB%3Aen",
    "sport": "Football",
    "league": "Bundesliga"
  },
  {
    "name": "Google News - Ligue 1",
    "feed_url": "https://news.google.com/rss/search?q=Ligue+1+football+when%3A1d&hl=en-GB&gl=GB&ceid=GB%3Aen",
    "sport": "Football",
    "league": "Ligue 1"
  },
  {
    "name": "Google News - African Football",
    "feed_url": "https://news.google.com/rss/search?q=African+football+CAF+when%3A1d&hl=en&gl=KE&ceid=KE%3Aen",
    "sport": "Football",
    "league": "African Football"
  },
  {
    "name": "Google News - Kenyan Sports",
    "feed_url": "https://news.google.com/rss/search?q=Kenya+sports+when%3A1d&hl=en&gl=KE&ceid=KE%3Aen",
    "sport": "General",
    "league": ""
  }
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
    <div className="panel"><div className="panel-heading-row"><div><h2>Starter sports feed list</h2><p>Imports all sports RSS feeds currently configured in your existing automation, including all league-specific football feeds.</p></div><button className="btn btn-outline" onClick={() => void addStarterFeeds()} disabled={busy}>Add starter feeds</button></div></div>
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
