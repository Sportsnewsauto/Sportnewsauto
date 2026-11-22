import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { dispatchMultiTenantWorker } from "@/lib/server/github-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  const [jobResult, episodeResult] = await Promise.all([
    supabase
      .from("publishing_jobs")
      .select("id,status,created_at,updated_at,payload")
      .eq("owner_id", user.id)
      .eq("job_type", "generate_episode")
      .filter("payload->>source", "eq", "manual")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("episodes")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .in("status", ["draft", "queued", "processing", "ready", "published"]),
  ]);

  if (jobResult.error || episodeResult.error) {
    return NextResponse.json({ error: "Could not load your automation status. Refresh the dashboard." }, { status: 503 });
  }

  const payload = jobResult.data?.payload && typeof jobResult.data.payload === "object"
    ? jobResult.data.payload as Record<string, unknown>
    : {};

  return NextResponse.json({
    trial_available: (episodeResult.count ?? 0) === 0,
    job: jobResult.data ? {
      id: jobResult.data.id,
      status: jobResult.data.status,
      created_at: jobResult.data.created_at,
      updated_at: jobResult.data.updated_at,
      free_trial: payload.free_trial === true,
    } : null,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("request_manual_automation_run");
  if (error) {
    const message = error.message || "Could not queue a manual automation run.";
    const status = error.code === "42501" ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.job_id) {
    return NextResponse.json({ error: "The automation request did not return a job. Refresh and try again." }, { status: 503 });
  }

  // Queue creation is the source of truth. A dispatch problem must not discard
  // the accepted job; the five-minute scheduled worker remains the fallback.
  const workerDispatch = await dispatchMultiTenantWorker();
  const baseMessage = result.already_queued
    ? "An automation run is already queued."
    : result.free_trial
      ? "Your free trial episode has been queued."
      : "Your automation run has been queued.";

  const message = workerDispatch.dispatched
    ? `${baseMessage} The worker has been triggered to check it now.`
    : workerDispatch.reason === "not_configured"
      ? `${baseMessage} The worker will pick it up on its regular scheduled check. Immediate start is not configured yet.`
      : `${baseMessage} An immediate worker start could not be triggered; the regular scheduled check remains as a backup.`;

  return NextResponse.json({
    job: {
      id: result.job_id,
      status: "queued",
      free_trial: result.free_trial === true,
    },
    already_queued: result.already_queued === true,
    worker_triggered: workerDispatch.dispatched,
    message,
  }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
