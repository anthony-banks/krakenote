-- Review log: one row per graded review. Powers streaks, retention %, and the
-- Progress dashboard. Kept separate from the card's live SM-2 state so history
-- survives even as a card is re-scheduled.

create table if not exists public.reviews (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  card_id     uuid not null references public.cards(id) on delete cascade,
  deck_id     uuid not null references public.decks(id) on delete cascade,
  grade       integer not null,        -- 0 Again | 3 Hard | 4 Good | 5 Easy
  reviewed_at timestamptz not null default now()
);

create index if not exists reviews_user_time_idx on public.reviews(user_id, reviewed_at);

alter table public.reviews enable row level security;
grant select, insert on public.reviews to authenticated;

drop policy if exists "own reviews" on public.reviews;
create policy "own reviews" on public.reviews
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
