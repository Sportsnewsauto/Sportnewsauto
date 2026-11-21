-- Account foundation for Automate Spreaker Podcast.
-- Run this file in the Supabase SQL Editor for your project.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null default 'My Podcast Workspace',
  plan text not null default 'free' check (plan in ('free', 'pro', 'business')),
  timezone text not null default 'Africa/Nairobi',
  daily_episode_limit integer not null default 1 check (daily_episode_limit >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "Users can read their own workspace" on public.workspaces;
create policy "Users can read their own workspace"
  on public.workspaces for select to authenticated
  using (auth.uid() = owner_id);

drop policy if exists "Users can update their own workspace" on public.workspaces;
create policy "Users can update their own workspace"
  on public.workspaces for update to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', ''));

  insert into public.workspaces (owner_id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'workspace_name', ''), 'My Podcast Workspace'));

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

grant select, update on public.profiles to authenticated;
grant select, update on public.workspaces to authenticated;
