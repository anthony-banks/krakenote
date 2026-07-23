-- Krakenote study data: decks + cards + sources (PRD §7).
-- Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS) so it is safe to re-apply.
--
-- Auth is browser-side with the anon key; Row-Level Security is the boundary.
-- Every row is scoped to its owner, so a signed-in user can only ever touch
-- their own rows — enforced by Postgres, not by app code.

create table if not exists public.decks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  subject     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.cards (
  id            uuid primary key default gen_random_uuid(),
  deck_id       uuid not null references public.decks(id) on delete cascade,
  card_type     text not null default 'basic',   -- 'basic' | 'cloze'
  front         text not null,
  back          text not null,
  hint          text,
  -- SM-2 scheduling state
  ease          real not null default 2.5,
  interval_days integer not null default 0,
  repetitions   integer not null default 0,
  due_at        timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- Uploaded / pasted material an AI generation ran on. Keeps the source metadata
-- and AI summary so a deck's material is reviewable after the fact.
create table if not exists public.sources (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  deck_id        uuid not null references public.decks(id) on delete cascade,
  kind           text not null,          -- 'text' | 'pdf' | 'file'
  filename       text,
  char_count     integer not null default 0,
  summary        text,
  extracted_text text,
  created_at     timestamptz not null default now()
);

-- Additive: bring an already-created cards table up to the current shape.
alter table public.cards add column if not exists card_type text not null default 'basic';

create index if not exists decks_user_id_idx on public.decks(user_id);
create index if not exists cards_deck_id_idx on public.cards(deck_id);
create index if not exists sources_deck_id_idx on public.sources(deck_id);

alter table public.decks enable row level security;
alter table public.cards enable row level security;
alter table public.sources enable row level security;

-- The signed-in (authenticated) role acts through RLS; anon gets nothing here.
grant select, insert, update, delete on public.decks to authenticated;
grant select, insert, update, delete on public.cards to authenticated;
grant select, insert, update, delete on public.sources to authenticated;

-- Own decks only.
drop policy if exists "own decks" on public.decks;
create policy "own decks" on public.decks
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Own cards only — ownership is inherited through the parent deck.
drop policy if exists "own cards" on public.cards;
create policy "own cards" on public.cards
  for all
  using (exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  with check (exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()));

-- Own sources only.
drop policy if exists "own sources" on public.sources;
create policy "own sources" on public.sources
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
