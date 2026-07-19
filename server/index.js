import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = join(__dirname, '..', 'site');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

const app = express();
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

// Serve the static landing page.
app.use(express.static(SITE_DIR, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(join(SITE_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`Krakenote site listening on :${PORT} (supabase: ${Boolean(supabase)})`);
});
