-- Podcasti subscription billing and plan entitlements.
-- Free: 3 lifetime manual runs, 5,000 script characters, 2 feeds, one voice, no schedules.
-- Paid: KSh 3,000/month or KSh 15,000/year (both introductory 50% prices),
-- up to 3 episodes/day, 90 episodes per rolling 30 days, 20 feeds, 50,000 characters.
-- Admin workspace remains unrestricted by customer plan limits.

alter table public.workspaces
  add column if not exists subscription_interval text,
  add column if not exists subscription_status text not null default 'inactive',
  add column if not exists subscription_started_at timestamptz,
  add column if not exists subscription_expires_at timestamptz,
  add column if not exists monthly_episode_limit integer not null default 3;

alter table public.workspaces
  alter column daily_episode_limit set default 3;

alter table public.workspaces
  drop constraint if exists workspaces_subscription_interval_check,
  drop constraint if exists workspaces_subscription_status_check,
  drop constraint if exists workspaces_monthly_episode_limit_check;

alter table public.workspaces
  add constraint workspaces_subscription_interval_check
    check (subscription_interval is null or subscription_interval in ('monthly', 'yearly')),
  add constraint workspaces_subscription_status_check
    check (subscription_status in ('inactive', 'pending', 'active', 'cancelled', 'expired')),
  add constraint workspaces_monthly_episode_limit_check
    check (monthly_episode_limit >= 1);

-- Existing customer workspaces start on Free; retain the Admin workspace's
-- configured daily allowance and all of its existing settings.
update public.workspaces
set daily_episode_limit = 3,
    monthly_episode_limit = 3,
    updated_at = now()
where plan <> 'admin'
  and not (
    plan in ('pro', 'business')
    and subscription_status = 'active'
    and subscription_expires_at > now()
  );

create or replace function public.workspace_effective_plan(p_owner_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when w.plan = 'admin' then 'admin'
    when w.plan in ('pro', 'business')
      and w.subscription_status = 'active'
      and w.subscription_expires_at > now() then 'pro'
    else 'free'
  end
  from public.workspaces as w
  where w.owner_id = p_owner_id;
$$;

revoke all on function public.workspace_effective_plan(uuid) from public, anon, authenticated;

-- Never let an authenticated browser user grant itself paid access or alter
-- subscription timestamps, usage limits, or billing state.
create or replace function public.restrict_workspace_plan_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.plan := old.plan;
    new.daily_episode_limit := old.daily_episode_limit;
    new.monthly_episode_limit := old.monthly_episode_limit;
    new.subscription_interval := old.subscription_interval;
    new.subscription_status := old.subscription_status;
    new.subscription_started_at := old.subscription_started_at;
    new.subscription_expires_at := old.subscription_expires_at;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_workspace_plan_fields on public.workspaces;
create trigger protect_workspace_plan_fields
  before update on public.workspaces
  for each row execute function public.restrict_workspace_plan_changes();

-- Enforce Free / paid voice, script length and scheduling limits in Postgres,
-- including writes made directly through the Supabase API.
drop trigger if exists enforce_workspace_script_character_limit on public.workspace_settings;
drop trigger if exists enforce_workspace_kokoro_voice_access on public.workspace_settings;

create or replace function public.enforce_workspace_plan_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan text;
begin
  v_plan := coalesce(public.workspace_effective_plan(new.owner_id), 'free');

  if v_plan = 'free' then
    new.minimum_narration_characters := least(
      greatest(coalesce(new.minimum_narration_characters, 5000), 5000), 5000
    );
    new.tts_voice := 'af_bella';
    new.automation_enabled := false;
  elsif v_plan <> 'admin' then
    new.minimum_narration_characters := least(
      greatest(coalesce(new.minimum_narration_characters, 5000), 5000), 50000
    );
    if new.tts_voice in ('af_heart', 'am_michael') then
      new.tts_voice := 'af_bella';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_workspace_plan_settings() from public;
create trigger enforce_workspace_plan_settings
  before insert or update on public.workspace_settings
  for each row execute function public.enforce_workspace_plan_settings();

update public.workspace_settings as s
set minimum_narration_characters = least(s.minimum_narration_characters, 5000),
    tts_voice = 'af_bella',
    automation_enabled = false,
    updated_at = now()
from public.workspaces as w
where w.owner_id = s.owner_id
  and public.workspace_effective_plan(w.owner_id) = 'free';

-- Free users can save two RSS feeds; paid customers can save twenty.
-- Serialize insert attempts on the workspace row to prevent concurrent
-- requests from bypassing the limit.
create or replace function public.enforce_workspace_feed_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan text;
  v_limit integer;
  v_feed_count integer;
begin
  if tg_op = 'UPDATE' and new.owner_id = old.owner_id then
    return new;
  end if;

  perform 1
  from public.workspaces as w
  where w.owner_id = new.owner_id
  for update;

  if not found then
    raise exception 'Your Podcasti workspace could not be found.';
  end if;

  v_plan := coalesce(public.workspace_effective_plan(new.owner_id), 'free');
  if v_plan = 'admin' then
    return new;
  end if;

  v_limit := case when v_plan = 'free' then 2 else 20 end;

  select count(*)::integer
    into v_feed_count
    from public.news_feeds as f
    where f.owner_id = new.owner_id
      and (tg_op <> 'UPDATE' or f.id <> old.id);

  if v_feed_count >= v_limit then
    raise exception 'Your % plan allows a maximum of % RSS feeds. Upgrade your plan to add more.',
      case when v_plan = 'free' then 'Free' else 'paid' end,
      v_limit
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_workspace_feed_limit() from public;
drop trigger if exists enforce_workspace_feed_limit on public.news_feeds;
create trigger enforce_workspace_feed_limit
  before insert or update on public.news_feeds
  for each row execute function public.enforce_workspace_feed_limit();

-- Only the trusted manual-run RPC may create generate_episode jobs.
-- The browser can still queue publishing of an episode owned by the same user.
drop policy if exists "Owners manage their publishing jobs" on public.publishing_jobs;
create policy "Owners read their publishing jobs"
  on public.publishing_jobs for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Owners queue publishing of their own episodes"
  on public.publishing_jobs for insert to authenticated
  with check (
    (select auth.uid()) = owner_id
    and job_type = 'publish_episode'
    and exists (
      select 1 from public.episodes e
      where e.id::text = payload ->> 'episode_id'
        and e.owner_id = (select auth.uid())
    )
  );


-- Replace the manual queue RPC with lifetime Free-run accounting and a rolling
-- 30-day episode quota. The first three accepted Free requests are usable runs.
create or replace function public.request_manual_automation_run()
returns table(job_id uuid, free_trial boolean, already_queued boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_daily_limit integer;
  v_monthly_limit integer;
  v_plan text;
  v_workspace_timezone text;
  v_settings_timezone text;
  v_show_id text;
  v_day_start timestamptz;
  v_used_today integer;
  v_used_30_days integer;
  v_manual_runs integer;
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

  select w.daily_episode_limit, w.monthly_episode_limit, w.timezone,
         public.workspace_effective_plan(w.owner_id)
    into v_daily_limit, v_monthly_limit, v_workspace_timezone, v_plan
    from public.workspaces as w
    where w.owner_id = v_owner_id
    for update;

  if not found then
    raise exception 'Your podcast workspace could not be found.';
  end if;

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

  v_free_trial := v_plan = 'free';

  if v_plan = 'free' then
    select count(*)::integer
      into v_manual_runs
      from public.publishing_jobs as j
      where j.owner_id = v_owner_id
        and j.job_type = 'generate_episode'
        and j.payload ->> 'source' = 'manual';

    if v_manual_runs >= 3 then
      raise exception 'Your 3 free manual runs have been used. Upgrade to a paid Podcasti plan to continue.'
        using errcode = '42501';
    end if;
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

  if v_used_today >= greatest(coalesce(v_daily_limit, 3), 1) then
    raise exception 'Your daily episode allowance has been reached. Try again after your daily allowance resets.';
  end if;

  if v_plan <> 'admin' then
    select count(*)::integer
      into v_used_30_days
      from public.episodes as e
      where e.owner_id = v_owner_id
        and e.created_at >= now() - interval '30 days'
        and e.status in ('draft', 'queued', 'processing', 'ready', 'published');

    if v_used_30_days >= greatest(coalesce(v_monthly_limit, 3), 1) then
      raise exception 'Your 30-day episode allowance has been reached. Upgrade or wait until older episodes leave the rolling 30-day window.';
    end if;
  end if;

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

-- Private payment ledger. Customers cannot read or alter payment records.
create table if not exists public.billing_payments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  plan_interval text not null check (plan_interval in ('monthly', 'yearly')),
  amount_ksh integer not null check (amount_ksh in (3000, 15000)),
  phone_number text not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  merchant_request_id text,
  checkout_request_id text unique,
  mpesa_receipt text,
  result_code integer,
  result_description text,
  callback_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.billing_payments enable row level security;
revoke all on table public.billing_payments from anon, authenticated;
grant select, insert, update on table public.billing_payments to service_role;
create unique index if not exists billing_payments_receipt_unique
  on public.billing_payments(mpesa_receipt)
  where mpesa_receipt is not null;
create index if not exists billing_payments_owner_created_idx
  on public.billing_payments(owner_id, created_at desc);
create index if not exists episodes_owner_created_rolling_idx
  on public.episodes(owner_id, created_at desc);

create or replace function public.complete_mpesa_subscription(
  p_checkout_request_id text,
  p_amount integer,
  p_phone_number text,
  p_receipt text,
  p_callback_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.billing_payments%rowtype;
  v_workspace public.workspaces%rowtype;
  v_period interval;
begin
  if coalesce(p_checkout_request_id, '') = ''
     or coalesce(p_receipt, '') = ''
     or coalesce(p_phone_number, '') = '' then
    raise exception 'The M-Pesa payment confirmation is incomplete.';
  end if;

  select * into v_payment
  from public.billing_payments
  where checkout_request_id = p_checkout_request_id
  for update;

  if not found then
    raise exception 'No pending Podcasti payment matches this M-Pesa checkout.';
  end if;

  if v_payment.status = 'paid' then
    return true;
  end if;

  if v_payment.status <> 'pending'
     or v_payment.amount_ksh <> p_amount
     or v_payment.phone_number <> p_phone_number then
    raise exception 'The M-Pesa confirmation does not match the pending payment.';
  end if;

  if (v_payment.plan_interval = 'monthly' and p_amount <> 3000)
     or (v_payment.plan_interval = 'yearly' and p_amount <> 15000) then
    raise exception 'The M-Pesa amount does not match the selected Podcasti plan.';
  end if;

  select * into v_workspace
  from public.workspaces
  where owner_id = v_payment.owner_id
  for update;

  if not found or v_workspace.plan = 'admin' then
    raise exception 'This account cannot be upgraded through customer billing.';
  end if;

  v_period := case
    when v_payment.plan_interval = 'yearly' then interval '1 year'
    else interval '1 month'
  end;

  update public.billing_payments
  set status = 'paid',
      mpesa_receipt = p_receipt,
      result_code = 0,
      result_description = 'Payment confirmed by M-Pesa callback.',
      callback_payload = coalesce(p_callback_payload, '{}'::jsonb),
      paid_at = now(),
      updated_at = now()
  where id = v_payment.id;

  update public.workspaces
  set plan = 'pro',
      subscription_interval = v_payment.plan_interval,
      subscription_status = 'active',
      subscription_started_at = case
        when subscription_status = 'active' and subscription_expires_at > now()
          then coalesce(subscription_started_at, now())
        else now()
      end,
      subscription_expires_at = case
        when subscription_status = 'active' and subscription_expires_at > now()
          then subscription_expires_at + v_period
        else now() + v_period
      end,
      daily_episode_limit = 3,
      monthly_episode_limit = 90,
      updated_at = now()
  where owner_id = v_payment.owner_id;

  return true;
end;
$$;

revoke all on function public.complete_mpesa_subscription(text, integer, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_mpesa_subscription(text, integer, text, text, jsonb) to service_role;

create or replace function public.fail_mpesa_subscription(
  p_checkout_request_id text,
  p_result_code integer,
  p_result_description text,
  p_callback_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.billing_payments
  set status = 'failed',
      result_code = p_result_code,
      result_description = left(coalesce(p_result_description, 'M-Pesa payment was not completed.'), 500),
      callback_payload = coalesce(p_callback_payload, '{}'::jsonb),
      updated_at = now()
  where checkout_request_id = p_checkout_request_id
    and status = 'pending';

  return found;
end;
$$;

revoke all on function public.fail_mpesa_subscription(text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.fail_mpesa_subscription(text, integer, text, jsonb) to service_role;

comment on column public.workspaces.monthly_episode_limit is
  'Maximum completed or active episodes in the rolling 30-day window; Free is limited by three lifetime manual runs.';
comment on table public.billing_payments is
  'Server-only M-Pesa STK payment ledger; paid status is set only after a validated Safaricom callback.';
