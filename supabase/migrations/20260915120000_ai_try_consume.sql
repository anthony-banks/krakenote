-- KRA-93: atomically reserve one AI-usage slot under the daily cap. The old
-- read-count-then-insert-later flow had a TOCTOU: concurrent requests all read
-- the same pre-insert count and all passed (and AI_BURST_PER_MIN > FREE_AI_DAILY
-- let a burst clear the gate). This function takes a per-user advisory lock so
-- the count + conditional insert happen atomically — parallel calls serialize and
-- only `p_limit` succeed per rolling 24h. Service-role only (called by the server).
create or replace function public.ai_try_consume(p_user uuid, p_limit int, p_kind text default 'ai')
returns jsonb
language plpgsql
as $$
declare
  used int;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select count(*) into used
    from public.ai_usage
    where user_id = p_user and created_at >= now() - interval '24 hours';
  if used >= p_limit then
    return jsonb_build_object('allowed', false, 'used', used);
  end if;
  insert into public.ai_usage (user_id, kind) values (p_user, p_kind)
    returning id into new_id;
  return jsonb_build_object('allowed', true, 'used', used + 1, 'id', new_id);
end;
$$;

revoke all on function public.ai_try_consume(uuid, int, text) from public, anon, authenticated;
grant execute on function public.ai_try_consume(uuid, int, text) to service_role;
