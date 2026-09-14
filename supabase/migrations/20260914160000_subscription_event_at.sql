-- KRA-92: track the timestamp of the last RevenueCat event applied per user, so
-- the webhook can ignore stale/out-of-order/redelivered events (e.g. a late
-- EXPIRATION arriving after a RENEWAL must not downgrade a paying customer).
-- Written only by the service role (the webhook); not in the authenticated
-- column grant, so users can't touch it.
alter table public.profiles add column if not exists subscription_event_at timestamptz;
