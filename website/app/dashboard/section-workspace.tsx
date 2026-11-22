"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Section = "ai-configuration" | "audio-settings" | "publishing-schedule" | "episodes" | "subscription" | "support" | "settings";

type WorkspaceSettings = {
  podcast_name: string;
  podcast_description: string;
  category: string;
  language: string;
  country: string;
  spreaker_show_id: string;
  timezone: string;
  minimum_narration_characters: number;
  tts_provider: "kokoro";
  tts_voice: string;
  publishing_mode: "automatic" | "review";
  automation_enabled: boolean;
  scheduled_times: string[];
};

const defaultSettings: WorkspaceSettings = {
  podcast_name: "My Sports Podcast",
  podcast_description: "",
  category: "Sports",
  language: "en",
  country: "KE",
  spreaker_show_id: "",
  timezone: "Africa/Nairobi",
  minimum_narration_characters: 13500,
  tts_provider: "kokoro",
  tts_voice: "af_heart",
  publishing_mode: "automatic",
  automation_enabled: false,
  scheduled_times: ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"],
};

const sectionInfo: Record<Section, { title: string; intro: string }> = {
  "ai-configuration": { title: "AI Configuration", intro: "Set the minimum number of characters for each episode script." },
  "audio-settings": { title: "Audio Settings", intro: "Choose the platform-provided Kokoro voice used for narration." },
  "publishing-schedule": { title: "Publishing Schedule", intro: "Choose when episodes should be prepared and whether they publish automatically or wait for approval." },
  episodes: { title: "Episodes", intro: "View episode records belonging to your workspace." },
  subscription: { title: "Subscription", intro: "Review your current plan and its usage allowance." },
  support: { title: "Support", intro: "Help and setup information for your podcast workspace." },
  settings: { title: "Workspace Settings", intro: "Manage your workspace name and timezone." },
};

function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <p className={error ? "auth-error" : "auth-notice"} role="status">{children}</p>;
}

export default function SectionWorkspace({ section }: { section: Section }) {
  if (section === "ai-configuration" || section === "audio-settings" || section === "publishing-schedule") {
    return <ConfigurationForm section={section} />;
  }
  if (section === "episodes") return <EpisodesList />;
  if (section === "subscription") return <SubscriptionPanel />;
  if (section === "settings") return <WorkspaceProfile />;
  return <SupportPanel />;
}

function ConfigurationForm({ section }: { section: "ai-configuration" | "audio-settings" | "publishing-schedule" }) {
  const supabase = useMemo(() => createClient(), []);
  const [form, setForm] = useState<WorkspaceSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      const { data, error } = await supabase.from("workspace_settings").select("*").maybeSingle();
      if (!active) return;
      if (error) setError("Workspace settings are not available. Apply all Supabase migrations, including 0007, then refresh this page.");
      else if (data) setForm({ ...defaultSettings, ...data, scheduled_times: Array.isArray(data.scheduled_times) ? data.scheduled_times : defaultSettings.scheduled_times });
      setLoading(false);
    }
    void load();
    return () => { active = false; };
  }, [supabase]);

  function update<K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) {
    setForm(current => ({ ...current, [key]: value }));
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setNotice("");
    setError("");
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      setError("Your session has expired. Sign in again.");
      setSaving(false);
      return;
    }
    if (
      section === "ai-configuration" &&
      (!Number.isInteger(form.minimum_narration_characters) ||
        form.minimum_narration_characters < 5000 ||
        form.minimum_narration_characters > 50000)
    ) {
      setError("Choose a script length between 5,000 and 50,000 characters.");
      setSaving(false);
      return;
    }
    const values = section === "ai-configuration"
      ? {
          owner_id: user.id,
          minimum_narration_characters: form.minimum_narration_characters,
          updated_at: new Date().toISOString(),
        }
      : { ...form, owner_id: user.id, updated_at: new Date().toISOString() };
    const { error: saveError } = await supabase.from("workspace_settings").upsert(
      values,
      { onConflict: "owner_id" },
    );
    if (saveError) setError(saveError.message);
    else setNotice("Your settings have been saved.");
    setSaving(false);
  }

  const info = sectionInfo[section];
  if (loading) return <section className="dash-main"><p>Loading settings…</p></section>;

  return (
    <section className="dash-main">
      <div className="dash-top"><div><p className="section-kicker">WORKSPACE</p><h1>{info.title}</h1><p>{info.intro}</p></div><span className="pill">Configuration</span></div>
      <form className="panel section-form" onSubmit={save}>
        {section === "ai-configuration" && <>
          <label>Minimum script length (characters)
            <input
              type="number"
              inputMode="numeric"
              min={5000}
              max={50000}
              step={500}
              required
              value={form.minimum_narration_characters}
              onChange={e => update("minimum_narration_characters", Number(e.target.value))}
            />
          </label>
          <p className="microcopy">This is a minimum narration length, not an exact character count. Every account uses the same platform writing instructions and AI models. Connect your own Groq and/or Gemini API keys in API Connections.</p>
        </>}
        {section === "audio-settings" && <>
          <label>Text-to-speech provider<input value="Kokoro (provided by platform)" readOnly /></label>
          <label>Kokoro voice ID<input required value={form.tts_voice} onChange={e => update("tts_voice", e.target.value)} placeholder="af_heart" /></label>
          <p className="microcopy">Voice selection is saved here. The audio-generation worker must be connected before this setting affects published episodes.</p>
        </>}
        {section === "publishing-schedule" && <>
          <label className="automation-toggle"><span><strong>Enable scheduled episode generation</strong><small>Leave this off until your Spreaker, AI and sports feed connections are ready.</small></span><input type="checkbox" checked={form.automation_enabled} onChange={e => update("automation_enabled", e.target.checked)} /></label>
          <label>Publishing mode<select value={form.publishing_mode} onChange={e => update("publishing_mode", e.target.value as "automatic" | "review")}><option value="automatic">Automatic publishing</option><option value="review">Review before publishing</option></select></label>
          <label>Timezone<input required value={form.timezone} onChange={e => update("timezone", e.target.value)} /></label>
          <label>Scheduled times (one HH:MM time per line)<textarea rows={8} value={form.scheduled_times.join("\n")} onChange={e => update("scheduled_times", e.target.value.split(/[\n,]+/).map(x => x.trim()).filter(Boolean))} /></label>
          <p className="microcopy">Default times are evenly spaced every three hours. The separate worker checks this schedule and enforces your daily episode allowance. Scheduled generation remains off until you enable it above.</p>
        </>}
        {error && <Notice error>{error}</Notice>}
        {notice && <Notice>{notice}</Notice>}
        <button className="btn btn-primary" disabled={saving || loading}>{saving ? "Saving…" : "Save settings"}</button>
      </form>
    </section>
  );
}

function EpisodesList() {
  const supabase = useMemo(() => createClient(), []);
  const [episodes, setEpisodes] = useState<Array<{ id: string; title: string; status: string; created_at: string; published_at: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [dailyLimit, setDailyLimit] = useState(1);
  const [plan, setPlan] = useState("free");
  useEffect(() => {
    let active = true;
    void supabase.from("workspaces").select("plan,daily_episode_limit").maybeSingle().then(({ data }) => {
      if (active && data) { setPlan(data.plan); setDailyLimit(data.daily_episode_limit); }
    });
    void supabase.from("episodes").select("id,title,status,created_at,published_at").order("created_at", { ascending: false }).limit(50)
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setError("Episode records are not ready. Apply migration 0002 in Supabase and refresh.");
        else setEpisodes(data ?? []);
        setLoading(false);
      });
    return () => { active = false; };
  }, [supabase]);

  async function publishNow(episodeId: string) {
    setPublishingId(episodeId);
    setError("");
    setNotice("");
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      setError("Please sign in again.");
      setPublishingId(null);
      return;
    }
    const { error: queueError } = await supabase.from("publishing_jobs").insert({
      owner_id: user.id,
      job_type: "publish_episode",
      status: "queued",
      scheduled_at: new Date().toISOString(),
      payload: { episode_id: episodeId },
    });
    if (queueError) {
      setError("Could not queue this episode for publishing. Make sure Supabase migration 0003 is applied.");
      setPublishingId(null);
      return;
    }
    await supabase.from("episodes").update({ status: "queued", updated_at: new Date().toISOString() }).eq("id", episodeId);
    setEpisodes(current => current.map(item => item.id === episodeId ? { ...item, status: "queued" } : item));
    setNotice("Episode queued. The podcast worker will publish it to Spreaker.");
    setPublishingId(null);
  }

  return <section className="dash-main">
    <div className="dash-top"><div><p className="section-kicker">WORKSPACE</p><h1>Episodes</h1><p>Generated and published episodes for this account.</p></div><span className="pill">{plan === "admin" ? `Admin plan: ${dailyLimit} per day` : `Free plan: ${dailyLimit} per day`}</span></div>
    <div className="panel">
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {loading ? <p>Loading episodes…</p> : episodes.length === 0 ? <><h2>No episodes yet</h2><p>Episode generation is not connected to the website worker yet. When the worker is connected, your drafts and published episodes will appear here.</p></> :
        <div className="table-scroll"><table className="data-table"><thead><tr><th>Episode</th><th>Status</th><th>Created</th><th>Published</th><th>Action</th></tr></thead><tbody>{episodes.map(e => <tr key={e.id}><td>{e.title}</td><td><span className="pill">{e.status}</span></td><td>{new Date(e.created_at).toLocaleString()}</td><td>{e.published_at ? new Date(e.published_at).toLocaleString() : "—"}</td><td>{e.status === "draft" ? <button className="btn btn-primary btn-small" disabled={publishingId !== null} onClick={() => void publishNow(e.id)}>{publishingId === e.id ? "Queuing…" : "Publish now"}</button> : e.status === "queued" ? "Waiting for worker" : "—"}</td></tr>)}</tbody></table></div>}
    </div>
  </section>;
}

function SubscriptionPanel() {
  const supabase = useMemo(() => createClient(), []);
  const [plan, setPlan] = useState("free");
  const [limit, setLimit] = useState(1);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void supabase.from("workspaces").select("plan,daily_episode_limit").maybeSingle().then(({ data }) => {
      if (!active) return;
      if (data) { setPlan(data.plan); setLimit(data.daily_episode_limit); }
      setLoading(false);
    });
    return () => { active = false; };
  }, [supabase]);
  return <section className="dash-main">
    <div className="dash-top"><div><p className="section-kicker">ACCOUNT</p><h1>Subscription</h1><p>Your current account plan and usage allowance.</p></div><span className="status">Current plan</span></div>
    <div className="panel subscription-panel"><h2>{plan.charAt(0).toUpperCase() + plan.slice(1)} plan</h2><p><strong>{loading ? "…" : limit}</strong> episode{limit === 1 ? "" : "s"} per day</p><p>Monthly subscriptions and payment processing have not yet been connected. No charges will be made from this page.</p><span className="pill">Billing not enabled</span></div>
  </section>;
}

function WorkspaceProfile() {
  const supabase = useMemo(() => createClient(), []);
  const [name, setName] = useState("My Podcast Workspace");
  const [timezone, setTimezone] = useState("Africa/Nairobi");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void supabase.from("workspaces").select("name,timezone").maybeSingle().then(({ data, error }) => {
      if (!active) return;
      if (error) setError(error.message);
      if (data) { setName(data.name); setTimezone(data.timezone); }
      setLoading(false);
    });
    return () => { active = false; };
  }, [supabase]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError(""); setNotice("");
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      setError("Please sign in again.");
      setSaving(false);
      return;
    }
    const { error } = await supabase.from("workspaces").update({ name, timezone, updated_at: new Date().toISOString() }).eq("owner_id", user.id);
    if (error) setError(error.message);
    else setNotice("Workspace details saved.");
    setSaving(false);
  }
  return <section className="dash-main">
    <div className="dash-top"><div><p className="section-kicker">ACCOUNT</p><h1>Workspace Settings</h1><p>Change your workspace name and timezone.</p></div></div>
    <form className="panel section-form" onSubmit={save}>
      <label>Workspace name<input required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>Timezone<input required value={timezone} onChange={e => setTimezone(e.target.value)} /></label>
      {error && <Notice error>{error}</Notice>}{notice && <Notice>{notice}</Notice>}
      <button className="btn btn-primary" disabled={loading || saving}>{saving ? "Saving…" : "Save workspace"}</button>
    </form>
  </section>;
}

function SupportPanel() {
  return <section className="dash-main">
    <div className="dash-top"><div><p className="section-kicker">HELP</p><h1>Support</h1><p>Setup notes and help for your podcast workspace.</p></div></div>
    <div className="panel"><h2>Before connecting services</h2><p>Use API Connections to save provider credentials once the encrypted credential vault is configured. Never put private API keys into public feeds, episode descriptions or chat messages.</p><h2>Current implementation status</h2><ul><li>Account registration, login and private workspace: active.</li><li>Podcast and schedule preferences: saved in Supabase after migration 0002.</li><li>Feed and advertising configuration: saved in Supabase after migration 0002.</li><li>Episode generation and Spreaker publishing worker: not connected to this multi-user dashboard yet.</li><li>Subscriptions and payments: not enabled.</li></ul><Link href="/dashboard" className="btn btn-outline">Back to overview</Link></div>
  </section>;
}
