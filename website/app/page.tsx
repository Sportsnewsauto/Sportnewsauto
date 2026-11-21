import Link from "next/link";

const features = [
  ["◉", "Sports news collection", "Choose sports, leagues and RSS feeds. Bring your own trusted sources into one workflow."],
  ["✦", "AI script generation", "Connect your Groq or Gemini account to turn selected news into narration-ready podcast scripts."],
  ["♫", "Platform audio generation", "Generate spoken episodes using the platform's hosted Kokoro text-to-speech engine."],
  ["◷", "Flexible scheduling", "Choose publishing times and your timezone. Paid plans can unlock higher daily episode limits."],
  ["▣", "Your Spreaker account", "Connect your own Spreaker show and publish episodes to your own audience."],
  ["✓", "Review or automate", "Choose automatic publishing or hold each finished episode for your approval."]
];

export default function HomePage() {
  return (
    <>
      <header className="site-header">
        <div className="container nav">
          <Link href="/" className="brand"><span className="brand-mark">◉</span><span>Automate Spreaker Podcast</span></Link>
          <nav className="nav-links"><a href="#features">Features</a><a href="#how-it-works">How it works</a><a href="#pricing">Pricing</a></nav>
          <div className="nav-actions"><Link className="btn btn-outline" href="/login">Sign in</Link><Link className="btn btn-primary" href="/signup">Get started free</Link></div>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="container hero-grid">
            <div>
              <span className="eyebrow">PODCAST PRODUCTION, AUTOMATED</span>
              <h1>Your podcast.<br/>Your voice.<br/><span style={{color:"var(--blue)"}}>Your automation.</span></h1>
              <p className="hero-copy">Create, produce and publish podcast episodes automatically. Connect your own AI and Spreaker accounts, choose your sports coverage, and let the workflow do the heavy lifting.</p>
              <div className="hero-actions"><Link className="btn btn-primary" href="/signup">Start with the free plan →</Link><a className="btn btn-outline" href="#how-it-works">See how it works</a></div>
              <p className="microcopy">Free plan includes one episode per day. Bring your own Groq or Gemini and Spreaker credentials.</p>
            </div>
            <div className="preview">
              <div className="preview-top"><span>Podcast overview</span><span className="status">● Automation ready</span></div>
              <p className="preview-title">YOUR WORKSPACE · SAMPLE PREVIEW</p>
              <div className="stat-grid">
                <div className="stat"><span>Episodes today</span><strong>1 / 1</strong></div>
                <div className="stat"><span>Connected services</span><strong>3</strong></div>
                <div className="stat"><span>Next run</span><strong>09:00</strong></div>
              </div>
              <p className="preview-title">RECENT ACTIVITY</p>
              <div className="activity">
                <div className="activity-row"><span>Sports news collected</span><small>Ready</small></div>
                <div className="activity-row"><span>Script and audio generated</span><small>Complete</small></div>
                <div className="activity-row"><span>Spreaker publishing</span><small>Awaiting setup</small></div>
              </div>
              <p className="microcopy">Illustrative preview — not live account data.</p>
            </div>
          </div>
        </section>

        <section className="section" id="features">
          <div className="container">
            <div className="section-head"><span className="eyebrow">ALL IN ONE WORKFLOW</span><h2>From sports headlines to published episodes</h2><p>Bring your own AI credentials and Spreaker account. The platform manages the production workflow and hosted audio generation.</p></div>
            <div className="feature-grid">{features.map(([icon,title,description]) => <article className="feature" key={title}><div className="feature-icon">{icon}</div><h3>{title}</h3><p>{description}</p></article>)}</div>
          </div>
        </section>

        <section className="section section-soft" id="how-it-works">
          <div className="container">
            <div className="section-head"><span className="eyebrow">GET STARTED IN FOUR STEPS</span><h2>Simple to set up. Easy to manage.</h2><p>Your private dashboard keeps your settings, credentials and podcast activity separate from every other user.</p></div>
            <div className="steps">
              <article className="step"><span className="step-number">STEP 01</span><h3>Create your account</h3><p>Register and open your private podcast workspace.</p></article>
              <article className="step"><span className="step-number">STEP 02</span><h3>Connect your services</h3><p>Add your own Groq or Gemini key and Spreaker credentials.</p></article>
              <article className="step"><span className="step-number">STEP 03</span><h3>Configure your show</h3><p>Select feeds, narration settings, schedule and publishing mode.</p></article>
              <article className="step"><span className="step-number">STEP 04</span><h3>Publish your episodes</h3><p>Let episodes publish automatically or review them first.</p></article>
            </div>
          </div>
        </section>

        <section className="section" id="pricing">
          <div className="container">
            <div className="section-head"><span className="eyebrow">SIMPLE MONTHLY PLANS</span><h2>Start free. Upgrade when you grow.</h2><p>Subscription limits apply to platform automation. Your AI provider usage is billed separately by your own provider.</p></div>
            <div className="pricing-grid">
              <article className="plan"><h3>Free</h3><p>Try the complete workflow on a smaller schedule.</p><div className="price">$0 <small>/ month</small></div><ul><li>1 episode per day</li><li>One podcast workspace</li><li>Bring your own AI keys</li><li>Your own Spreaker account</li><li>Hosted Kokoro audio generation</li></ul><Link className="btn btn-outline" href="/signup">Start free</Link></article>
              <article className="plan featured"><span className="eyebrow">POPULAR CHOICE</span><h3 style={{marginTop:14}}>Pro</h3><p>For creators who want a more active publishing schedule.</p><div className="price">Coming soon</div><ul><li>Higher daily episode allowance</li><li>Expanded sports feed controls</li><li>Advanced scheduling</li><li>Automatic or approval publishing</li><li>Extended episode history</li></ul><a className="btn btn-primary" href="mailto:hello@automatespreakerpodcast.com">Join the waitlist</a></article>
              <article className="plan"><h3>Business</h3><p>For teams managing multiple podcast shows.</p><div className="price">Coming soon</div><ul><li>Multiple podcast workspaces</li><li>Higher automation allowances</li><li>Team access options</li><li>Advanced reporting</li><li>Priority support</li></ul><a className="btn btn-outline" href="mailto:hello@automatespreakerpodcast.com">Contact us</a></article>
            </div>
          </div>
        </section>

        <section className="section section-soft"><div className="container"><div className="callout"><div><h2>Ready to automate your podcast?</h2><p>Start with one episode a day and build your workflow at your own pace.</p></div><Link className="btn btn-primary" href="/signup">Explore the dashboard →</Link></div></div></section>
      </main>
      <footer className="site-footer"><div className="container footer-inner"><span>© {new Date().getFullYear()} Automate Spreaker Podcast</span><span>Built for independent podcast creators.</span></div></footer>
    </>
  );
}