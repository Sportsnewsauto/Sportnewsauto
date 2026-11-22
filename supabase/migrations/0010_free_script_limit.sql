-- Free workspaces may generate no more than 5,000 narration characters per episode.
-- Pro, Business and Admin workspaces retain the existing 50,000-character ceiling.

update public.workspace_settings as s
set minimum_narration_characters = 5000,
    updated_at = now()
from public.workspaces as w
where w.owner_id = s.owner_id
  and w.plan = 'free'
  and s.minimum_narration_characters > 5000;

create or replace function public.enforce_workspace_script_character_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan text;
  v_limit integer;
begin
  select w.plan into v_plan
  from public.workspaces as w
  where w.owner_id = new.owner_id;

  v_limit := case when coalesce(v_plan, 'free') = 'free' then 5000 else 50000 end;
  new.minimum_narration_characters :=
    least(greatest(coalesce(new.minimum_narration_characters, 5000), 5000), v_limit);
  return new;
end;
$$;

drop trigger if exists enforce_workspace_script_character_limit
  on public.workspace_settings;

create trigger enforce_workspace_script_character_limit
before insert or update of minimum_narration_characters
on public.workspace_settings
for each row
execute function public.enforce_workspace_script_character_limit();

comment on function public.enforce_workspace_script_character_limit() is
  'Caps free workspace script length at 5,000 characters and paid/Admin workspace length at 50,000 characters.';
