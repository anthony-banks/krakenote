// RevenueCat webhook event → profile mapping, extracted from the route so it can
// be unit-tested with an injectable `db` (a supabase-like client). Pure of Express
// and env: the route handles auth (shared-secret) + supplies the real client.
//
// Returns { status, body } — the caller sends it. `db` must support the small
// supabase surface used here: .from('profiles').select().eq().maybeSingle(),
// .upsert(row,{onConflict}), and .update(row).in('id', ids).

// Event types that grant Pro. (TRANSFER is handled separately — it carries no
// app_user_id.) EXPIRATION revokes. CANCELLATION = auto-renew off but still
// active until EXPIRATION (status only). BILLING_ISSUE keeps access (grace).
export const RC_GRANT = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE',
  'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_EXTENDED',
]);
export const RC_REVOKE = new Set(['EXPIRATION']);

const ok = () => ({ status: 200, body: { ok: true } });
const fail = () => ({ status: 500, body: { ok: false } });

export async function applyRcEvent(ev, db, rcEnv) {
  const type = ev && ev.type;
  if (!type) return ok(); // nothing actionable

  // Only act on this deployment's environment (SANDBOX vs PRODUCTION).
  if (rcEnv && ev.environment && String(ev.environment).toUpperCase() !== rcEnv) return ok();

  // TRANSFER carries no app_user_id — the sub moves transferred_from -> transferred_to.
  // Grant Pro to the new owner(s), revoke from the previous owner(s). Skip anon ids.
  if (type === 'TRANSFER') {
    const isReal = (id) => typeof id === 'string' && !id.startsWith('$RCAnonymousID');
    const to = (Array.isArray(ev.transferred_to) ? ev.transferred_to : []).filter(isReal);
    const from = (Array.isArray(ev.transferred_from) ? ev.transferred_from : []).filter(isReal);
    const store = ev.store ? String(ev.store).toLowerCase() : null;
    try {
      for (const id of to) {
        const row = { id, plan: 'pro', subscription_status: 'active' };
        if (store) row.subscription_store = store;
        const { error } = await db.from('profiles').upsert(row, { onConflict: 'id' });
        if (error) throw error;
      }
      if (from.length) {
        const { error } = await db.from('profiles')
          .update({ plan: 'free', subscription_status: 'expired' }).in('id', from);
        if (error) throw error;
      }
    } catch { return fail(); }
    return ok();
  }

  const userId = ev.app_user_id;
  if (!userId) return ok(); // non-transfer events need a user

  const patch = {};
  if (RC_GRANT.has(type)) {
    patch.plan = 'pro';
    patch.subscription_status = type === 'INITIAL_PURCHASE' && ev.period_type === 'TRIAL' ? 'trialing' : 'active';
  } else if (RC_REVOKE.has(type)) {
    patch.plan = 'free';
    patch.subscription_status = 'expired';
  } else if (type === 'CANCELLATION') {
    patch.subscription_status = 'canceled'; // keep pro until expiration
  } else if (type === 'BILLING_ISSUE') {
    patch.subscription_status = 'billing_issue';
  } else {
    return ok(); // ignore other event types
  }

  if (ev.store) patch.subscription_store = String(ev.store).toLowerCase();
  if (ev.expiration_at_ms) patch.current_period_end = new Date(Number(ev.expiration_at_ms)).toISOString();

  // Idempotency + ordering guard (KRA-92): apply only events newer than the last
  // processed for this user, so a stale/late EXPIRATION can't undo a newer
  // RENEWAL and duplicates are no-ops.
  const evAtMs = Number(ev.event_timestamp_ms) || Date.now();
  const { data: cur, error: curErr } = await db.from('profiles')
    .select('subscription_event_at').eq('id', userId).maybeSingle();
  if (curErr) return fail();
  if (cur && cur.subscription_event_at && evAtMs <= Date.parse(cur.subscription_event_at)) return ok();
  patch.subscription_event_at = new Date(evAtMs).toISOString();

  const { error } = await db.from('profiles').upsert({ id: userId, ...patch }, { onConflict: 'id' });
  if (error) return fail();
  return ok();
}
