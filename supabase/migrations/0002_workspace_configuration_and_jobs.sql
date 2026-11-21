-- Multi-user podcast configuration, encrypted provider credentials, and workflow records.
-- Run this migration in the Supabase SQL Editor after 0001_accounts_and_workspaces.sql.

create table if not exists public.workspace_settings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  podcast_name text not null default 'My Sports Podcast',
  podcast_description text not null default '',
  category text not null default 'Sports',
  language text not null default 'en',
  country text not null default 'KE',
  timezone text not null default 'Africa/Nairobi',
  ai_provider text not null default 'groq' check (ai_provider in ('groq', 'gemini')),
  ai_model text not null default 'openai/gpt-oss-120b',
  ai_writing_instructions text not null default '',
  tts_provider text not null default 'kokoro' check (tts_provider in ('kokoro')),
  tts_voice text not null default 'af_heart',
  publishing_mode text not null default 'automatic' check (publishing_mode in ('automatic', 'review')),
  scheduled_times jsonb not null default '["00:00","03:00","06:00","09:00","12:00","15:00","18:00","21:00"]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.news_feeds (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  feed_url text not null,
  sport text not null default 'General',
  league text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, feed_url)
);

create table if not exists public.ad_slots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  position_seconds integer not null check (position_seconds between 1 and 7200),
  label text not null default 'Advertisement',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, position_seconds)
);

create table if not exists public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('spreaker', 'groq', 'gemini')),
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  key_version text not null default 'aes-256-gcm-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, provider)
);

create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('spreaker', 'groq', 'gemini')),
  status text not null default 'saved_unverified' check (status in ('saved_unverified', 'connected', 'invalid')),
  masked_suffix text not null default '',
  updated_at timestamptz not null default now(),
  unique(owner_id, provider)
);

create table if not exists public.episodes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  status text not null default 'draft' check (status in ('draft', 'queued', 'processing', 'ready', 'published', 'failed')),
  audio_url text,
  spreaker_episode_id text,
  source_data jsonb not null default '{}'::jsonb,
  generated_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.publishing_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_type text not null check (job_type in ('generate_episode', 'publish_episode')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  scheduled_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workspace_settings enable row level security;
alter table public.news_feeds enable row level security;
alter table public.ad_slots enable row level security;
alter table public.integration_credentials enable row level security;
alter table public.integration_connections enable row level security;
alter table public.episodes enable row level security;
alter table public.publishing_jobs enable row level security;

drop policy if exists "Owners manage their workspace settings" on public.workspace_settings;
create policy "Owners manage their workspace settings" on public.workspace_settings
  for all to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "Owners manage their news feeds" on public.news_feeds;
create policy "Owners manage their news feeds" on public.news_feeds
  for all to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "Owners manage their ad slots" on public.ad_slots;
create policy "Owners manage their ad slots" on public.ad_slots
  for all to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- Credentials are written only as ciphertext by the server API. Deliberately no SELECT grant.
drop policy if exists "Owners insert encrypted credentials" on public.integration_credentials;
create policy "Owners insert encrypted credentials" on public.integration_credentials
  for insert to authenticated with check (auth.uid() = owner_id);
drop policy if exists "Owners update encrypted credentials" on public.integration_credentials;
create policy "Owners update encrypted credentials" on public.integration_credentials
  for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists "Owners delete encrypted credentials" on public.integration_credentials;
create policy "Owners delete encrypted credentials" on public.integration_credentials
  for delete to authenticated using (auth.uid() = owner_id);

drop policy if exists "Owners manage integration connection status" on public.integration_connections;
create policy "Owners manage integration connection status" on public.integration_connections
  for all to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "Owners manage their episodes" on public.episodes;
create policy "Owners manage their episodes" on public.episodes
  for all to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "Owners manage their publishing jobs" on public.publishing_jobs;
create policy "Owners manage their publishing jobs" on public.publishing_jobs
  for all to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

grant select, insert, update, delete on public.workspace_settings to authenticated;
grant select, insert, update, delete on public.news_feeds to authenticated;
grant select, insert, update, delete on public.ad_slots to authenticated;
grant insert, update, delete on public.integration_credentials to authenticated;
grant select, insert, update, delete on public.integration_connections to authenticated;
grant select, insert, update, delete on public.episodes to authenticated;
grant select, insert, update, delete on public.publishing_jobs to authenticated;

create index if not exists news_feeds_owner_enabled_idx on public.news_feeds(owner_id, enabled);
create index if not exists ad_slots_owner_position_idx on public.ad_slots(owner_id, position_seconds);
create index if not exists episodes_owner_created_idx on public.episodes(owner_id, created_at desc);
create index if not exists publishing_jobs_owner_status_idx on public.publishing_jobs(owner_id, status, created_at desc);


-- Atomic owner-checked credential write. The encrypted credential table intentionally
-- has no SELECT grant for authenticated clients.
create or replace function public.save_integration_credential(
  p_provider text,
  p_ciphertext text,
  p_iv text,
  p_auth_tag text,
  p_key_version text default 'aes-256-gcm-v1'
)
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
  if coalesce(length(p_ciphertext), 0) = 0
     or coalesce(length(p_iv), 0) = 0
     or coalesce(length(p_auth_tag), 0) = 0 then
    raise exception 'Encrypted credential fields are required';
  end if;

  insert into public.integration_credentials (
    owner_id, provider, ciphertext, iv, auth_tag, key_version, updated_at
  ) values (
    auth.uid(), p_provider, p_ciphertext, p_iv, p_auth_tag, p_key_version, now()
  )
  on conflict (owner_id, provider) do update set
    ciphertext = excluded.ciphertext,
    iv = excluded.iv,
    auth_tag = excluded.auth_tag,
    key_version = excluded.key_version,
    updated_at = now();
end;
$$;

revoke all on function public.save_integration_credential(text, text, text, text, text) from public;
grant execute on function public.save_integration_credential(text, text, text, text, text) to authenticated;
