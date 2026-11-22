import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isMpesaConfigured } from "@/lib/server/supabase-admin";
import { isFlutterwaveConfigured } from "@/lib/server/flutterwave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  const { data: workspace, error } = await supabase
    .from("workspaces")
    .select("plan,subscription_interval,subscription_status,subscription_expires_at,daily_episode_limit,monthly_episode_limit,timezone")
    .eq("owner_id", user.id)
    .maybeSingle();

  if (error || !workspace) {
    return NextResponse.json({ error: "Your Podcasti workspace could not be loaded." }, { status: 503 });
  }

  const now = Date.now();
  const isAdmin = workspace.plan === "admin";
  const expiry = workspace.subscription_expires_at ? Date.parse(workspace.subscription_expires_at) : 0;
  const isPaid = isAdmin || (
    ["pro", "business"].includes(workspace.plan) &&
    workspace.subscription_status === "active" &&
    expiry > now
  );
  const effectivePlan = isAdmin ? "admin" : isPaid ? "pro" : "free";
  const daysRemaining = isPaid && !isAdmin
    ? Math.max(0, Math.ceil((expiry - now) / 86400000))
    : null;

  const thirtyDaysAgo = new Date(now - 30 * 86400000).toISOString();
  const [feedCount, freeEpisodeCount, episode30Count, todayCount] = await Promise.all([
    supabase.from("news_feeds").select("id", { count: "exact", head: true }).eq("owner_id", user.id),
    supabase.from("publishing_jobs").select("id", { count: "exact", head: true })
      .eq("owner_id", user.id).eq("job_type", "generate_episode")
      .filter("payload->>source", "eq", "manual").neq("status", "cancelled"),
    supabase.from("episodes").select("id", { count: "exact", head: true })
      .eq("owner_id", user.id).gte("created_at", thirtyDaysAgo)
      .in("status", ["draft", "queued", "processing", "ready", "published"]),
    supabase.from("episodes").select("id", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .gte("created_at", new Date(now - 86400000).toISOString())
      .in("status", ["draft", "queued", "processing", "ready", "published"]),
  ]);

  let pendingPayment: Record<string, unknown> | null = null;
  if (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const admin = createAdminClient();
      const { data } = await admin.from("billing_payments")
        .select("id,plan_interval,amount_ksh,status,payment_provider,created_at,result_description")
        .eq("owner_id", user.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      pendingPayment = data ?? null;
    } catch {
      pendingPayment = null;
    }
  }

  return NextResponse.json({
    plan: effectivePlan,
    is_paid: isPaid,
    subscription_interval: isAdmin ? null : workspace.subscription_interval,
    subscription_status: isAdmin ? "active" : isPaid ? "active" : "inactive",
    subscription_expires_at: isAdmin ? null : workspace.subscription_expires_at,
    days_remaining: daysRemaining,
    usage: {
      feeds: feedCount.count ?? 0,
      feeds_limit: isAdmin ? null : isPaid ? 20 : 2,
      free_episodes_used: freeEpisodeCount.count ?? 0,
      free_episodes_limit: isPaid ? null : 1,
      free_episodes_remaining: isPaid ? null : Math.max(0, 1 - (freeEpisodeCount.count ?? 0)),
      episodes_last_30_days: episode30Count.count ?? 0,
      episodes_30_day_limit: isAdmin ? null : isPaid ? 180 : null,
      episodes_today: todayCount.count ?? 0,
      episodes_daily_limit: isAdmin ? null : isPaid ? 6 : null,
    },
    mpesa_ready: isMpesaConfigured() && Boolean(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY),
    flutterwave_ready: isFlutterwaveConfigured() && Boolean(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY),
    pending_payment: pendingPayment,
  }, { headers: { "Cache-Control": "no-store" } });
}
