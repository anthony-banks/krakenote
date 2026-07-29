-- Manual card ordering. 0 = unset (falls back to created_at). A manual
-- drag-reorder writes 1-based positions. Additive.
alter table public.cards add column if not exists sort_order integer not null default 0;
create index if not exists cards_deck_sort_idx on public.cards(deck_id, sort_order);
