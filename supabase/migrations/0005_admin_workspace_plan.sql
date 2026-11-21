-- Add a protected Admin workspace tier for the platform owner's legacy automation.
-- Only the server-side Admin import endpoint may assign this plan using the
-- Supabase secret key. Authenticated users remain blocked by the existing
-- restrict_workspace_plan_changes trigger.

alter table public.workspaces
  drop constraint if exists workspaces_plan_check;

alter table public.workspaces
  add constraint workspaces_plan_check
  check (plan in ('free', 'pro', 'business', 'admin'));
