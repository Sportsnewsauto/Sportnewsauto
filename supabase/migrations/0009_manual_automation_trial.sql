-- Secure, one-click manual episode generation.
-- The first successfully generated episode for a workspace is flagged as its free trial.
-- Every manual run is still charged against the workspace's existing daily episode allowance.

create or replace function public.request_manual_automation_run()
returns table(job_id uuid, free_trial boolean, already_queued boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
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

  -- Serialize requests for this workspace to prevent rapid double-clicks
  -- from creating duplicate manual jobs.
  select w.daily_episode_limit, w.timezone
    into v_daily_limit, v_workspace_timezone
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

  if v_used_today >= greatest(coalesce(v_daily_limit, 1), 1) then
    raise exception 'Your daily episode allowance has been reached. Try again after your daily allowance resets.';
  end if;

  -- A first successful episode is the free trial. Failed episodes do not consume it.
  select not exists (
    select 1 from public.episodes as e
    where e.owner_id = v_owner_id
      and e.status in ('draft', 'queued', 'processing', 'ready', 'published')
  ) into v_free_trial;

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
  'Queues one owner-scoped manual episode generation job after validating feeds, verified integrations and the daily episode allowance. Flags the workspace first episode as its free trial.';
