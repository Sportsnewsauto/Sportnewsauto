-- Paid Podcasti workspaces receive six episodes per day and 180 per rolling 30 days.
-- Free workspaces retain three lifetime manual runs; Admin remains unrestricted.

create or replace function public.sync_workspace_episode_allowances()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new.plan, 'free') = 'admin' then
    return new;
  end if;

  if new.plan in ('pro', 'business')
    and new.subscription_status = 'active'
    and new.subscription_expires_at > now()
  then
    new.daily_episode_limit := 6;
    new.monthly_episode_limit := 180;
  else
    new.daily_episode_limit := 3;
    new.monthly_episode_limit := 3;
  end if;

  return new;
end;
$$;

revoke all on function public.sync_workspace_episode_allowances() from public, anon, authenticated;

-- Run after the existing plan-protection trigger so the trusted persisted plan
-- determines the quota. Corrects M-Pesa and Flutterwave activation values too.
drop trigger if exists zz_sync_workspace_episode_allowances on public.workspaces;
create trigger zz_sync_workspace_episode_allowances
  before insert or update on public.workspaces
  for each row execute function public.sync_workspace_episode_allowances();

-- Apply the new allowances to workspaces that are already active and paid.
update public.workspaces
set updated_at = now()
where plan <> 'admin';

comment on column public.workspaces.daily_episode_limit is
  'Daily episode limit: 6 for active paid subscriptions, 3 for Free workspaces; Admin is unrestricted.';
comment on column public.workspaces.monthly_episode_limit is
  'Rolling 30-day episode limit: 180 for active paid subscriptions, 3 for Free workspaces; Admin is unrestricted.';
