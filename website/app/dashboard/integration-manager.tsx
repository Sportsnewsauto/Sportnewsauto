"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Provider = "spreaker" | "groq" | "gemini";
type Connection = { provider: Provider; status: string; masked_suffix: string; updated_at: string };
type SpreakerShow = { show_id: string; title: string; site_url: string };

const providerInfo: Record<Provider, { title: string; description: string; placeholder: string }> = {
  spreaker: { title: "Spreaker", description: "OAuth access token used to connect your show and publish episodes.", placeholder: "Paste your Spreaker access token" },
  groq: { title: "Groq", description: "API key used for episode script and metadata generation.", placeholder: "Paste your Groq API key" },
  gemini: { title: "Google Gemini", description: "API key used for script and metadata generation or fallback.", placeholder: "Paste your Gemini API key" },
};

export default function IntegrationManager() {
  const supabase = useMemo(() => createClient(), []);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [shows, setShows] = useState<SpreakerShow[]>([]);
  const [selectedShow, setSelectedShow] = useState("");
  const [showBusy, setShowBusy] = useState(false);
  const [secrets, setSecrets] = useState<Record<Provider, string>>({ spreaker: "", groq: "", gemini: "" });
  const [busy, setBusy] = useState<Provider | "loading" | null>("loading");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setBusy("loading"); setError("");
    try {
      const response = await fetch("/api/integrations", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load integrations.");
      const loadedConnections = data.connections ?? [];
      setConnections(loadedConnections);
      const spreaker = loadedConnections.find((item: Connection) => item.provider === "spreaker");
      if (spreaker?.status === "connected") {
        const showResponse = await fetch("/api/integrations?resource=spreaker-shows", { cache: "no-store" });
        const showData = await showResponse.json();
        if (showResponse.ok) setShows(showData.shows ?? []);
        const { data: settings } = await supabase.from("workspace_settings").select("spreaker_show_id").maybeSingle();
        setSelectedShow(settings?.spreaker_show_id ?? "");
      } else {
        setShows([]);
        setSelectedShow("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load integrations.");
    } finally { setBusy(null); }
  }
  useEffect(() => { void load(); }, []);

  async function save(provider: Provider) {
    setBusy(provider); setError(""); setNotice("");
    try {
      const response = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, secret: secrets[provider] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save credential.");
      setSecrets(current => ({ ...current, [provider]: "" }));
      setNotice(data.message || "Credential saved.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save credential.");
    } finally { setBusy(null); }
  }

  async function verify(provider: Provider) {
    setBusy(provider); setError(""); setNotice("");
    try {
      const response = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, action: "verify" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Provider verification failed.");
      setNotice(data.message || "Provider connection verified.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider verification failed.");
      await load();
    } finally { setBusy(null); }
  }

  async function remove(provider: Provider) {
    if (!window.confirm(`Remove the saved ${providerInfo[provider].title} credential?`)) return;
    setBusy(provider); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/integrations?provider=${provider}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not remove credential.");
      setNotice(`${providerInfo[provider].title} credential removed.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove credential.");
    } finally { setBusy(null); }
  }

  function connectionFor(provider: Provider) { return connections.find(item => item.provider === provider); }

  async function saveShowSelection() {
    setShowBusy(true); setError(""); setNotice("");
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) throw new Error("Please sign in again.");
      const { error } = await supabase.from("workspace_settings").upsert({
        owner_id: user.id,
        spreaker_show_id: selectedShow,
        updated_at: new Date().toISOString(),
      }, { onConflict: "owner_id" });
      if (error) throw error;
      setNotice("Your Spreaker show selection has been saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the selected Spreaker show.");
    } finally { setShowBusy(false); }
  }


  return <section className="panel integration-list">
    <div className="integration-security"><strong>Encrypted credential storage</strong><p>Credentials are encrypted on the server with AES-256-GCM. The secret value is never returned to the browser. Saved credentials can be tested against each provider; the secret itself is never returned to the browser.</p></div>
    {(["spreaker", "groq", "gemini"] as const).map(provider => {
      const info = providerInfo[provider];
      const saved = connectionFor(provider);
      return <div className="integration-card" key={provider}>
        <div className="integration-heading"><div><h2>{info.title}</h2><p>{info.description}</p></div><span className={saved?.status === "connected" ? "status" : saved?.status === "invalid" ? "auth-error" : saved ? "pill" : "status-muted"}>{saved?.status === "connected" ? "Verified" : saved?.status === "invalid" ? "Needs attention" : saved ? "Saved · unverified" : "Not connected"}</span></div>
        {saved && <p className="integration-saved">Saved credential ending in <strong>•••• {saved.masked_suffix}</strong></p>}
        <label>{saved ? "Replace credential" : "Credential"}
          <input type="password" autoComplete="off" value={secrets[provider]} onChange={e => setSecrets(current => ({ ...current, [provider]: e.target.value }))} placeholder={info.placeholder} />
        </label>
        <div className="integration-actions">
          <button className="btn btn-primary" disabled={busy !== null || !secrets[provider].trim()} onClick={() => void save(provider)}>{busy === provider ? "Saving…" : saved ? "Replace securely" : "Save securely"}</button>
          {saved && <button className="btn btn-outline" disabled={busy !== null} onClick={() => void verify(provider)}>{busy === provider ? "Checking…" : "Verify connection"}</button>}
          {saved && <button className="btn btn-outline" disabled={busy !== null} onClick={() => void remove(provider)}>Remove</button>}
        </div>
      </div>;
    })}
    {connectionFor("spreaker")?.status === "connected" && <div className="integration-card spreaker-show-picker">
      <div><h2>Choose your Spreaker show</h2><p>Select the show where this workspace will publish. The list comes from the authenticated Spreaker account.</p></div>
      {shows.length === 0 ? <p className="microcopy">No editable shows were returned for this Spreaker account.</p> : <>
        <label>Spreaker show<select value={selectedShow} onChange={e => setSelectedShow(e.target.value)}>
          <option value="">Choose a show…</option>
          {shows.map(show => <option key={show.show_id} value={show.show_id}>{show.title} (ID {show.show_id})</option>)}
        </select></label>
        <button className="btn btn-primary" disabled={showBusy || !selectedShow} onClick={() => void saveShowSelection()}>{showBusy ? "Saving…" : "Save selected show"}</button>
      </>}
    </div>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {notice && <p className="auth-notice" role="status">{notice}</p>}
  </section>;
}
