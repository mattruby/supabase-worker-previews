-- Supabase branches (and newer projects) start without the API roles in the
-- default privileges; only migrations can grant them back.
-- This must run before any table exists. Later migrations revoke what they must.
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;
