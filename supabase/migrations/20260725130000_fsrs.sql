-- FSRS scheduler state on cards. Additive: the SM-2 columns (ease,
-- interval_days, repetitions) are KEPT so a rollback to SM-2 is a code change,
-- not a data migration. interval_days + repetitions are reused by FSRS
-- (scheduled_days + reps); the new columns below hold the rest of FSRS state.

alter table public.cards add column if not exists stability      real;
alter table public.cards add column if not exists difficulty     real;
alter table public.cards add column if not exists fsrs_state      integer not null default 0;   -- 0 New | 1 Learning | 2 Review | 3 Relearning
alter table public.cards add column if not exists lapses         integer not null default 0;
alter table public.cards add column if not exists learning_steps integer not null default 0;
alter table public.cards add column if not exists last_review    timestamptz;
