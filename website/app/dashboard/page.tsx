import Link from "next/link";

const navigation = [
  ["▦", "Overview"], ["⚿", "API Connections"], ["◉", "Podcast Settings"],
  ["▤", "Sports News Feeds"], ["✦", "AI Configuration"], ["♫", "Audio Settings"],
  ["▱", "Advertising"], ["◷", "Publishing Schedule"], ["☷", "Episodes"],
  ["▣", "Subscription"], ["?", "Support"]
];

export default function DashboardPreview() {
  return (
    <main className="dashboard-shell">
      <aside className="sidebar">
        <Link href="/" className="brand"><span className="brand-mark">◉</span><span>Automate Spreaker</span></Link>
        <div className="side-label">WORKSPACE</div>
        {navigation.map(([icon,label], index) => <div className={`side-link ${index === 0 ? "active" : ""}`} key={label}><span>{icon}</span>{label}</div>)}
        <div className="side-label">ACCOUNT</div>
        <div className="side-link">⚙ Settings</div>
        <div className="side-link">↪ Sign out</div>
      </aside>
      <section className="dash-main">
        <div className="dash-top"><div><h1>Dashboard overview</h1><p>Welcome to your podcast workspace.</p></div><span className="status">● Demo workspace</span></div>
        <div className="dash-cards">
          <div className="dash-card"><span>Episodes published today</span><strong>0 / 1</strong><small>Free plan daily allowance</small></div>
          <div className="dash-card"><span>Connected services</span><strong>0 / 3</strong><small>Connect your own accounts</small></div>
          <div className="dash-card"><span>Automation</span><strong>Paused</strong><small>Finish setup to activate</small></div>
        </div>
        <div className="panel"><h2>Connect your services</h2><p style={{color:"var(--muted)",fontSize:13}}>Your credentials are private to your account. Saved secrets will be encrypted and masked.</p>
          <div className="connection"><span><strong>Groq or Gemini</strong><br/><small>Connect at least one AI provider</small></span><span className="pill">Not connected</span></div>
          <div className="connection"><span><strong>Spreaker</strong><br/><small>Your access token and show ID</small></span><span className="pill">Not connected</span></div>
          <div className="connection"><span><strong>Platform audio</strong><br/><small>Kokoro text-to-speech service</small></span><span className="status">Platform provided</span></div>
        </div>
        <div className="panel"><h2>Choose how episodes are published</h2>
          <div className="connection"><span><strong>Automatic publishing</strong><br/><small>Publish after generation and validation.</small></span><span className="pill">Configure later</span></div>
          <div className="connection"><span><strong>Review before publishing</strong><br/><small>Hold completed episodes for your approval.</small></span><span className="pill">Configure later</span></div>
        </div>
        <p className="microcopy" style={{marginTop:18}}>This is a visual prototype. Sign-in, encrypted credential storage, scheduling and publishing are not connected yet.</p>
      </section>
    </main>
  );
}