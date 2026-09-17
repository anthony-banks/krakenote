-- Public note sharing (KRA-11): an opaque, revocable share token per note.
-- Null = not shared. Set to a random id to publish a read-only public page;
-- clear it to revoke. Unique so a token maps to exactly one note.
alter table public.notes add column if not exists share_id text unique;
create index if not exists notes_share_id_idx on public.notes(share_id) where share_id is not null;
