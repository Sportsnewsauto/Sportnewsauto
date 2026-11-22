import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { dispatchMultiTenantWorker } from "@/lib/server/github-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wake the worker for an existing active manual job.
 * This never creates or re-queues an episode, so it is safe to retry.
 */
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

  const { data: job, error: jobError } = await supabase
    .from("publishing_jobs")
    .select("id,status")
    .eq("owner_id", user.id)
    .eq("job_type", "generate_episode")
    .in("status", ["queued", "processing"])
    .filter("payload->>source", "eq", "manual")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (jobError) {
    return NextResponse.json({ error: "Could not verify your active manual episode job." }, { status: 503 });
  }
  if (!job) {
    return NextResponse.json({
      error: "There is no active manual episode job to wake. No new episode was created.",
    }, { status: 409 });
  }

  const dispatch = await dispatchMultiTenantWorker();
  if (!dispatch.dispatched) {
    const error = dispatch.reason === "not_configured"
      ? "The GitHub App credentials are not available in the live Cloudflare Worker."
      : "GitHub did not accept the worker trigger. Check that the App is installed on this repository with Actions: read and write permission.";
    return NextResponse.json({ error }, { status: 502 });
  }

  return NextResponse.json({
    worker_triggered: true,
    job_id: job.id,
    message: "Worker triggered successfully to check your existing episode job. No duplicate episode was created.",
  }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
