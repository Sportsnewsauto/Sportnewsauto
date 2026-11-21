-- Security hardening for encrypted provider credentials and idempotent scheduled jobs.
-- Run this after 0001_accounts_and_workspaces.sql and 0002_workspace_configuration_and_jobs.sql.

-- Browser clients must never read or write encrypted credential rows directly.
drop policy if exists "Owners insert encrypted credentials" on public.integration_credentials;
drop policy if exists "Owners update encrypted credentials" on public.integration_credentials;
drop policy if exists "Owners delete encrypted credentials" on public.integration_credentials;
revoke all on table public.integration_credentials from anon, authenticated;

-- Authenticated owners remove their own encrypted credential only through this checked RPC.
create or replace function public.delete_integration_credential(p_provider text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_provider not in ('spreaker', 'groq', 'gemini') then
    raise exception 'Unsupported integration provider';
  end if;
  delete from public.integration_credentials
  where owner_id = auth.uid() and provider = p_provider;
end;
$$;

revoke all on function public.delete_integration_credential(text) from public;
grant execute on function public.delete_integration_credential(text) to authenticated;

alter table public.workspace_settings
  add column if not exists automation_enabled boolean not null default false;

-- Idempotency key for one generated episode per scheduled slot per workspace.
create unique index if not exists publishing_jobs_owner_type_schedule_unique
  on public.publishing_jobs(owner_id, job_type, scheduled_at);
