import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import legacyAutomation from "@/data/legacy-sports-automation.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LegacyFeed = {
  name: string;
  feed_url: string;
  sport: string;
  league: string;
  enabled: boolean;
};

type LegacyStory = {
  story_id: string;
  title: string;
  url: string;
  source?: string;
  published_at?: string;
  spreaker_show_id?: string;
  spreaker_episode_id?: string;
  covered_at?: string;
};

const scheduledTimes = ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"];
const adSlots = [
  { position_seconds: 30, ads_max_count: 4, label: "Ad break at 30 seconds", enabled: true },
  { position_seconds: 60, ads_max_count: 4, label: "Ad break at 1 minute", enabled: true },
  { position_seconds: 120, ads_max_count: 4, label: "Ad break at 2 minutes", enabled: true },
  { position_seconds: 180, ads_max_count: 4, label: "Ad break at 3 minutes", enabled: true },
];

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Please sign in to the Admin account before importing the old automation." }, { status: 401 });
  }

  const adminEmail = process.env.AUTOMATION_ADMIN_EMAIL?.trim().toLowerCase();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!adminEmail || user.email?.toLowerCase() !== adminEmail) {
    return NextResponse.json({ error: "This import is restricted to the configured Admin account. Sign in with the Admin email." }, { status: 403 });
  }
  if (!secretKey || !supabaseUrl) {
    return NextResponse.json({ error: "Admin setup is incomplete. Add the server-only SUPABASE_SECRET_KEY and AUTOMATION_ADMIN_EMAIL to Vercel, then redeploy." }, { status: 503 });
  }

  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("daily_episode_limit")
    .eq("owner_id", user.id)
    .single();
  if (workspaceError || !workspace) {
    return NextResponse.json({ error: "Your workspace could not be found. Refresh the dashboard and try again." }, { status: 503 });
  }

  const { data: existingSettings, error: settingsReadError } = await supabase
    .from("workspace_settings")
    .select("*")
    .eq("owner_id", user.id)
    .maybeSingle();
  if (settingsReadError) {
    return NextResponse.json({ error: "Workspace settings are not ready. Check that Supabase migration 0002 has been applied." }, { status: 503 });
  }

  const feeds = (legacyAutomation.feeds as LegacyFeed[]).map((feed) => ({
    ...feed,
    owner_id: user.id,
    enabled: true,
    updated_at: new Date().toISOString(),
  }));
  const { error: feedError } = await supabase
    .from("news_feeds")
    .upsert(feeds, { onConflict: "owner_id,feed_url" });
  if (feedError) {
    return NextResponse.json({ error: "Could not import the existing sports news feeds. Check Supabase migration 0002 and try again." }, { status: 503 });
  }

  const settings = {
    owner_id: user.id,
    podcast_name: existingSettings?.podcast_name ?? "Sports News Podcast",
    podcast_description: existingSettings?.podcast_description ?? "",
    category: existingSettings?.category ?? "Sports",
    language: existingSettings?.language ?? "en",
    country: existingSettings?.country ?? "KE",
    spreaker_show_id: existingSettings?.spreaker_show_id ?? "",
    timezone: "Africa/Nairobi",
    ai_provider: existingSettings?.ai_provider ?? "groq",
    ai_model: existingSettings?.ai_model ?? "openai/gpt-oss-120b",
    ai_writing_instructions: existingSettings?.ai_writing_instructions ?? "",
    tts_provider: "kokoro",
    tts_voice: "af_heart",
    publishing_mode: "automatic",
    scheduled_times: scheduledTimes,
    // Keep the new workspace paused until the owner reconnects their own APIs.
    automation_enabled: false,
    updated_at: new Date().toISOString(),
  };
  const { error: settingsError } = await supabase
    .from("workspace_settings")
    .upsert(settings, { onConflict: "owner_id" });
  if (settingsError) {
    return NextResponse.json({ error: "Feeds were imported, but the schedule could not be saved. Run the import again after checking migration 0002." }, { status: 503 });
  }

  const { error: adError } = await supabase
    .from("ad_slots")
    .upsert(
      adSlots.map((slot) => ({ ...slot, owner_id: user.id, updated_at: new Date().toISOString() })),
      { onConflict: "owner_id,position_seconds" },
    );
  if (adError) {
    return NextResponse.json({ error: "Feeds and schedule were imported, but advertising positions could not be saved. Run the import again after checking migration 0002." }, { status: 503 });
  }

  const { data: previousEpisodes, error: episodeReadError } = await supabase
    .from("episodes")
    .select("spreaker_episode_id,source_data")
    .eq("owner_id", user.id)
    .limit(1000);
  if (episodeReadError) {
    return NextResponse.json({ error: "Automation settings were imported, but old episode history could not be checked. Run the import again after checking migration 0002." }, { status: 503 });
  }

  const existingStoryIds = new Set<string>();
  const existingSpreakerIds = new Set<string>();
  for (const episode of previousEpisodes ?? []) {
    if (episode.spreaker_episode_id) existingSpreakerIds.add(String(episode.spreaker_episode_id));
    const sourceData = episode.source_data && typeof episode.source_data === "object" ? episode.source_data as Record<string, unknown> : {};
    if (typeof sourceData.story_id === "string") existingStoryIds.add(sourceData.story_id);
  }

  const historyRows = (legacyAutomation.history as LegacyStory[])
    .filter((story) => story.story_id && story.spreaker_episode_id)
    .filter((story) => !existingStoryIds.has(story.story_id) && !existingSpreakerIds.has(String(story.spreaker_episode_id)))
    .map((story) => {
      const importedAt = story.covered_at || new Date().toISOString();
      return {
        owner_id: user.id,
        title: story.title || "Previous sports podcast episode",
        description: "Imported from the previous single-account sports podcast automation.",
        status: "published",
        spreaker_episode_id: String(story.spreaker_episode_id),
        source_data: {
          story_id: story.story_id,
          url: story.url,
          title: story.title,
          source: story.source ?? "",
          published_at: story.published_at ?? null,
          spreaker_show_id: story.spreaker_show_id ?? null,
          legacy_import: true,
        },
        generated_at: importedAt,
        published_at: importedAt,
        created_at: importedAt,
        updated_at: new Date().toISOString(),
      };
    });

  if (historyRows.length) {
    const { error: historyError } = await supabase.from("episodes").insert(historyRows);
    if (historyError) {
      return NextResponse.json({ error: "Your feeds and settings were imported, but episode history could not be copied. You can safely retry this import." }, { status: 503 });
    }
  }

  const adminHeaders: Record<string, string> = {
    apikey: secretKey,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
  if (!secretKey.startsWith("sb_secret_")) {
    adminHeaders.Authorization = `Bearer ${secretKey}`;
  }
  const adminUpdate = await fetch(
    `${supabaseUrl.endsWith("/") ? supabaseUrl.slice(0, -1) : supabaseUrl}/rest/v1/workspaces?owner_id=eq.${encodeURIComponent(user.id)}`,
    {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ plan: "admin", daily_episode_limit: 8, updated_at: new Date().toISOString() }),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!adminUpdate.ok) {
    return NextResponse.json({ error: "The automation was imported, but the Admin eight-episode allowance could not be assigned. Apply Supabase migration 0005 and try the import again." }, { status: 503 });
  }

  return NextResponse.json({
    success: true,
    imported: {
      feeds: feeds.length,
      ad_positions: adSlots.length,
      previous_episodes: historyRows.length,
      already_present_episodes: (legacyAutomation.history as LegacyStory[]).length - historyRows.length,
      scheduled_times: scheduledTimes,
      timezone: "Africa/Nairobi",
    },
    daily_episode_limit: 8,
    automation_enabled: false,
    credentials_imported: false,
    message: "Your existing sports automation settings were copied into this signed-in workspace. Connect this account's own Spreaker and AI credentials, choose its Spreaker show, then enable the schedule.",
  });
}
