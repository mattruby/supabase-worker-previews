create table public.notes (
  id bigint generated always as identity primary key,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.notes enable row level security;

create policy "Anyone can read notes" on public.notes
  for select to anon, authenticated
  using (true);
