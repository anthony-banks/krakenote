-- Cost-safe freemium access. Everyone gets a free tier (manual study loop, no AI);
-- AI generation/fact-check requires plan = 'pro' (granted by admin approval now,
-- paid later). access_requested_at drives the admin approval queue.
alter table public.profiles add column if not exists plan text not null default 'free';
alter table public.profiles add column if not exists access_requested_at timestamptz;
create index if not exists profiles_access_req_idx on public.profiles(access_requested_at);
