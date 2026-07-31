-- Per-user AI usage log. Backs a durable rolling-24h cost cap on paid Claude calls
-- (generation + fact-check), so a Pro or compromised account can't loop the API and
-- run up unbounded spend. One row per successful AI call; the server counts rows in
-- the last 24h and blocks over the limit. RLS scopes every read/write to the caller.
create table if not exists public.ai_usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null,
  created_at timestamptz not null default now()
);

-- The quota query filters by user_id (via RLS) + created_at window.
create index if not exists ai_usage_user_time_idx on public.ai_usage(user_id, created_at desc);

alter table public.ai_usage enable row level security;

-- Users may read and insert only their own rows (the server acts as the user).
drop policy if exists ai_usage_select_own on public.ai_usage;
create policy ai_usage_select_own on public.ai_usage
  for select using (auth.uid() = user_id);

drop policy if exists ai_usage_insert_own on public.ai_usage;
create policy ai_usage_insert_own on public.ai_usage
  for insert with check (auth.uid() = user_id);
