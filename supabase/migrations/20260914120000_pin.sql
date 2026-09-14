-- KRA-40: pin/star notes and decks to keep them at the top of their list.
-- Cheap organizational flag — free on every plan. RLS is unchanged (owner-scoped),
-- and `pinned` is a normal user-writable column via the existing update policies.
alter table public.notes add column if not exists pinned boolean not null default false;
alter table public.decks add column if not exists pinned boolean not null default false;
