import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const sections: Record<string, { title: string; description: string; details: string[] }> = {
  "api-connections": {
    title: "API Connections",
    description: "Connect Spreaker and your AI providers when secure credential storage is ready.",
    details: ["Spreaker account connection", "Groq or Gemini provider connection", "Encrypted server-side storage and connection tests"],
  },
  "podcast-settings": {
    title: "Podcast Settings",
    description: "Podcast identity and show preferences will be managed here.",
    details: ["Podcast name and description", "Show and publishing preferences", "Workspace defaults"],
  },
  "sports-news-feeds": {
    title: "Sports News Feeds",
    description: "Choose the sports, leagues and trusted public feeds used to prepare episode content.",
    details: ["Sports and league selection", "RSS feed management", "Source review and duplicate checks"],
  },
  "ai-configuration": {
    title: "AI Configuration",
    description: "Choose and configure the AI provider used to turn sports stories into narration-ready scripts.",
    details: ["Groq or Gemini provider settings", "Script style and length", "Source-grounded writing rules"],
  },
  "audio-settings": {
    title: "Audio Settings",
    description: "Audio generation preferences will be configured here.",
    details: ["Platform-hosted Kokoro text-to-speech", "Voice and narration preferences", "Audio output settings"],
  },
  advertising: {
    title: "Advertising",
    description: "Manage ad placements and episode advertising rules here once ad insertion is implemented.",
    details: ["Ad slot planning", "Ad timing and frequency", "Ad content and playback checks"],
  },
  "publishing-schedule": {
    title: "Publishing Schedule",
    description: "Set the times and publishing mode for automated episodes.",
    details: ["Daily publishing schedule", "Automatic or review-before-publishing mode", "Timezone and episode limits"],
  },
  episodes: {
    title: "Episodes",
    description: "Your generated, reviewed and published podcast episodes will appear here when episode processing is connected.",
    details: ["Draft and ready-to-publish episodes", "Audio preview and review", "Publishing history"],
  },
  subscription: {
    title: "Subscription",
    description: "Your workspace currently uses the free plan. Paid subscriptions and billing are not connected yet.",
    details: ["Current plan and daily episode limit", "Monthly plan options", "Billing and invoices when payments are implemented"],
  },
  support: {
    title: "Support",
    description: "Support resources and contact options will be added here.",
    details: ["Setup guidance", "Troubleshooting", "Contact and help resources"],
  },
  settings: {
    title: "Account Settings",
    description: "Manage your profile and workspace preferences here when settings are implemented.",
    details: ["Profile details", "Workspace name and timezone", "Account security preferences"],
  },
};

export default async function DashboardSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const content = sections[section];
  if (!content) notFound();

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");

  return (
    <section className="dash-main">
      <div className="dash-top">
        <div>
          <p className="section-kicker">WORKSPACE</p>
          <h1>{content.title}</h1>
          <p>{content.description}</p>
        </div>
        <span className="pill">Coming soon</span>
      </div>
      <div className="panel section-placeholder">
        <span className="eyebrow">SECTION CREATED</span>
        <h2>This section is not connected yet</h2>
        <p>The navigation now works, but this feature still needs its forms, database actions and automation built. We will add those before asking you to connect external accounts or publish episodes.</p>
        <h3>Planned here</h3>
        <ul>{content.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
        {section === "api-connections" && <p className="security-note">Do not paste Spreaker, Groq or Gemini secret keys into this page. The secure credential vault has not been implemented yet.</p>}
        <Link className="btn btn-outline" href="/dashboard">Back to overview</Link>
      </div>
    </section>
  );
}
