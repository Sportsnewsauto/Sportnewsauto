"use client";

import { useMemo, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Slot = { id?: string; position_seconds: number; label: string; enabled: boolean };
const starterSlots: Slot[] = [
  { position_seconds: 30, label: "Ad break at 30 seconds", enabled: true },
  { position_seconds: 60, label: "Ad break at 1 minute", enabled: true },
  { position_seconds: 120, label: "Ad break at 2 minutes", enabled: true },
  { position_seconds: 180, label: "Ad break at 3 minutes", enabled: true },
];

export default function AdvertisingManager() {
  const supabase = useMemo(() => createClient(), []);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const { data, error } = await supabase.from("ad_slots").select("id,position_seconds,label,enabled").order("position_seconds");
    if (error) setError("Advertising storage is not ready. Apply Supabase migration 0002, then refresh.");
    else setSlots(data ?? []);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function addDefaults() {
    setSaving(true); setError(""); setNotice("");
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setError("Please sign in again."); setSaving(false); return; }
    const { error } = await supabase.from("ad_slots").upsert(
      starterSlots.map(slot => ({ ...slot, owner_id: user.id })),
      { onConflict: "owner_id,position_seconds", ignoreDuplicates: true },
    );
    if (error) setError("Could not add the four starter ad positions. Apply migration 0002 first.");
    else { setNotice("Four ad positions have been added."); await load(); }
    setSaving(false);
  }

  async function save() {
    setSaving(true); setError(""); setNotice("");
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setError("Please sign in again."); setSaving(false); return; }
    const { error } = await supabase.from("ad_slots").upsert(
      slots.map(slot => ({ owner_id: user.id, position_seconds: slot.position_seconds, label: slot.label, enabled: slot.enabled, updated_at: new Date().toISOString() })),
      { onConflict: "owner_id,position_seconds" },
    );
    if (error) setError(error.message); else setNotice("Advertising positions saved.");
    setSaving(false);
  }

  function update(index: number, changes: Partial<Slot>) {
    setSlots(current => current.map((slot, i) => i === index ? { ...slot, ...changes } : slot));
  }

  return <div className="dash-main">
    <div className="dash-top"><div><p className="section-kicker">MONETISATION</p><h1>Advertising</h1><p>Set advertising cue-point positions in the episode timeline.</p></div><span className="pill">{slots.filter(x => x.enabled).length} active</span></div>
    <div className="panel"><div className="panel-heading-row"><div><h2>Ad break positions</h2><p>The four starting positions below match the previous schedule you requested: 30 seconds, 1 minute, 2 minutes and 3 minutes.</p></div><button className="btn btn-outline" onClick={() => void addDefaults()} disabled={saving}>Add four positions</button></div></div>
    <div className="panel">
      {error && <p className="auth-error">{error}</p>}{notice && <p className="auth-notice">{notice}</p>}
      {loading ? <p>Loading ad positions…</p> : slots.length === 0 ? <p>No ad positions configured. Click Add four positions to begin.</p> :
        <div className="slot-list">{slots.map((slot, index) => <div className="slot-row" key={slot.id ?? slot.position_seconds}>
          <label>Position (seconds)<input type="number" min={1} max={7200} value={slot.position_seconds} onChange={e => update(index, { position_seconds: Number(e.target.value) })} /></label>
          <label>Label<input value={slot.label} onChange={e => update(index, { label: e.target.value })} /></label>
          <label className="check-label"><input type="checkbox" checked={slot.enabled} onChange={e => update(index, { enabled: e.target.checked })} /> Enabled</label>
        </div>)}
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save ad positions"}</button></div>}
    </div>
    <div className="panel"><h2>Important</h2><p>These are saved cue-point settings only. Ad audio, advertiser campaigns, insertion, playback verification and Spreaker monetisation permissions are not connected yet. No ads will be inserted just because a slot is enabled.</p></div>
  </div>;
}
