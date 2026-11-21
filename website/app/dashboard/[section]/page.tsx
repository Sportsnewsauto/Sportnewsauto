import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SectionWorkspace from "../section-workspace";
import IntegrationManager from "../integration-manager";
import FeedsManager from "../feeds-manager";
import AdvertisingManager from "../advertising-manager";

const supportedSections = new Set([
  "api-connections", "podcast-settings", "sports-news-feeds",
  "ai-configuration", "audio-settings", "advertising",
  "publishing-schedule", "episodes", "subscription", "support", "settings",
]);

export default async function DashboardSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!supportedSections.has(section)) notFound();

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");

  if (section === "api-connections") {
    return <section className="dash-main">
      <div className="dash-top"><div><p className="section-kicker">INTEGRATIONS</p><h1>API Connections</h1><p>Save your Spreaker, Groq and Gemini credentials to your private account.</p></div><span className="pill">Encrypted vault</span></div>
      <IntegrationManager />
    </section>;
  }
  if (section === "sports-news-feeds") return <FeedsManager />;
  if (section === "advertising") return <AdvertisingManager />;

  return <SectionWorkspace section={section as "podcast-settings" | "ai-configuration" | "audio-settings" | "publishing-schedule" | "episodes" | "subscription" | "support" | "settings"} />;
}
