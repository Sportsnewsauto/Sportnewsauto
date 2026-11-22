-- Workspace-level Kokoro voice access and selectable publishing intervals.

alter table public.workspace_settings
  add column if not exists publishing_interval_hours integer not null default 8;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspace_settings_publishing_interval_hours_check'
      and conrelid = 'public.workspace_settings'::regclass
  ) then
    alter table public.workspace_settings
      add constraint workspace_settings_publishing_interval_hours_check
      check (publishing_interval_hours in (2, 4, 6, 8));
  end if;
end
$$;

-- The default voice for new non-admin accounts is Bella. Existing customer
-- workspaces are moved off the two admin-only voices; the admin voice settings
-- are left untouched.
update public.workspace_settings
set tts_voice = 'af_bella'
where tts_voice in ('af_heart', 'am_michael')
  and exists (
    select 1
    from public.workspaces w
    where w.owner_id = workspace_settings.owner_id
      and coalesce(w.plan, 'free') <> 'admin'
  );

-- Keep the stored selection within the supported English voice catalogue.
update public.workspace_settings
set tts_voice = 'af_bella'
where tts_voice not in (
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica',
  'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael',
  'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'
);

alter table public.workspace_settings
  alter column tts_voice set default 'af_bella';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspace_settings_tts_voice_supported_check'
      and conrelid = 'public.workspace_settings'::regclass
  ) then
    alter table public.workspace_settings
      add constraint workspace_settings_tts_voice_supported_check
      check (tts_voice in (
        'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica',
        'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
        'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael',
        'am_onyx', 'am_puck', 'am_santa',
        'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
        'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'
      ));
  end if;
end
$$;

create or replace function public.enforce_workspace_kokoro_voice_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_plan text;
begin
  if new.tts_voice in ('af_heart', 'am_michael') then
    select w.plan
      into workspace_plan
      from public.workspaces as w
      where w.owner_id = new.owner_id;

    if coalesce(workspace_plan, 'free') <> 'admin' then
      raise exception 'Kokoro voice % is reserved for the admin workspace.', new.tts_voice
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_workspace_kokoro_voice_access() from public;

drop trigger if exists enforce_workspace_kokoro_voice_access on public.workspace_settings;
create trigger enforce_workspace_kokoro_voice_access
before insert or update on public.workspace_settings
for each row
execute function public.enforce_workspace_kokoro_voice_access();

comment on column public.workspace_settings.publishing_interval_hours is
  'Workspace episode-generation interval in hours; allowed values are 2, 4, 6 and 8.';
comment on column public.workspace_settings.tts_voice is
  'Kokoro English voice ID; af_heart and am_michael are reserved for the platform admin workspace.';
