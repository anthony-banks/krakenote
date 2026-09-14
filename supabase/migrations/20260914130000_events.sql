-- KRA-97: product analytics events. Written ONLY by the server (service role) via
-- POST /api/track — RLS is enabled with no client policies, so browsers/apps can't
-- read or write this table directly. Keep props free of PII (no note/card content).
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  props jsonb not null default '{}'::jsonb,
  platform text,
  app_env text
);
create index if not exists events_name_created_idx on public.events (name, created_at desc);
create index if not exists events_user_idx on public.events (user_id);
create index if not exists events_created_idx on public.events (created_at desc);

alter table public.events enable row level security;
-- No policies on purpose: service-role only (default-deny for authenticated/anon).
