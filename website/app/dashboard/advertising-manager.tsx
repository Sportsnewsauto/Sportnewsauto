"use client";

import { useMemo, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Slot = { id?: string; position_seconds: number; ads_max_count: number; label: string; enabled: boolean };

export default function AdvertisingManager() {
  const supabase = useMemo(() => createClient(), []);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const { data, error } = await supabase
      .from("ad_slots")
      .select("id,position_seconds,ads_max_count,label,enabled")
      .order("position_seconds");
    if (error) setError("Ad Slots storage is not available. Confirm Supabase migrations 0002 and 0015 are applied.");
    else setSlots(data ?? []);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  function addSlot() {
    setError("");
    setNotice("");
    setSlots(current => {
      const lastPosition = current.reduce(
        (highest, slot) => Math.max(highest, Number(slot.position_seconds) || 0),
        0,
      );
      const position = lastPosition + 30;
      return [
        ...current,
        {
          position_seconds: position,
          ads_max_count: 4,
          label: `Ad break at ${position} seconds`,
          enabled: true,
        },
      ];
    });
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");

    const positions = slots.map(slot => slot.position_seconds);
    const hasInvalidValue = slots.some(slot =>
      !Number.isSafeInteger(slot.position_seconds) ||
      slot.position_seconds < 1 ||
      !Number.isInteger(slot.ads_max_count) ||
      slot.ads_max_count < 1 ||
      slot.ads_max_count > 4 ||
      !slot.label.trim()
    );
    if (hasInvalidValue) {
      setError("Each ad slot needs a positive whole-number position, a label, and between 1 and 4 ads per break.");
      setSaving(false);
      return;
    }
    if (new Set(positions).size !== positions.length) {
      setError("Each ad slot must use a different position in the episode.");
      setSaving(false);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setError("Please sign in again.");
      setSaving(false);
      return;
    }

    const { error } = await supabase.from("ad_slots").upsert(
      slots.map(slot => ({
        owner_id: user.id,
        position_seconds: slot.position_seconds,
        ads_max_count: slot.ads_max_count,
        label: slot.label.trim(),
        enabled: slot.enabled,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "owner_id,position_seconds" },
    );

    if (error) {
      setError(error.message);
    } else {
      setNotice("Ad slots saved.");
      await load();
    }
    setSaving(false);
  }

  function update(index: number, changes: Partial<Slot>) {
    setSlots(current => current.map((slot, i) => i === index ? { ...slot, ...changes } : slot));
  }

  return <div className="dash-main">
    <div className="dash-top">
      <div>
        <p className="section-kicker">MONETISATION</p>
        <h1>Ad Slots</h1>
        <p>Choose as many ad break positions as you need across each episode.</p>
      </div>
      <span className="pill">{slots.filter(x => x.enabled).length} active</span>
    </div>

    <div className="panel">
      <div className="panel-heading-row">
        <div>
          <h2>Ad slot positions</h2>
          <p>Add ad breaks one at a time. There is no four-slot limit; use a different timestamp for each position.</p>
        </div>
        <button className="btn btn-outline" type="button" onClick={addSlot} disabled={saving || loading}>
          Add ad slot
        </button>
      </div>
    </div>

    <div className="panel">
      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p className="auth-notice" role="status">{notice}</p>}
      {loading ? <p>Loading ad slots…</p> : slots.length === 0 ? (
        <div>
          <p>No ad slots configured yet. Add your first ad break to get started.</p>
          <button className="btn btn-outline" type="button" onClick={addSlot} disabled={saving}>Add ad slot</button>
        </div>
      ) : (
        <div className="slot-list">
          {slots.map((slot, index) => (
            <div className="slot-row" key={slot.id ?? `new-${index}`}>
              <label>
                Position (seconds)
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={slot.position_seconds}
                  onChange={e => update(index, { position_seconds: Number(e.target.value) })}
                />
              </label>
              <label>
                Label
                <input value={slot.label} onChange={e => update(index, { label: e.target.value })} />
              </label>
              <label>
                Maximum ads per break (1–4)
                <input
                  type="number"
                  min={1}
                  max={4}
                  step={1}
                  value={slot.ads_max_count}
                  onChange={e => update(index, { ads_max_count: Number(e.target.value) })}
                />
              </label>
              <label className="check-label">
                <input type="checkbox" checked={slot.enabled} onChange={e => update(index, { enabled: e.target.checked })} />
                Enabled
              </label>
            </div>
          ))}
          <div className="integration-actions">
            <button className="btn btn-outline" type="button" onClick={addSlot} disabled={saving}>Add another ad slot</button>
            <button className="btn btn-primary" type="button" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save ad slots"}
            </button>
          </div>
        </div>
      )}
    </div>

    <div className="panel">
      <h2>Important</h2>
      <p>You can configure any number of different cue-point positions. The “Maximum ads per break” setting controls the ad count at each individual position. Actual ad insertion still depends on your Spreaker show’s monetisation settings and ad availability. Saving a slot does not itself guarantee that an ad will play.</p>
    </div>
  </div>;
}
