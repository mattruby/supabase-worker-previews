-- Runs on every branch database Supabase creates, never on production.
insert into public.notes (body) values
  ('Hello from a branch database'),
  ('Edit supabase/ in a PR and its Preview gets a database of its own');
