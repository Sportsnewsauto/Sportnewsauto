import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  const { data: workspace } = await supabase.from("workspaces").select("name, plan, daily_episode_limit, timezone").eq("owner_id", user.id).single();
  const { data: settings } = await supabase.from("workspace_settings").select("automation_enabled,publishing_mode").maybeSingle();
  const { data: connections } = await supabase.from("integration_connections").select("provider,status");
  const connectedCount = (connections ?? []).filter(item => item.status === "connected").length;
  const automationLabel = settings?.automation_enabled ? "Enabled" : "Paused";

  return (
    <section className="dash-main">
      <div className="dash-top"><div><h1>Dashboard overview</h1><p>Welcome, {user.email}. Your private workspace is ready.</p></div><span className="status">● Signed in</span></div>
      <div className="dash-cards">
        <div className="dash-card"><span>Episodes published today</span><strong>0 / {workspace?.daily_episode_limit ?? 1}</strong><small>Free plan daily allowance</small></div>
        <div className="dash-card"><span>Account plan</span><strong>{workspace?.plan ?? "Free"}</strong><small>Monthly subscription options coming later</small></div>
        <div className="dash-card"><span>Automation</span><strong>{automationLabel}</strong><small>{settings?.automation_enabled ? "Scheduled worker enabled" : "Enable it when account connections are ready"}</small></div>
      </div>
      <div className="panel"><h2>Your workspace</h2>
        <div className="connection"><span><strong>{workspace?.name ?? "My Podcast Workspace"}</strong><br/><small>Timezone: {workspace?.timezone ?? "Africa/Nairobi"}</small></span><span className="status">Private account</span></div>
        <p style={{color:"var(--muted)",fontSize:13}}>Your account and workspace are stored in your Supabase database. Only your signed-in account can read or update this workspace.</p>
      </div>
      <div className="panel"><h2>Next setup steps</h2>
        <div className="connection"><span><strong>AI and Spreaker connections</strong><br/><small>{connectedCount} of 3 provider connections verified. Open API Connections to connect Spreaker, Groq and Gemini.</small></span><span className={connectedCount === 3 ? "status" : "pill"}>{connectedCount}/3 verified</span></div>
        <div className="connection"><span><strong>Scheduled production</strong><br/><small>Choose feeds, set publishing times and enable scheduled generation when all services are ready.</small></span><span className="pill">{automationLabel}</span></div>
      </div>
    </section>
  );
}
