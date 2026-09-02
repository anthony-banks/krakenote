-- Auto-seed a free-tier profile row for every new auth user, regardless of how
-- they signed up (email/password client signUp, or Google OAuth). Previously the
-- profile was seeded by the server signup endpoint only, so Google users had no
-- profile row and the (now verification-based) client signup wouldn't seed one.
-- SECURITY DEFINER so it can insert past RLS; idempotent via on-conflict.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, plan)
  values (new.id, 'free')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
