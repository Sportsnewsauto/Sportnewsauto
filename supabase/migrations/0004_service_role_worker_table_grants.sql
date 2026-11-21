-- Grant the backend worker the table privileges it needs.
-- The worker authenticates with the Supabase service_role key and bypasses RLS,
-- but PostgreSQL table privileges are still required.
-- This does not grant any additional access to anon or authenticated users.

grant usage on schema public to service_role;

grant select, insert, update, delete on table
  public.workspaces,
  public.workspace_settings,
  public.news_feeds,
  public.ad_slots,
  public.integration_credentials,
  public.integration_connections,
  public.episodes,
  public.publishing_jobs
to service_role;
