-- Krakenote waitlist table.
-- Run this in the Supabase dashboard: SQL Editor → New query → paste → Run.

create table if not exists public.waitlist (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  source     text default 'landing',
  created_at timestamptz not null default now()
);

-- Lock it down. Our Railway server uses the service_role key, which bypasses RLS.
-- With RLS on and no policies, the public anon key can neither read nor write —
-- so no one can scrape the email list from the browser.
alter table public.waitlist enable row level security;

-- Handy view of signups, newest first (visible to you in the dashboard).
-- select * from public.waitlist order by created_at desc;
