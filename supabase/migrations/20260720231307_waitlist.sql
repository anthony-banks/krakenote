-- Krakenote waitlist table.
-- Idempotent so it applies cleanly even where the table already exists.

create table if not exists public.waitlist (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  source     text default 'landing',
  created_at timestamptz not null default now()
);

-- Lock it down. The Railway server uses the service_role key, which bypasses RLS.
-- With RLS on and no policies, the public anon key can neither read nor write —
-- so no one can scrape the email list from the browser.
alter table public.waitlist enable row level security;
