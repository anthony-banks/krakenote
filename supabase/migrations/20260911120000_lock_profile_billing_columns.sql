-- SECURITY (KRA-33 critical finding): the "own profile" RLS policy let an
-- authenticated user UPDATE any column of their own row — including `plan` —
-- via the anon key + their JWT (e.g. supabase.from('profiles').update({plan:'pro'})).
-- That bypassed billing and the AI gate entirely: free -> Pro for free.
--
-- Fix with column-level privileges: authenticated users may only write their own
-- name fields + the access-request flag. All billing columns (plan,
-- subscription_status, subscription_store, current_period_end) become writable
-- ONLY by the service role — i.e. the RevenueCat webhook and the admin endpoint.
-- The row-level "own profile" policy is unchanged; SELECT is unchanged (clients
-- still read their own plan).

revoke insert, update on public.profiles from authenticated;

grant insert (id, first_name, last_name, updated_at, access_requested_at)
  on public.profiles to authenticated;

grant update (first_name, last_name, updated_at, access_requested_at)
  on public.profiles to authenticated;
