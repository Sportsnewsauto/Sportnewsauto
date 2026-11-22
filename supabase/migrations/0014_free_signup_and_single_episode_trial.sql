-- One Free signup per public IP, temporary-email blocking support,
-- and one successful Free episode for the lifetime of each account.

create table if not exists public.free_signup_ip_claims (
  ip_hash text primary key check (ip_hash ~ '^[0-9a-f]{64}$'),
  claim_token uuid unique,
  owner_id uuid unique references auth.users(id) on delete set null,
  expires_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint free_signup_ip_claim_state_check check (
    (claim_token is null and expires_at is null)
    or (claim_token is not null and expires_at is not null)
  )
);

alter table public.free_signup_ip_claims enable row level security;
revoke all on public.free_signup_ip_claims from public, anon, authenticated;
grant select, insert, update, delete on public.free_signup_ip_claims to service_role;

comment on table public.free_signup_ip_claims is
  'Stores keyed HMAC hashes of public client IP addresses to enforce one Free signup per IP. Raw IP addresses are never stored. Claimed hashes remain reserved if the Auth user is deleted.';

-- Require an unexpired one-time IP claim before any new Auth user can receive
-- a Podcasti profile and workspace. This prevents bypassing the server signup route.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim_token_text text;
  v_claim_token uuid;
  v_ip_hash text;
begin
  v_claim_token_text := new.raw_user_meta_data ->> 'free_signup_claim_token';
  if v_claim_token_text is null
    or v_claim_token_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    raise exception 'Please create your account through the Podcasti signup page.'
      using errcode = '42501';
  end if;
  v_claim_token := v_claim_token_text::uuid;

  select c.ip_hash
    into v_ip_hash
    from public.free_signup_ip_claims as c
    where c.claim_token = v_claim_token
      and c.owner_id is null
      and c.expires_at > now()
    for update;

  if not found then
    raise exception 'This signup reservation is invalid or expired. Please try again.'
      using errcode = '42501';
  end if;

  update public.free_signup_ip_claims
    set owner_id = new.id,
        claim_token = null,
        expires_at = null,
        claimed_at = now()
    where ip_hash = v_ip_hash
      and claim_token = v_claim_token
      and owner_id is null;

  if not found then
    raise exception 'This network has already used its Free signup.'
      using errcode = '42501';
  end if;

  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', ''));

  insert into public.workspaces (owner_id, name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'workspace_name', ''), 'My Podcast Workspace')
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Free workspace columns show the single-episode allowance. Paid plans keep
-- six per day and 180 per rolling 30 days. Admin remains unrestricted.
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
    new.daily_episode_limit := 1;
    new.monthly_episode_limit := 1;
  end if;

  return new;
end;
$$;

revoke all on function public.sync_workspace_episode_allowances() from public, anon, authenticated;

drop trigger if exists zz_sync_workspace_episode_allowances on public.workspaces;
create trigger zz_sync_workspace_episode_allowances
  before insert or update on public.workspaces
  for each row execute function public.sync_workspace_episode_allowances();

update public.workspaces
set updated_at = now()
where plan <> 'admin';

comment on column public.workspaces.daily_episode_limit is
  'Daily episode limit: 6 for active paid subscriptions and 1 for Free workspaces; Admin is unrestricted. Free is also capped at one lifetime successful episode.';
comment on column public.workspaces.monthly_episode_limit is
  'Rolling 30-day episode limit: 180 for active paid subscriptions and 1 for Free workspaces; Admin is unrestricted. Free is also capped at one lifetime successful episode.';

-- Atomically prevent additional non-failed episodes on Free accounts, even if
-- a client inserts a job directly instead of calling the manual-run RPC.
create or replace function public.enforce_free_workspace_lifetime_episode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan text;
  v_subscription_status text;
  v_subscription_expires_at timestamptz;
  v_is_paid boolean;
begin
  select w.plan, w.subscription_status, w.subscription_expires_at
    into v_plan, v_subscription_status, v_subscription_expires_at
    from public.workspaces as w
    where w.owner_id = new.owner_id
    for update;

  if not found then
    raise exception 'The podcast workspace for this episode could not be found.';
  end if;

  v_is_paid := v_plan in ('pro', 'business')
    and v_subscription_status = 'active'
    and v_subscription_expires_at > now();

  if v_plan = 'admin' or coalesce(v_is_paid, false) then
    return new;
  end if;

  if new.status in ('draft', 'queued', 'processing', 'ready', 'published')
    and exists (
      select 1
      from public.episodes as e
      where e.owner_id = new.owner_id
        and e.id is distinct from new.id
        and e.status in ('draft', 'queued', 'processing', 'ready', 'published')
    )
  then
    raise exception 'The one Free lifetime episode has already been used. Upgrade to continue generating episodes.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_free_workspace_lifetime_episode() from public, anon, authenticated;

drop trigger if exists enforce_free_workspace_lifetime_episode on public.episodes;
create trigger enforce_free_workspace_lifetime_episode
  before insert or update of status on public.episodes
  for each row execute function public.enforce_free_workspace_lifetime_episode();

-- The manual queue endpoint also blocks an exhausted Free workspace before
-- spending AI or audio-generation resources. Failed attempts do not consume it.
create or replace function public.request_manual_automation_run()
returns table(job_id uuid, free_trial boolean, already_queued boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_plan text;
  v_subscription_status text;
  v_subscription_expires_at timestamptz;
  v_is_paid boolean;
  v_daily_limit integer;
  v_workspace_timezone text;
  v_settings_timezone text;
  v_show_id text;
  v_day_start timestamptz;
  v_used_today integer;
  v_existing_job_id uuid;
  v_existing_trial boolean;
  v_job_id uuid;
  v_free_trial boolean;
begin
  v_owner_id := auth.uid();
  if v_owner_id is null then
    raise exception 'Please sign in before running the automation.'
      using errcode = '42501';
  end if;

  -- Serialize requests for this workspace to prevent duplicate queued runs.
  select w.plan, w.subscription_status, w.subscription_expires_at,
         w.daily_episode_limit, w.timezone
    into v_plan, v_subscription_status, v_subscription_expires_at,
         v_daily_limit, v_workspace_timezone
    from public.workspaces as w
    where w.owner_id = v_owner_id
    for update;

  if not found then
    raise exception 'Your podcast workspace could not be found.';
  end if;

  v_is_paid := v_plan in ('pro', 'business')
    and v_subscription_status = 'active'
    and v_subscription_expires_at > now();

  select s.timezone, s.spreaker_show_id
    into v_settings_timezone, v_show_id
    from public.workspace_settings as s
    where s.owner_id = v_owner_id;

  if not found then
    raise exception 'Complete your podcast settings before running the automation.';
  end if;

  if coalesce(btrim(v_show_id), '') = '' then
    raise exception 'Connect Spreaker and select your show before running the automation.';
  end if;

  if not exists (
    select 1 from public.news_feeds as f
    where f.owner_id = v_owner_id and f.enabled = true
  ) then
    raise exception 'Add and enable at least one RSS feed before running the automation.';
  end if;

  if not exists (
    select 1
    from public.integration_connections as c
    join public.integration_credentials as k
      on k.owner_id = c.owner_id and k.provider = c.provider
    where c.owner_id = v_owner_id
      and c.provider = 'spreaker'
      and c.status = 'connected'
  ) then
    raise exception 'Connect and verify your Spreaker account before running the automation.';
  end if;

  if not exists (
    select 1
    from public.integration_connections as c
    join public.integration_credentials as k
      on k.owner_id = c.owner_id and k.provider = c.provider
    where c.owner_id = v_owner_id
      and c.provider in ('groq', 'gemini')
      and c.status = 'connected'
  ) then
    raise exception 'Connect and verify your Groq or Gemini API key before running the automation.';
  end if;

  -- Return an existing generation job rather than enqueueing another one.
  select j.id, (j.payload ->> 'free_trial') = 'true'
    into v_existing_job_id, v_existing_trial
    from public.publishing_jobs as j
    where j.owner_id = v_owner_id
      and j.job_type = 'generate_episode'
      and j.status in ('queued', 'processing')
      and j.payload ->> 'source' = 'manual'
    order by j.created_at desc
    limit 1;

  if found then
    return query select v_existing_job_id, coalesce(v_existing_trial, false), true;
    return;
  end if;

  if exists (
    select 1 from public.publishing_jobs as j
    where j.owner_id = v_owner_id
      and j.job_type = 'generate_episode'
      and j.status in ('queued', 'processing')
  ) then
    raise exception 'An episode is already queued or being generated for your workspace. Check Episodes before starting another run.';
  end if;

  if v_plan <> 'admin' and not coalesce(v_is_paid, false) and exists (
    select 1 from public.episodes as e
    where e.owner_id = v_owner_id
      and e.status in ('draft', 'queued', 'processing', 'ready', 'published')
  ) then
    raise exception 'Your one Free lifetime episode has already been used. Upgrade to continue generating episodes.'
      using errcode = '42501';
  end if;

  v_settings_timezone := coalesce(nullif(v_settings_timezone, ''), nullif(v_workspace_timezone, ''), 'Africa/Nairobi');
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_settings_timezone) then
    v_settings_timezone := 'Africa/Nairobi';
  end if;

  v_day_start := (
    date_trunc('day', now() at time zone v_settings_timezone)
    at time zone v_settings_timezone
  );

  select count(*)::integer
    into v_used_today
    from public.episodes as e
    where e.owner_id = v_owner_id
      and e.created_at >= v_day_start
      and e.status in ('draft', 'queued', 'processing', 'ready', 'published');

  if v_plan <> 'admin'
    and v_used_today >= greatest(coalesce(v_daily_limit, case when coalesce(v_is_paid, false) then 6 else 1 end), 1)
  then
    raise exception 'Your daily episode allowance has been reached. Try again after your daily allowance resets.';
  end if;

  v_free_trial := v_plan <> 'admin' and not coalesce(v_is_paid, false);

  insert into public.publishing_jobs (
    owner_id, job_type, status, scheduled_at, payload
  ) values (
    v_owner_id,
    'generate_episode',
    'queued',
    now(),
    jsonb_build_object('source', 'manual', 'free_trial', v_free_trial)
  )
  returning id into v_job_id;

  return query select v_job_id, v_free_trial, false;
end;
$$;

revoke all on function public.request_manual_automation_run() from public;
grant execute on function public.request_manual_automation_run() to authenticated;

comment on function public.request_manual_automation_run() is
  'Queues one manual generation job after validating the workspace. Free workspaces receive one successful episode for the lifetime of the account; failed attempts do not consume it. Paid limits are enforced separately.';
