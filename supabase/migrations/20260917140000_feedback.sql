-- User feedback / bug reports (KRA). Any signed-in user can submit a bug or an
-- idea; the admin dashboard reads them (service role, bypasses RLS), can delete
-- them, or flag one into Linear as a ticket.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  email text,
  kind text not null default 'idea' check (kind in ('bug', 'idea')),
  message text not null check (char_length(message) between 1 and 4000),
  page text,
  status text not null default 'new' check (status in ('new', 'flagged', 'done')),
  linear_id text,
  linear_url text,
  created_at timestamptz not null default now()
);

create index if not exists feedback_created_idx on public.feedback (created_at desc);

alter table public.feedback enable row level security;

-- Users may only INSERT their own feedback. No select/update/delete for regular
-- users — the admin reads and manages it via the service role, which bypasses RLS.
drop policy if exists "insert own feedback" on public.feedback;
create policy "insert own feedback" on public.feedback
  for insert to authenticated
  with check (auth.uid() = user_id);

grant insert on public.feedback to authenticated;
