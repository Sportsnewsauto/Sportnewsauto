-- Active paid customer workspaces receive the full customer-facing voice library.
-- Admin-only platform controls remain separate from paid customer entitlements.

create or replace function public.enforce_workspace_kokoro_voice_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_plan text;
  workspace_subscription_status text;
  workspace_subscription_expires_at timestamptz;
begin
  if new.tts_voice in ('af_heart', 'am_michael') then
    select
      w.plan,
      w.subscription_status,
      w.subscription_expires_at
    into
      workspace_plan,
      workspace_subscription_status,
      workspace_subscription_expires_at
    from public.workspaces as w
    where w.owner_id = new.owner_id;

    if coalesce(workspace_plan, 'free') <> 'admin'
      and not (
        workspace_plan in ('pro', 'business')
        and workspace_subscription_status = 'active'
        and workspace_subscription_expires_at > now()
      )
    then
      raise exception 'Kokoro voice % requires an active paid subscription.', new.tts_voice
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_workspace_kokoro_voice_access() from public;

comment on function public.enforce_workspace_kokoro_voice_access() is
  'Allows all customer voices on active paid workspaces; free accounts are restricted to Bella and platform Admin retains its own access.';
