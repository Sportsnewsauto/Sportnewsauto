-- Allow the trusted server-side Admin importer to resolve an account
-- by email through the existing profiles table. This grant is only for
-- service_role; anon and authenticated users receive no new permissions.
grant select on table public.profiles to service_role;
