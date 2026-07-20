import express from 'express';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = join(__dirname, '..', 'site');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// The anon key is safe in the browser by design — Row-Level Security, not key
// secrecy, is the boundary for user data. It is still read from env rather than
// hardcoded so prod and staging point at their own Supabase projects.
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Emails allowed to access the admin dashboard (comma-separated). Server-side only.
const SUPERUSER_EMAILS = new Set(
  (process.env.SUPERUSER_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);
const isSuperuser = (email) =>
  typeof email === 'string' && SUPERUSER_EMAILS.has(email.toLowerCase());

// The service-role key bypasses RLS and must NEVER reach the browser.
// It only lives here, server-side, injected via Railway env vars.
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

// AI generation. Key is server-side only. Model is env-overridable so cost can
// be tuned (e.g. ANTHROPIC_MODEL=claude-haiku-4-5) without a code change.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AI_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const app = express();
// Deck routes carry base64 uploads (PDFs), so they need a larger body limit;
// everything else stays tiny. The first matching parser wins — express.json
// skips a body it has already parsed, so the 8kb global never re-runs here.
app.use('/api/decks', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '8kb' }));

// Basic in-memory rate limit: max 5 requests per IP per minute (per bucket).
const buckets = new Map();
function rateLimited(key, max = 5) {
  const now = Date.now();
  const windowMs = 60_000;
  const rec = buckets.get(key) || { count: 0, start: now };
  if (now - rec.start > windowMs) {
    rec.count = 0;
    rec.start = now;
  }
  rec.count += 1;
  buckets.set(key, rec);
  return rec.count > max;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, supabase: Boolean(supabase) });
});

// Apex -> www, preserving path and query. Registered after /healthz so Railway's
// healthcheck can never be redirected, and matched against the exact apex host so
// *.up.railway.app and localhost are left alone. GET/HEAD only: a 301 on a POST
// can drop the request body.
const APEX_HOST = 'krakenote.com';
app.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (host === APEX_HOST && (req.method === 'GET' || req.method === 'HEAD')) {
    return res.redirect(301, `https://www.${APEX_HOST}${req.originalUrl}`);
  }
  return next();
});

app.post('/api/waitlist', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  if (rateLimited('wl:' + ip)) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Try again shortly.' });
  }

  const { email, hp, source } = req.body || {};

  // Honeypot: real users leave this blank; bots fill it. Fake success, save nothing.
  if (hp) return res.json({ ok: true });

  const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(clean)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email.' });
  }

  if (!supabase) {
    console.error('[waitlist] Supabase not configured — dropping signup:', clean);
    return res.status(503).json({ ok: false, error: 'Waitlist is warming up. Try again soon.' });
  }

  const { error } = await supabase
    .from('waitlist')
    .upsert({ email: clean, source: typeof source === 'string' ? source.slice(0, 40) : 'landing' }, { onConflict: 'email' });

  if (error) {
    console.error('[waitlist] insert failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }

  return res.json({ ok: true });
});

// ── Web app: user auth + dashboard ──────────────────────────────────────────
// Login/session run in the BROWSER against Supabase Auth with the anon key;
// RLS policies (user_id = auth.uid()) are what protect user data. Signup is the
// one exception — it runs here, server-side, because the waitlist gate has to be
// enforced somewhere the browser cannot skip.

// Public runtime config for the browser client.
app.get('/api/config', (_req, res) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({ ok: false, error: 'Accounts are not configured on this server yet.' });
  }
  return res.json({ ok: true, supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
});

// POST /api/auth/signup { email, password }
// Waitlist-gated registration. Only emails already on the waitlist may register.
// Enforced here rather than in the browser: the anon key can call signUp directly,
// so a client-side check would be trivially bypassed.
app.post('/api/auth/signup', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  if (rateLimited('signup:' + ip)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a minute.' });
  }
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'Accounts are not configured yet.' });
  }

  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  }

  // Gate: must already be on the waitlist.
  const { data: listed, error: listErr } = await supabase
    .from('waitlist')
    .select('email')
    .eq('email', email)
    .maybeSingle();

  if (listErr) {
    console.error('[signup] waitlist lookup failed:', listErr.message);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
  if (!listed) {
    return res.status(403).json({ ok: false, error: 'not_on_waitlist' });
  }

  // email_confirm: true — the waitlist is the gate, so we skip the confirmation
  // round-trip (Supabase's default SMTP is rate-limited and unconfigured here).
  // TRADE-OFF: anyone who knows a waitlisted address can claim that account first.
  // Acceptable pre-launch; revisit before the app holds real user data.
  const { error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createErr) {
    const msg = (createErr.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
      return res.status(409).json({ ok: false, error: 'An account already exists for that email. Try signing in.' });
    }
    console.error('[signup] createUser failed:', createErr.message);
    return res.status(500).json({ ok: false, error: 'Could not create your account. Please try again.' });
  }

  return res.json({ ok: true });
});

// Serve the app shell. Auth state lives in the browser, so this page is public;
// it renders the login view until Supabase reports a valid session.
app.get('/app', (_req, res) => res.sendFile(join(SITE_DIR, 'app.html')));

// ── User data API (RLS-enforced) ────────────────────────────────────────────
// Each request runs AS the signed-in user: we verify their Supabase JWT, then
// build a Supabase client carrying that token, so Row-Level Security is the
// boundary — a user can only read or write their own rows, enforced by Postgres.

function bearerToken(req) {
  const h = (req.headers.authorization || '').toString();
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function requireUser(req, res, next) {
  if (!supabase || !SUPABASE_ANON_KEY) {
    return res.status(503).json({ ok: false, error: 'Accounts are not configured yet.' });
  }
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ ok: false, error: 'Authentication required.' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ ok: false, error: 'Session invalid or expired. Please sign in again.' });
  }
  req.user = data.user;
  // A client bound to the caller's JWT → PostgREST applies RLS as this user.
  req.db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: 'Bearer ' + token } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return next();
}

// List the caller's decks, newest first, each with its card count.
app.get('/api/decks', requireUser, async (req, res) => {
  const { data, error } = await req.db
    .from('decks')
    .select('id, title, subject, created_at, cards(count)')
    .order('created_at', { ascending: false });

  if (error) {
    // A missing table (migration not run) surfaces here — report it plainly.
    console.error('[decks] list failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not load your decks.', detail: error.message });
  }
  const decks = (data || []).map((d) => ({
    id: d.id,
    title: d.title,
    subject: d.subject,
    created_at: d.created_at,
    cardCount: Array.isArray(d.cards) && d.cards[0] ? d.cards[0].count : 0,
  }));
  return res.json({ ok: true, decks });
});

// Create a deck owned by the caller. user_id is set server-side and the RLS
// WITH CHECK policy independently verifies it matches the token — belt and braces.
app.post('/api/decks', requireUser, async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  if (!title) return res.status(400).json({ ok: false, error: 'A deck title is required.' });
  if (title.length > 120) return res.status(400).json({ ok: false, error: 'Title is too long (max 120 characters).' });

  const { data, error } = await req.db
    .from('decks')
    .insert({ user_id: req.user.id, title, subject: subject || null })
    .select('id, title, subject, created_at')
    .single();

  if (error) {
    console.error('[decks] create failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not create the deck.' });
  }
  return res.json({ ok: true, deck: { ...data, cardCount: 0 } });
});

// Delete one of the caller's decks (its cards cascade). RLS makes it impossible
// to delete a deck you don't own — a mismatched id simply affects zero rows.
app.delete('/api/decks/:id', requireUser, async (req, res) => {
  const { error } = await req.db.from('decks').delete().eq('id', req.params.id);
  if (error) {
    console.error('[decks] delete failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not delete the deck.' });
  }
  return res.json({ ok: true });
});

// ── AI generation: material → summary + flashcards ──────────────────────────
// Strict JSON out, validated by the model against this schema (structured
// outputs). hint is required so the schema is strict; the model sends "" when
// there is no hint.
const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          front: { type: 'string' },
          back: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['front', 'back', 'hint'],
      },
    },
  },
  required: ['summary', 'cards'],
};

const GEN_SYSTEM =
  "You are Krakenote's study-material generator. From the provided material, write a concise summary " +
  '(2-4 sentences) and a set of high-quality spaced-repetition flashcards. Each card is an atomic ' +
  'question (front) with a correct, self-contained answer (back), plus a short hint (empty string if ' +
  'none). Produce 5-20 cards depending on the depth of the material. Never invent facts the material ' +
  'does not support.';

// POST /api/decks/:id/generate  { text? , file?: {name, mediaType, dataBase64} }
app.post('/api/decks/:id/generate', requireUser, async (req, res) => {
  if (!anthropic) {
    return res.status(503).json({ ok: false, error: 'AI generation is not configured on this server yet.' });
  }
  const deckId = req.params.id;

  // Confirm the deck is the caller's before spending an AI call on it.
  const { data: deck, error: deckErr } = await req.db.from('decks').select('id').eq('id', deckId).maybeSingle();
  if (deckErr || !deck) return res.status(404).json({ ok: false, error: 'Deck not found.' });

  const file = req.body?.file;
  const text = typeof req.body?.text === 'string' ? req.body.text : '';

  let userContent;
  let sourceKind;
  let filename = null;
  let extractedText = null;
  let charCount = 0;

  if (file && file.dataBase64 && file.mediaType === 'application/pdf') {
    // PDFs go straight to the model as a document block — no server-side parsing.
    userContent = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.dataBase64 } },
      { type: 'text', text: 'Generate study flashcards and a summary from this document.' },
    ];
    sourceKind = 'pdf';
    filename = typeof file.name === 'string' ? file.name.slice(0, 200) : 'document.pdf';
  } else {
    const clean = (text || '').slice(0, 60000).trim(); // bound cost/latency
    if (!clean) return res.status(400).json({ ok: false, error: 'Provide some notes or a PDF to generate from.' });
    userContent = [{ type: 'text', text: 'Study material:\n\n' + clean }];
    sourceKind = file ? 'file' : 'text';
    filename = file && typeof file.name === 'string' ? file.name.slice(0, 200) : null;
    extractedText = clean;
    charCount = clean.length;
  }

  let result;
  try {
    const msg = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      system: GEN_SYSTEM,
      output_config: { format: { type: 'json_schema', schema: CARD_SCHEMA }, effort: 'low' },
      messages: [{ role: 'user', content: userContent }],
    });
    if (msg.stop_reason === 'refusal') {
      return res.status(422).json({ ok: false, error: 'The AI declined to generate from this material.' });
    }
    const block = (msg.content || []).find((b) => b.type === 'text');
    result = JSON.parse(block?.text || '{}');
  } catch (ex) {
    console.error('[generate] AI call failed:', ex?.message);
    return res.status(502).json({ ok: false, error: 'AI generation failed. Please try again.' });
  }

  const summary = typeof result.summary === 'string' ? result.summary : '';
  const cards = (Array.isArray(result.cards) ? result.cards : [])
    .slice(0, 40)
    .map((c) => ({
      deck_id: deckId,
      front: String(c?.front || '').slice(0, 2000),
      back: String(c?.back || '').slice(0, 4000),
      hint: c?.hint ? String(c.hint).slice(0, 500) : null,
    }))
    .filter((c) => c.front && c.back);

  // Record the source (what the cards were generated from).
  const { data: source } = await req.db
    .from('sources')
    .insert({ user_id: req.user.id, deck_id: deckId, kind: sourceKind, filename, char_count: charCount, summary, extracted_text: extractedText })
    .select('id')
    .single();

  if (cards.length) {
    const { error: cardErr } = await req.db.from('cards').insert(cards);
    if (cardErr) {
      console.error('[generate] card insert failed:', cardErr.message);
      return res.status(500).json({ ok: false, error: 'Generated cards but could not save them.' });
    }
  }

  return res.json({ ok: true, summary, cardsAdded: cards.length, sourceId: source?.id || null });
});

// List a deck's cards (for the deck view and the review queue).
app.get('/api/decks/:id/cards', requireUser, async (req, res) => {
  const { data, error } = await req.db
    .from('cards')
    .select('id, front, back, hint, ease, interval_days, repetitions, due_at')
    .eq('deck_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[cards] list failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not load cards.' });
  }
  return res.json({ ok: true, cards: data || [] });
});

// Grade a review with SM-2. grade: 0 Again, 3 Hard, 4 Good, 5 Easy.
app.post('/api/cards/:id/review', requireUser, async (req, res) => {
  const grade = Number(req.body?.grade);
  if (![0, 3, 4, 5].includes(grade)) {
    return res.status(400).json({ ok: false, error: 'Invalid grade.' });
  }
  const { data: card, error } = await req.db
    .from('cards')
    .select('id, ease, interval_days, repetitions')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error || !card) return res.status(404).json({ ok: false, error: 'Card not found.' });

  let ease = card.ease;
  let reps = card.repetitions;
  let interval = card.interval_days;

  if (grade < 3) {
    reps = 0;
    interval = 1;
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round(interval * ease);
  }
  ease = ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02));
  if (ease < 1.3) ease = 1.3;

  const dueAt = new Date(Date.now() + interval * 86400000).toISOString();
  const { error: upErr } = await req.db
    .from('cards')
    .update({ ease, interval_days: interval, repetitions: reps, due_at: dueAt })
    .eq('id', card.id);
  if (upErr) {
    console.error('[review] update failed:', upErr.message);
    return res.status(500).json({ ok: false, error: 'Could not save the review.' });
  }
  return res.json({ ok: true, interval_days: interval, due_at: dueAt });
});

// ── Admin dashboard (Supabase Auth, superuser-gated, READ-ONLY) ─────────────
// Login is proxied through the server so Supabase keys never touch the browser.
// Only emails in SUPERUSER_EMAILS may sign in or read admin data. Every DB call
// below is a SELECT — no insert/update/delete/truncate is ever performed here.

// POST /api/admin/login { email, password } -> { token, name }
// Verifies the password via Supabase Auth, gated on the superuser allowlist.
app.post('/api/admin/login', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  if (rateLimited('login:' + ip)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a minute.' });
  }
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'Admin is not configured (database unavailable).' });
  }
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Email and password are required.' });
  }
  // Gate on the allowlist first — don't attempt auth for non-superusers.
  if (!isSuperuser(email)) {
    return res.status(403).json({ ok: false, error: 'This account is not authorized for admin access.' });
  }
  // Fresh client per login so concurrent sign-ins never share session state.
  const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data?.session) {
    return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
  }
  const name = data.user?.user_metadata?.name || data.user?.email || 'Admin';
  return res.json({ ok: true, token: data.session.access_token, name });
});

// Bearer-token middleware: validates the Supabase JWT + superuser allowlist.
async function requireSuperuser(req, res, next) {
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'Admin database is not configured.' });
  }
  const header = (req.headers.authorization || '').toString();
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authentication required.' });
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user || !isSuperuser(data.user.email)) {
    return res.status(401).json({ ok: false, error: 'Session invalid or expired. Please sign in again.' });
  }
  req.adminUser = data.user;
  return next();
}

// Serve the admin page (public HTML; the login + data are what's protected).
app.get('/admin', (_req, res) => res.sendFile(join(SITE_DIR, 'admin.html')));

// Protected JSON: total count + newest-first rows (limit 500). SELECT only.
app.get('/api/admin/waitlist', requireSuperuser, async (_req, res) => {
  const { data, error, count } = await supabase
    .from('waitlist')
    .select('email, source, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('[admin] waitlist query failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Failed to load waitlist.' });
  }

  const rows = data || [];
  return res.json({ count: count ?? rows.length, rows });
});

// Escape a single CSV cell per RFC 4180.
function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Protected CSV download. SELECT only.
app.get('/api/admin/waitlist.csv', requireSuperuser, async (_req, res) => {
  const { data, error } = await supabase
    .from('waitlist')
    .select('email, source, created_at')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('[admin] waitlist csv query failed:', error.message);
    return res.status(500).type('text/plain').send('Failed to load waitlist.');
  }

  const rows = data || [];
  const lines = ['email,source,created_at'];
  for (const r of rows) {
    lines.push([csvCell(r.email), csvCell(r.source), csvCell(r.created_at)].join(','));
  }
  const csv = lines.join('\r\n') + '\r\n';

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="krakenote-waitlist.csv"');
  return res.send(csv);
});

// Brand icons, served straight from brand/ so there is no duplicated copy to
// drift. Rendered as CSS masks in the UI, since the source SVGs are a fixed navy.
app.use('/icons', express.static(join(__dirname, '..', 'brand', 'icons'), { maxAge: '7d' }));

// supabase-js browser bundle, served from our own origin instead of a CDN:
// one less third party on the page, and it keeps working offline in local dev.
app.get('/vendor/supabase.js', (_req, res) => {
  res.sendFile(
    join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js'),
  );
});

// Serve the static landing page.
app.use(express.static(SITE_DIR, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(join(SITE_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`Krakenote site listening on :${PORT} (supabase: ${Boolean(supabase)})`);
});
