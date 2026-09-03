-- Paid Pro subscription state. RevenueCat is the source of truth (unifying iOS
-- IAP + web Stripe); its webhook writes these fields. `plan` (free|pro) already
-- exists on profiles and remains the gate the app/API check.
alter table public.profiles add column if not exists subscription_status text;      -- trialing | active | canceled | expired | billing_issue
alter table public.profiles add column if not exists subscription_store  text;      -- app_store | play_store | stripe | promotional
alter table public.profiles add column if not exists current_period_end  timestamptz; -- when the current paid/trial period ends
