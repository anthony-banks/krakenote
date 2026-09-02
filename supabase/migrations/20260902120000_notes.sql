-- Evernote-like note-taking: notebooks (folders) + notes. Both RLS-scoped to the
-- owner, same model as decks/cards. Free to use (no AI cost). Notes body is plain
-- text / light markdown for v1.

create table if not exists public.notebooks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- Nullable: a note with no notebook is "unfiled". Deleting a notebook leaves its
  -- notes intact (they become unfiled) rather than cascading them away.
  notebook_id uuid references public.notebooks(id) on delete set null,
  title       text,
  body        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The note list is ordered by most-recently-edited, scoped per user.
create index if not exists notes_user_updated_idx on public.notes(user_id, updated_at desc);
create index if not exists notes_notebook_idx on public.notes(notebook_id);
create index if not exists notebooks_user_idx on public.notebooks(user_id);

alter table public.notebooks enable row level security;
alter table public.notes enable row level security;

drop policy if exists "own notebooks" on public.notebooks;
create policy "own notebooks" on public.notebooks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own notes" on public.notes;
create policy "own notes" on public.notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
