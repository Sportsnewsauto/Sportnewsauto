"use client";

import { useEffect, useState } from "react";

type Provider = "spreaker" | "groq" | "gemini";
type Connection = { provider: Provider; status: string; masked_suffix: string; updated_at: string };

const providerInfo: Record<Provider, { title: string; description: string; placeholder: string }> = {
  spreaker: { title: "Spreaker", description: "OAuth access token used to connect your show and publish episodes.", placeholder: "Paste your Spreaker access token" },
  groq: { title: "Groq", description: "API key used for episode script and metadata generation.", placeholder: "Paste your Groq API key" },
  gemini: { title: "Google Gemini", description: "API key used for script and metadata generation or fallback.", placeholder: "Paste your Gemini API key" },
};

export default function IntegrationManager() {
  const [connections, setConnections] = useState<Connection[]>([]);
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
      setConnections(data.connections ?? []);
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

  return <section className="panel integration-list">
    <div className="integration-security"><strong>Encrypted credential storage</strong><p>Credentials are encrypted on the server with AES-256-GCM. The secret value is never returned to the browser. Connections remain marked unverified until a provider test is added.</p></div>
    {(["spreaker", "groq", "gemini"] as const).map(provider => {
      const info = providerInfo[provider];
      const saved = connectionFor(provider);
      return <div className="integration-card" key={provider}>
        <div className="integration-heading"><div><h2>{info.title}</h2><p>{info.description}</p></div><span className={saved ? "pill" : "status-muted"}>{saved ? "Saved · unverified" : "Not connected"}</span></div>
        {saved && <p className="integration-saved">Saved credential ending in <strong>•••• {saved.masked_suffix}</strong></p>}
        <label>{saved ? "Replace credential" : "Credential"}
          <input type="password" autoComplete="off" value={secrets[provider]} onChange={e => setSecrets(current => ({ ...current, [provider]: e.target.value }))} placeholder={info.placeholder} />
        </label>
        <div className="integration-actions">
          <button className="btn btn-primary" disabled={busy !== null || !secrets[provider].trim()} onClick={() => void save(provider)}>{busy === provider ? "Saving…" : saved ? "Replace securely" : "Save securely"}</button>
          {saved && <button className="btn btn-outline" disabled={busy !== null} onClick={() => void remove(provider)}>Remove</button>}
        </div>
      </div>;
    })}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {notice && <p className="auth-notice" role="status">{notice}</p>}
  </section>;
}
