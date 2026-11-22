-- Per-workspace script length preference. Writing instructions and AI model policy
-- remain shared by the platform and are not user-editable.
alter table public.workspace_settings
  add column if not exists minimum_narration_characters integer not null default 13500;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspace_settings_minimum_narration_characters_check'
      and conrelid = 'public.workspace_settings'::regclass
  ) then
    alter table public.workspace_settings
      add constraint workspace_settings_minimum_narration_characters_check
      check (minimum_narration_characters between 5000 and 50000);
  end if;
end
$$;

comment on column public.workspace_settings.minimum_narration_characters is
  'Minimum narration characters for an episode; platform writing instructions and AI model policy are shared across all workspaces.';
