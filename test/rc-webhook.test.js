import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRcEvent, RC_GRANT } from '../server/lib/rc-webhook.js';

// Minimal in-memory fake of the supabase surface the handler uses:
//   .from('profiles').select(c).eq('id',id).maybeSingle()
//   .from('profiles').upsert(row,{onConflict})
//   .from('profiles').update(row).in('id', ids)
// `fail` (a Set of 'select'|'upsert'|'update') simulates DB errors.
function makeDb(seed = {}, fail = new Set()) {
  const rows = new Map(Object.entries(seed).map(([id, r]) => [id, { id, ...r }]));
  const from = () => {
    const st = { op: null, id: null, ids: null, payload: null, single: false };
    const run = () => {
      if (fail.has(st.op)) return Promise.resolve({ data: null, error: { message: 'db error' } });
      if (st.op === 'select') {
        const r = st.id != null ? rows.get(st.id) : null;
        return Promise.resolve({ data: r ? { subscription_event_at: r.subscription_event_at ?? null } : null, error: null });
      }
      if (st.op === 'upsert') {
        rows.set(st.payload.id, { ...(rows.get(st.payload.id) || {}), ...st.payload });
        return Promise.resolve({ data: null, error: null });
      }
      if (st.op === 'update') {
        (st.ids || []).forEach((id) => { if (rows.has(id)) rows.set(id, { ...rows.get(id), ...st.payload }); });
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const b = {
      select() { st.op = 'select'; return b; },
      eq(col, val) { if (col === 'id') st.id = val; return b; },
      in(col, arr) { if (col === 'id') st.ids = arr; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      upsert(p) { st.op = 'upsert'; st.payload = p; return run(); },
      maybeSingle() { st.single = true; return run(); },
      then(res, rej) { return run().then(res, rej); }, // awaitable for update().in()
    };
    return b;
  };
  return { from, rows };
}
const at = (ms) => ms; // event_timestamp_ms helper

test('INITIAL_PURCHASE with a trial → pro / trialing, records store + period end', async () => {
  const db = makeDb({ u: {} });
  const r = await applyRcEvent(
    { type: 'INITIAL_PURCHASE', app_user_id: 'u', period_type: 'TRIAL', store: 'APP_STORE', expiration_at_ms: 1000, event_timestamp_ms: at(500) },
    db, 'SANDBOX');
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  const row = db.rows.get('u');
  assert.equal(row.plan, 'pro');
  assert.equal(row.subscription_status, 'trialing');
  assert.equal(row.subscription_store, 'app_store');
  assert.equal(row.current_period_end, new Date(1000).toISOString());
});

test('INITIAL_PURCHASE without trial → pro / active', async () => {
  const db = makeDb({ u: {} });
  await applyRcEvent({ type: 'INITIAL_PURCHASE', app_user_id: 'u', period_type: 'NORMAL', event_timestamp_ms: at(1) }, db, 'SANDBOX');
  assert.equal(db.rows.get('u').subscription_status, 'active');
});

test('every RC_GRANT type grants pro', async () => {
  for (const type of RC_GRANT) {
    const db = makeDb({ u: {} });
    await applyRcEvent({ type, app_user_id: 'u', event_timestamp_ms: at(1) }, db, 'SANDBOX');
    assert.equal(db.rows.get('u').plan, 'pro', `${type} should grant pro`);
  }
});

test('EXPIRATION → free / expired', async () => {
  const db = makeDb({ u: { plan: 'pro', subscription_status: 'active' } });
  await applyRcEvent({ type: 'EXPIRATION', app_user_id: 'u', event_timestamp_ms: at(10) }, db, 'SANDBOX');
  assert.equal(db.rows.get('u').plan, 'free');
  assert.equal(db.rows.get('u').subscription_status, 'expired');
});

test('CANCELLATION marks status but keeps the plan (access until expiry)', async () => {
  const db = makeDb({ u: { plan: 'pro', subscription_status: 'active' } });
  await applyRcEvent({ type: 'CANCELLATION', app_user_id: 'u', event_timestamp_ms: at(10) }, db, 'SANDBOX');
  assert.equal(db.rows.get('u').plan, 'pro'); // unchanged
  assert.equal(db.rows.get('u').subscription_status, 'canceled');
});

test('BILLING_ISSUE marks status, keeps access', async () => {
  const db = makeDb({ u: { plan: 'pro' } });
  await applyRcEvent({ type: 'BILLING_ISSUE', app_user_id: 'u', event_timestamp_ms: at(10) }, db, 'SANDBOX');
  assert.equal(db.rows.get('u').plan, 'pro');
  assert.equal(db.rows.get('u').subscription_status, 'billing_issue');
});

test('TRANSFER grants transferred_to, revokes transferred_from, skips anon ids', async () => {
  const db = makeDb({ old: { plan: 'pro', subscription_status: 'active' }, new: {} });
  await applyRcEvent(
    { type: 'TRANSFER', store: 'APP_STORE', transferred_from: ['old', '$RCAnonymousID:x'], transferred_to: ['new', '$RCAnonymousID:y'] },
    db, 'SANDBOX');
  assert.equal(db.rows.get('new').plan, 'pro');
  assert.equal(db.rows.get('new').subscription_store, 'app_store');
  assert.equal(db.rows.get('old').plan, 'free');
  assert.equal(db.rows.get('old').subscription_status, 'expired');
  assert.equal(db.rows.has('$RCAnonymousID:y'), false); // anon never created
});

test('ORDERING: a stale/late EXPIRATION does not downgrade a paying user (KRA-92)', async () => {
  const db = makeDb({ u: {} });
  await applyRcEvent({ type: 'INITIAL_PURCHASE', app_user_id: 'u', event_timestamp_ms: at(1000) }, db, 'SANDBOX');
  await applyRcEvent({ type: 'RENEWAL', app_user_id: 'u', event_timestamp_ms: at(2000) }, db, 'SANDBOX');
  // stale EXPIRATION with an OLDER timestamp — must be ignored
  const r = await applyRcEvent({ type: 'EXPIRATION', app_user_id: 'u', event_timestamp_ms: at(1500) }, db, 'SANDBOX');
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  assert.equal(db.rows.get('u').plan, 'pro'); // still pro
  // a genuinely newer EXPIRATION still revokes
  await applyRcEvent({ type: 'EXPIRATION', app_user_id: 'u', event_timestamp_ms: at(3000) }, db, 'SANDBOX');
  assert.equal(db.rows.get('u').plan, 'free');
});

test('IDEMPOTENCY: a duplicate delivery (same timestamp) is a no-op', async () => {
  const db = makeDb({ u: {} });
  const ev = { type: 'INITIAL_PURCHASE', app_user_id: 'u', event_timestamp_ms: at(1000) };
  await applyRcEvent(ev, db, 'SANDBOX');
  // flip the row underneath, then redeliver the same event — should NOT re-apply
  db.rows.set('u', { ...db.rows.get('u'), plan: 'free' });
  await applyRcEvent(ev, db, 'SANDBOX');
  assert.equal(db.rows.get('u').plan, 'free'); // unchanged by the duplicate
});

test('ENVIRONMENT filter: a PRODUCTION event is ignored on a SANDBOX deployment', async () => {
  const db = makeDb({ u: {} });
  const r = await applyRcEvent({ type: 'INITIAL_PURCHASE', app_user_id: 'u', environment: 'PRODUCTION', event_timestamp_ms: at(1) }, db, 'SANDBOX');
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  assert.equal(db.rows.get('u').plan, undefined); // untouched
});

test('non-transfer event with no app_user_id is a safe no-op', async () => {
  const db = makeDb();
  const r = await applyRcEvent({ type: 'RENEWAL', event_timestamp_ms: at(1) }, db, 'SANDBOX');
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  assert.equal(db.rows.size, 0);
});

test('unknown event type and missing type are safe no-ops', async () => {
  const db = makeDb({ u: {} });
  assert.deepEqual(await applyRcEvent({ type: 'SOMETHING_ELSE', app_user_id: 'u', event_timestamp_ms: at(1) }, db, 'SANDBOX'), { status: 200, body: { ok: true } });
  assert.deepEqual(await applyRcEvent({}, db, 'SANDBOX'), { status: 200, body: { ok: true } });
  assert.equal(db.rows.get('u').plan, undefined);
});

test('a DB error surfaces as 500 (fail closed)', async () => {
  const db = makeDb({ u: {} }, new Set(['upsert']));
  const r = await applyRcEvent({ type: 'INITIAL_PURCHASE', app_user_id: 'u', event_timestamp_ms: at(1) }, db, 'SANDBOX');
  assert.equal(r.status, 500);
});
