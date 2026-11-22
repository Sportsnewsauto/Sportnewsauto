import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LegacyAutomationImport from "./legacy-automation-import";
import ManualAutomationRun from "./manual-automation-run";

function nextEstimatedRun(timezone: string, intervalHours: number): Date {
  const safeZone = (() => {
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); return timezone; }
    catch { return "Africa/Nairobi"; }
  })();
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  let year = Number(parts.year);
  let month = Number(parts.month);
  let day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const intervalMinutes = Math.max(1, intervalHours) * 60;
  let targetMinutes = (Math.floor((hour * 60 + minute) / intervalMinutes) + 1) * intervalMinutes;
  if (targetMinutes >= 1440) {
    targetMinutes -= 1440;
    const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
    year = nextDay.getUTCFullYear();
    month = nextDay.getUTCMonth() + 1;
    day = nextDay.getUTCDate();
  }
  const target = Date.UTC(year, month - 1, day, Math.floor(targetMinutes / 60), targetMinutes % 60);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const observed = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, part.value]));
    const observedAsUtc = Date.UTC(
      Number(observed.year), Number(observed.month) - 1, Number(observed.day),
      Number(observed.hour), Number(observed.minute),
    );
    guess += target - observedAsUtc;
  }
  return new Date(guess);
}

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  const { data: workspace } = await supabase.from("workspaces").select("name, plan, daily_episode_limit, timezone").eq("owner_id", user.id).single();
  const { data: settings } = await supabase.from("workspace_settings").select("automation_enabled,publishing_mode,publishing_interval_hours,timezone").maybeSingle();
  const requestedTimezone = settings?.timezone || workspace?.timezone || "Africa/Nairobi";
  const scheduleTimezone = (() => {
    try { new Intl.DateTimeFormat("en", { timeZone: requestedTimezone }); return requestedTimezone; }
    catch { return "Africa/Nairobi"; }
  })();
  const scheduleInterval = Number(settings?.publishing_interval_hours) || 8;
  const estimatedRun = settings?.automation_enabled
    ? new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: scheduleTimezone }).format(nextEstimatedRun(scheduleTimezone, scheduleInterval))
    : "Not scheduled — automation is paused.";
  const { data: connections } = await supabase.from("integration_connections").select("provider,status");
  const connectedCount = (connections ?? []).filter(item => item.status === "connected").length;
  const automationLabel = settings?.automation_enabled ? "Enabled" : "Paused";
  const adminEmail = process.env.AUTOMATION_ADMIN_EMAIL?.trim().toLowerCase();
  const isPlatformAdmin = Boolean(adminEmail && user.email?.toLowerCase() === adminEmail);

  return (
    <section className="dash-main">
      <div className="dash-top"><div><h1>Dashboard overview</h1><p>Welcome, {user.email}. Your private workspace is ready.</p></div><span className="status">● Signed in</span></div>
      <ManualAutomationRun />
      <div className="dash-cards">
        <div className="dash-card"><span>Episodes published today</span><strong>0 / {workspace?.daily_episode_limit ?? 1}</strong><small>{workspace?.plan === "admin" ? "Admin daily allowance" : "Free plan daily allowance"}</small></div>
        <div className="dash-card"><span>Account plan</span><strong>{workspace?.plan ? workspace.plan.charAt(0).toUpperCase() + workspace.plan.slice(1) : "Free"}</strong><small>{workspace?.plan === "admin" ? "Platform Admin workspace" : "Monthly subscription options coming later"}</small></div>
        <div className="dash-card"><span>Automation</span><strong>{automationLabel}</strong><small>{settings?.automation_enabled ? "Scheduled worker enabled" : "Enable it when account connections are ready"}</small></div>
        <div className="dash-card"><span>Next estimated run</span><strong>{settings?.automation_enabled ? estimatedRun : "Paused"}</strong><small>{settings?.automation_enabled ? `Every ${scheduleInterval} hours · ${scheduleTimezone}` : estimatedRun}</small></div>
      </div>
      {isPlatformAdmin && <LegacyAutomationImport />}
      <div className="panel"><h2>Your workspace</h2>
        <div className="connection"><span><strong>{workspace?.name ?? "My Podcast Workspace"}</strong><br/><small>Timezone: {workspace?.timezone ?? "Africa/Nairobi"}</small></span><span className="status">Private account</span></div>
        <p style={{color:"var(--muted)",fontSize:13}}>Your account and workspace are stored in your Supabase database. Only your signed-in account can read or update this workspace.</p>
      </div>
      <div className="panel"><h2>Next setup steps</h2>
        <div className="connection"><span><strong>AI and Spreaker connections</strong><br/><small>{connectedCount} of 3 provider connections verified. Open API Connections to connect Spreaker, Groq and Gemini.</small></span><span className={connectedCount === 3 ? "status" : "pill"}>{connectedCount}/3 verified</span></div>
        <div className="connection"><span><strong>Scheduled production</strong><br/><small>Add your RSS feed, choose a publishing interval and enable scheduled generation when all services are ready.</small></span><span className="pill">{automationLabel}</span></div>
      </div>
    </section>
  );
}
