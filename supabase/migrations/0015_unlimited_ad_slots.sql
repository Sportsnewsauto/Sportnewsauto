-- Allow workspaces to define as many ad cuepoint positions as they need.
-- Existing ad slots are retained. A cuepoint must be after the beginning of
-- the episode; its actual duration is checked by the Spreaker upload script.
ALTER TABLE public.ad_slots
  DROP CONSTRAINT IF EXISTS ad_slots_position_seconds_check;

ALTER TABLE public.ad_slots
  ADD CONSTRAINT ad_slots_position_seconds_check
  CHECK (position_seconds >= 1);

COMMENT ON COLUMN public.ad_slots.position_seconds IS
  'Ad cuepoint position in seconds from the beginning of the episode. Any positive position is allowed; positions beyond the episode duration are skipped by the uploader.';
