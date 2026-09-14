-- KRA-96 refinement: make the conversion funnel distinct-USER counts at every
-- stage (previously mixed user counts with raw event counts, so a stage could
-- read >100% of "active"). Now each stage is the number of unique users who
-- reached it, so the funnel is monotonic and percentages are meaningful.
create or replace function public.analytics_summary(days int default 30)
returns jsonb
language sql
stable
as $$
  with ev as (
    select * from public.events
    where created_at >= now() - ((days || ' days')::interval)
  )
  select jsonb_build_object(
    'range_days', days,
    'total_events', (select count(*) from ev),
    'unique_users', (select count(distinct user_id) from ev where user_id is not null),
    'funnel', jsonb_build_object(
      -- distinct-user funnel stages
      'active_users',          (select count(distinct user_id) from ev where user_id is not null),
      'used_ai_users',         (select count(distinct user_id) from ev where name = 'ai_generation'      and user_id is not null),
      'paywall_users',         (select count(distinct user_id) from ev where name = 'paywall_shown'      and user_id is not null),
      'upgrade_started_users', (select count(distinct user_id) from ev where name = 'upgrade_started'     and user_id is not null),
      'upgraded_users',        (select count(distinct user_id) from ev where name = 'upgrade_completed'   and user_id is not null),
      -- raw event totals for the metric cards
      'signed_up',             (select count(*) from ev where name = 'signed_up'),
      'upgrade_completed',     (select count(*) from ev where name = 'upgrade_completed'),
      'ai_limit_hit',          (select count(*) from ev where name = 'ai_limit_hit')
    ),
    'by_name', (
      select coalesce(jsonb_object_agg(name, c), '{}'::jsonb)
      from (select name, count(*) c from ev group by name order by count(*) desc) x
    ),
    'by_platform', (
      select coalesce(jsonb_object_agg(coalesce(platform, 'unknown'), c), '{}'::jsonb)
      from (select platform, count(*) c from ev group by platform) x
    ),
    'daily', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.day), '[]'::jsonb)
      from (
        select created_at::date as day,
          count(*)                                            as total,
          count(*) filter (where name = 'signed_up')         as signed_up,
          count(*) filter (where name = 'ai_generation')     as ai_generation,
          count(*) filter (where name = 'upgrade_completed') as upgrade_completed
        from ev group by created_at::date
      ) t
    )
  );
$$;
