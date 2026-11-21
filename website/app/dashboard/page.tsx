import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SignOutButton from "./sign-out-button";

const navigation = [
  ["▦", "Overview"], ["⚿", "API Connections"], ["◉", "Podcast Settings"],
  ["▤", "Sports News Feeds"], ["✦", "AI Configuration"], ["♫", "Audio Settings"],
  ["▱", "Advertising"], ["◷", "Publishing Schedule"], ["☷", "Episodes"],
  ["▣", "Subscription"], ["?", "Support"]
];

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  const { data: workspace } = await supabase.from("workspaces").select("name, plan, daily_episode_limit, timezone").eq("owner_id", user.id).single();

  return (
    <main className="dashboard-shell">
      <aside className="sidebar">
        <Link href="/" className="brand"><span className="brand-mark">◉</span><span>Automate Spreaker</span></Link>
        <div className="side-label">WORKSPACE</div>
        {navigation.map(([icon, label], index) => <div className={`side-link ${index === 0 ? "active" : ""}`} key={label}><span>{icon}</span>{label}</div>)}
        <div className="side-label">ACCOUNT</div>
        <div className="side-link">⚙ Settings</div>
        <SignOutButton />
      </aside>
      <section className="dash-main">
        <div className="dash-top"><div><h1>Dashboard overview</h1><p>Welcome, {user.email}. Your private workspace is ready.</p></div><span className="status">● Signed in</span></div>
        <div className="dash-cards">
          <div className="dash-card"><span>Episodes published today</span><strong>0 / {workspace?.daily_episode_limit ?? 1}</strong><small>Free plan daily allowance</small></div>
          <div className="dash-card"><span>Account plan</span><strong>{workspace?.plan ?? "Free"}</strong><small>Monthly subscription options coming later</small></div>
          <div className="dash-card"><span>Automation</span><strong>Not configured</strong><small>Connect services in a later setup step</small></div>
        </div>
        <div className="panel"><h2>Your workspace</h2>
          <div className="connection"><span><strong>{workspace?.name ?? "My Podcast Workspace"}</strong><br/><small>Timezone: {workspace?.timezone ?? "Africa/Nairobi"}</small></span><span className="status">Private account</span></div>
          <p style={{color:"var(--muted)",fontSize:13}}>Your account and workspace are now stored in your Supabase database. Only your signed-in account can read or update this workspace.</p>
        </div>
        <div className="panel"><h2>Next setup steps</h2>
          <div className="connection"><span><strong>AI and Spreaker connections</strong><br/><small>Secure server-side credential storage will be added before asking you for API keys.</small></span><span className="pill">Coming next</span></div>
          <div className="connection"><span><strong>Podcast schedule and publishing</strong><br/><small>Configure automatic publishing or review each episode first.</small></span><span className="pill">Coming next</span></div>
        </div>
      </section>
    </main>
  );
}
