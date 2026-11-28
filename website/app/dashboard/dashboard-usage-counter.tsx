"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getLocalDayBounds } from "@/lib/timezone";

type DashboardUsageCounterProps = {
  initialCount: number | null;
  initialCheckedAt: string;
  initialError?: boolean;
  timezone: string;
  isAdmin: boolean;
};

export default function DashboardUsageCounter({
  initialCount,
  initialCheckedAt,
  initialError = false,
  timezone,
  isAdmin,
}: DashboardUsageCounterProps) {
  const supabase = useMemo(() => createClient(), []);
  const [count, setCount] = useState<number | null>(initialCount);
  const [lastUpdated, setLastUpdated] = useState<string | null>(initialCheckedAt);
  const [refreshError, setRefreshError] = useState(initialError);

  useEffect(() => {
    let active = true;

    async function refreshCount() {
      if (document.visibilityState === "hidden") return;

      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !user) {
        if (active) setRefreshError(true);
        return;
      }

      const bounds = getLocalDayBounds(timezone);
      const { count: publishedCount, error } = await supabase
        .from("episodes")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", user.id)
        .eq("status", "published")
        .not("published_at", "is", null)
        .gte("published_at", bounds.start.toISOString())
        .lt("published_at", bounds.end.toISOString());

      if (!active) return;
      if (error || publishedCount === null) {
        setRefreshError(true);
        return;
      }

      setCount(publishedCount);
      setLastUpdated(new Date().toISOString());
      setRefreshError(false);
    }

    void refreshCount();
    const interval = window.setInterval(() => void refreshCount(), 15_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshCount();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onVisibilityChange);
    };
  }, [supabase, timezone]);

  const updatedLabel = lastUpdated
    ? new Intl.DateTimeFormat("en-KE", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(lastUpdated))
    : null;

  return (
    <>
      <strong>{count === null ? "—" : count.toLocaleString()}</strong>
      <small aria-live="polite">
        {refreshError
          ? "Live update unavailable — showing the last verified count."
          : updatedLabel
            ? `Live · updated at ${updatedLabel} · ${timezone}`
            : "Checking the latest published count…"}
        {isAdmin ? " · Admin: unlimited" : ""}
      </small>
    </>
  );
}
