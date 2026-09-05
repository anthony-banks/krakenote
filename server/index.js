import express from 'express';
import helmet from 'helmet';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import mammoth from 'mammoth';
import { parseOffice } from 'officeparser';
import { fsrs, generatorParameters, Rating } from 'ts-fsrs';
import { extractFromHtml } from '@extractus/article-extractor';
import { YoutubeTranscript } from 'youtube-transcript';
import dns from 'node:dns/promises';
import net from 'node:net';
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

// Shared secret for the RevenueCat webhook (set as the Authorization header in
// the RevenueCat dashboard). Server-side only.
const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET;

const app = express();

// Railway terminates TLS at its edge proxy and forwards X-Forwarded-For. Without
// this, req.ip is the proxy socket and rate limits would key off a single shared
// IP; with `true` Express would trust the leftmost (client-controlled) XFF entry
// and the limits would be spoofable. Trusting a fixed hop count makes req.ip the
// address the trusted proxy actually saw. Override TRUST_PROXY_HOPS if the edge
// topology changes (e.g. a CDN adds a hop).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

// Security headers. CSP is intentionally left off for now: the app pages are
// single-file with heavy inline <script>/<style>, so a real policy needs the
// frontend split out first — enabling one here would either break the app or
// require 'unsafe-inline' (little value). The rest (nosniff, frameguard DENY,
// HSTS, referrer-policy, no x-powered-by) are safe wins today.
app.use(helmet({ contentSecurityPolicy: false }));

// Deck routes carry base64 uploads (PDFs), so they need a larger body limit;
// everything else stays tiny. The first matching parser wins — express.json
// skips a body it has already parsed, so the 8kb global never re-runs here.
app.use('/api/decks', express.json({ limit: '12mb' }));
app.use('/api/rc', express.json({ limit: '64kb' })); // RevenueCat webhook payloads
app.use(express.json({ limit: '8kb' }));

// Basic in-memory rate limit: max `max` requests per key per minute. Keys are
// caller identity (req.ip, or the user id for authenticated AI endpoints) — never
// a client-supplied header. NOTE: in-memory means per-replica and reset-on-deploy;
// the daily AI quota (below) is the durable cost cap. A DB/Redis-backed limiter is
// the eventual upgrade for multi-replica correctness.
const buckets = new Map();
const RL_WINDOW_MS = 60_000;
let rlCalls = 0;
function rateLimited(key, max = 5) {
  const now = Date.now();
  // Evict expired buckets periodically so the Map can't grow unbounded.
  if (++rlCalls % 500 === 0) {
    for (const [k, v] of buckets) if (now - v.start > RL_WINDOW_MS) buckets.delete(k);
  }
  const rec = buckets.get(key) || { count: 0, start: now };
  if (now - rec.start > RL_WINDOW_MS) {
    rec.count = 0;
    rec.start = now;
  }
  rec.count += 1;
  buckets.set(key, rec);
  return rec.count > max;
}

// Rate-limit key from the real client IP (req.ip is trustworthy given trust proxy).
const clientIp = (req) => req.ip || 'unknown';

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
  const ip = clientIp(req);
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
// one exception — it runs here, server-side, so account creation + free-tier
// profile seeding happen atomically where the browser cannot skip them.

// Public runtime config for the browser client.
app.get('/api/config', (_req, res) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({ ok: false, error: 'Accounts are not configured on this server yet.' });
  }
  return res.json({ ok: true, supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
});

// POST /api/auth/signup { email, password }
// Open registration into the free tier, WITH email verification. Uses the normal
// signUp flow (via the anon key) so Supabase sends a confirmation email and the
// user has no session until they click the link — this is what closes the
// "claim an email you don't own" hole. The free-tier profile row is seeded by a
// DB trigger on auth.users (works for this path AND Google OAuth). The web app
// calls supabase.auth.signUp() directly; this endpoint is kept for the mobile
// client and is deliberately NOT a confirm-bypass.
app.post('/api/auth/signup', async (req, res) => {
  const ip = clientIp(req);
  if (rateLimited('signup:' + ip)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a minute.' });
  }
  if (!supabase || !SUPABASE_ANON_KEY) {
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

  // Anon client → real signUp, which sends the verification email and (with
  // "Confirm email" on) returns no session until the address is confirmed.
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error: signErr } = await anon.auth.signUp({ email, password });

  if (signErr) {
    const msg = (signErr.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
      return res.status(409).json({ ok: false, error: 'An account already exists for that email. Try signing in.' });
    }
    console.error('[signup] signUp failed:', signErr.message);
    return res.status(500).json({ ok: false, error: 'Could not create your account. Please try again.' });
  }

  // needsConfirmation is true when no session came back (verification pending).
  return res.json({ ok: true, needsConfirmation: !data?.session });
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

// Freemium: free tier = manual study loop, no AI. 'pro' unlocks AI + higher caps.
const FREE_DECKS = 2;
const FREE_CARDS = 50;
async function getPlan(db, userId) {
  const { data } = await db.from('profiles').select('plan').eq('id', userId).maybeSingle();
  return (data && data.plan) || 'free';
}

// AI cost controls (protect against a Pro/compromised account looping paid Claude
// calls). Two layers: a per-user burst limit (in-memory) and a durable rolling
// 24h quota (DB-backed, survives deploys/replicas). Both tunable via env.
const AI_BURST_PER_MIN = Number(process.env.AI_BURST_PER_MIN || 8);
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 50);
async function aiQuotaLeft(db) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  // RLS scopes ai_usage to the caller, so the count is already per-user.
  const { count } = await db.from('ai_usage').select('id', { count: 'exact', head: true }).gte('created_at', since);
  return AI_DAILY_LIMIT - (count || 0);
}
function recordAiUsage(db, userId, kind) {
  return db.from('ai_usage').insert({ user_id: userId, kind })
    .then(({ error }) => { if (error) console.error('[ai_usage] log failed:', error.message); });
}
// Shared gate for the paid AI endpoints: Pro plan + burst limit + daily quota.
// Returns a response-ending object when blocked, or null to proceed.
async function aiGate(req) {
  if ((await getPlan(req.db, req.user.id)) !== 'pro') {
    return { status: 403, body: { ok: false, error: 'AI is a Pro feature — request access to unlock it.', code: 'needs_pro' } };
  }
  if (rateLimited('ai:' + req.user.id, AI_BURST_PER_MIN)) {
    return { status: 429, body: { ok: false, error: 'You are generating too fast — give it a moment and try again.' } };
  }
  if ((await aiQuotaLeft(req.db)) <= 0) {
    return { status: 429, body: { ok: false, error: 'Daily AI limit reached (' + AI_DAILY_LIMIT + '). It resets on a rolling 24-hour basis.', code: 'quota' } };
  }
  return null;
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

  if ((await getPlan(req.db, req.user.id)) !== 'pro') {
    const { count } = await req.db.from('decks').select('id', { count: 'exact', head: true });
    if ((count || 0) >= FREE_DECKS) {
      return res.status(403).json({ ok: false, error: 'The free plan is limited to ' + FREE_DECKS + ' decks — request access for unlimited.', code: 'free_limit' });
    }
  }

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
          type: { type: 'string', enum: ['basic', 'cloze'] },
          front: { type: 'string' },
          back: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['type', 'front', 'back', 'hint'],
      },
    },
  },
  required: ['summary', 'cards'],
};

// ── Ingestion: turn whatever was submitted into Claude message content ───────
// Supports pasted text, a URL, PDF (document block), image (vision), and
// docx/pptx (parsed server-side to text). Throws a user-facing message on bad input.
const IMG_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const GEN_PROMPT = 'Generate study flashcards and a summary from this material.';

function isYouTube(u) {
  return /(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === 'youtu.be' || u.hostname === 'm.youtube.com';
}

async function fetchYouTube(rawUrl) {
  // YouTube intermittently rate-limits datacenter IPs; retry transient failures.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const items = await YoutubeTranscript.fetchTranscript(rawUrl);
      const text = (items || []).map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text.length < 100) throw new Error('empty transcript');
      return text;
    } catch (ex) {
      lastErr = ex;
      const msg = (ex?.message || '').toLowerCase();
      const transient = msg.includes('too many requests') || msg.includes('fetch') || msg.includes('network') || msg.includes('timeout') || msg.includes('econn');
      if (!transient) break; // genuine "disabled"/"not available"/"empty" — no point retrying
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  console.error('[ingest] youtube transcript failed:', lastErr?.message);
  const m = (lastErr?.message || '').toLowerCase();
  if (m.includes('too many requests'))
    throw new Error('YouTube is rate-limiting transcript requests right now — try again in a moment, or paste the transcript text directly.');
  throw new Error("Couldn't get a transcript for that video — captions may be disabled or unavailable. You can paste the transcript text instead.");
}

function stripHtml(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── SSRF guard for user-supplied URL ingestion ──────────────────────────────
// An authenticated user hands us a URL and we fetch it, so without this a request
// could target the cloud metadata endpoint (169.254.169.254), localhost, or any
// internal host and read the response back inside generated cards. We block
// private/loopback/link-local/ULA/metadata targets and — because fetch follows
// redirects — re-validate on EVERY hop, so a public URL can't 302 to an internal
// one. (Residual: DNS rebinding between our lookup and fetch's own resolve is not
// closed here; a pinned-IP dispatcher is the follow-up if this needs hardening.)
// An IPv4 tunnelled inside IPv6 (::ffff:1.2.3.4, or its hex form ::ffff:a9fe:a9fe
// that WHATWG URL normalizes to, and IPv4-compatible ::a9fe:a9fe) must be judged by
// its embedded IPv4, or the metadata/loopback IPs sail through the v6 checks. Returns
// the dotted IPv4 when one is embedded, else the input unchanged.
function embeddedV4(s) {
  const dotted = s.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = s.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return s;
}

function ipIsPrivate(ip) {
  ip = embeddedV4(ip.toLowerCase()); // unwrap IPv4-mapped/compatible IPv6 to its v4
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;        // private / loopback / this-network
    if (a === 169 && b === 254) return true;                  // link-local incl. metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;         // private
    if (a === 192 && b === 168) return true;                  // private
    if (a === 100 && b >= 64 && b <= 127) return true;        // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;           // loopback / unspecified
    if (low.startsWith('fe80')) return true;                  // link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local fc00::/7
    return false;
  }
  return true; // unparseable → treat as unsafe
}

async function assertPublicHost(hostname) {
  // WHATWG URL keeps IPv6 literals bracketed (e.g. "[::1]"); strip so net.isIP
  // recognizes them, otherwise they'd fall through to the DNS path.
  const h = (hostname || '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
      h.endsWith('.internal') || h === 'metadata.google.internal') {
    throw new Error('blocked-host');
  }
  if (net.isIP(h)) { // IP literal — check directly, no DNS
    if (ipIsPrivate(h)) throw new Error('blocked-ip');
    return;
  }
  let addrs;
  try { addrs = await dns.lookup(h, { all: true }); }
  catch { throw new Error('dns-fail'); }
  if (!addrs.length) throw new Error('dns-fail');
  for (const a of addrs) if (ipIsPrivate(a.address)) throw new Error('blocked-ip');
}

// Fetch with manual redirect following, validating the host at each hop.
async function safeFetch(rawUrl, { maxRedirects = 4, timeoutMs = 15000 } = {}) {
  let current = new URL(rawUrl);
  for (let i = 0; i <= maxRedirects; i++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('bad-proto');
    await assertPublicHost(current.hostname);
    const resp = await fetch(current.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KrakenoteBot/1.0; +https://krakenote.com)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      current = new URL(resp.headers.get('location'), current); // resolve relative, re-check next loop
      continue;
    }
    return { resp, finalUrl: current.href };
  }
  throw new Error('too-many-redirects');
}

async function fetchArticle(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('That does not look like a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) links are supported.');
  if (isYouTube(u)) return fetchYouTube(rawUrl);

  // All page fetching goes through the SSRF-guarded fetcher.
  let resp, finalUrl;
  try {
    ({ resp, finalUrl } = await safeFetch(u.href));
  } catch (ex) {
    const m = ex?.message || '';
    if (m === 'blocked-host' || m === 'blocked-ip') {
      throw new Error('That link points to a private or internal address, which is not allowed.');
    }
    if (m === 'dns-fail') throw new Error('Could not resolve that link.');
    if (m === 'too-many-redirects') throw new Error('That link redirects too many times.');
    throw new Error('Could not reach that link.');
  }
  if (!resp.ok) {
    if (resp.status === 429 || resp.status === 403) {
      throw new Error('That site is blocking automated access. Try a different link, or copy the text and paste it in directly.');
    }
    throw new Error('Could not fetch that link (HTTP ' + resp.status + ').');
  }
  const html = (await resp.text()).slice(0, 3_000_000);

  // 1. Readability on the HTML we already fetched — never let the extractor fetch
  //    on its own, or it would bypass the SSRF guard above.
  try {
    const art = await extractFromHtml(html, finalUrl);
    if (art && art.content) {
      const text = stripHtml((art.title ? art.title + '\n\n' : '') + art.content);
      if (text.length >= 200) return text;
    }
  } catch (ex) { console.error('[ingest] article extract failed:', ex?.message); }

  // 2. Fallback — strip tags from the same HTML (product/app pages readability skips).
  const text = stripHtml(html);
  if (text.length < 100) {
    throw new Error("Couldn't pull readable text from that page — try a link with more article text, or paste the text directly.");
  }
  return text;
}

async function buildIngest(body) {
  const file = body.file;
  const text = typeof body.text === 'string' ? body.text : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';

  const asText = (raw, kind, filename) => {
    const clean = (raw || '').slice(0, 60000).trim();
    if (!clean) throw new Error('There was nothing to generate from.');
    return { userContent: [{ type: 'text', text: 'Study material:\n\n' + clean }], sourceKind: kind, filename, charCount: clean.length };
  };

  if (file && file.dataBase64) {
    const mt = file.mediaType || '';
    const name = typeof file.name === 'string' ? file.name.slice(0, 200) : null;
    if (mt === 'application/pdf') {
      return {
        userContent: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.dataBase64 } },
          { type: 'text', text: GEN_PROMPT },
        ],
        sourceKind: 'pdf', filename: name || 'document.pdf', charCount: 0,
      };
    }
    if (IMG_TYPES.has(mt)) {
      return {
        userContent: [
          { type: 'image', source: { type: 'base64', media_type: mt, data: file.dataBase64 } },
          { type: 'text', text: GEN_PROMPT + ' Read any text visible in the image.' },
        ],
        sourceKind: 'image', filename: name || 'image', charCount: 0,
      };
    }
    const buf = Buffer.from(file.dataBase64, 'base64');
    if (mt === DOCX_TYPE || /\.docx$/i.test(name || '')) {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return asText(value, 'docx', name);
    }
    if (mt === PPTX_TYPE || /\.pptx$/i.test(name || '')) {
      const value = await parseOffice(buf);
      return asText(value, 'pptx', name);
    }
    throw new Error('Unsupported file type. Use PDF, image, .docx, .pptx, .txt, or .md.');
  }

  if (url) {
    const yt = /youtube\.com|youtu\.be/.test(url);
    return asText(await fetchArticle(url), yt ? 'youtube' : 'url', url);
  }
  if (text) return asText(text, 'text', null);
  throw new Error('Provide notes, a link, or a file to generate from.');
}

// Strict grounding: cards come ONLY from the supplied material. Two card kinds.
const GEN_SYSTEM =
  "You are Krakenote's study-material generator. Use ONLY facts explicitly present in the provided " +
  'material — never outside knowledge, and never invent or infer facts the material does not state. ' +
  'Write a concise 2-4 sentence summary, then high-quality spaced-repetition flashcards of two kinds: ' +
  '"basic" (a question on the front, its correct answer on the back) and "cloze" (a sentence taken from ' +
  'the material with one key term replaced by "____" on the front, and that exact term on the back). ' +
  'Prefer atomic, single-fact cards; add a short hint or an empty string. Produce 5-20 cards scaled to ' +
  'the depth of the material — if it is too thin to support a card, produce fewer rather than padding. ' +
  'Format any mathematical, physical, or chemical formulas and equations using LaTeX delimiters — $...$ ' +
  'for inline and $$...$$ for display — so they render correctly.';

// POST /api/decks/:id/generate  { text? , file?: {name, mediaType, dataBase64} }
app.post('/api/decks/:id/generate', requireUser, async (req, res) => {
  if (!anthropic) {
    return res.status(503).json({ ok: false, error: 'AI generation is not configured on this server yet.' });
  }
  const gate = await aiGate(req);
  if (gate) return res.status(gate.status).json(gate.body);
  const deckId = req.params.id;

  // Confirm the deck is the caller's before spending an AI call on it.
  const { data: deck, error: deckErr } = await req.db.from('decks').select('id').eq('id', deckId).maybeSingle();
  if (deckErr || !deck) return res.status(404).json({ ok: false, error: 'Deck not found.' });

  let userContent, sourceKind, filename, charCount;
  try {
    ({ userContent, sourceKind, filename, charCount } = await buildIngest(req.body || {}));
  } catch (ex) {
    return res.status(400).json({ ok: false, error: ex.message || 'Could not read that input.' });
  }

  // Card-type control: 'basic' | 'cloze' | 'mix' (default).
  const ct = req.body?.cardType;
  const typeInstr =
    ct === 'basic' ? ' Produce ONLY basic question/answer cards — no cloze.'
    : ct === 'cloze' ? ' Produce ONLY cloze fill-in-the-blank cards.'
    : ' Produce a mix of basic and cloze cards — aim for roughly one-third cloze.';

  let result;
  try {
    const msg = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      system: GEN_SYSTEM + typeInstr,
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
  // Proposals only — nothing is written. The user reviews/edits, then approves
  // via POST /api/decks/:id/cards, so a discarded generation leaves no trace.
  const cards = (Array.isArray(result.cards) ? result.cards : [])
    .slice(0, 40)
    .map((c) => ({
      type: c?.type === 'cloze' ? 'cloze' : 'basic',
      front: String(c?.front || '').slice(0, 2000),
      back: String(c?.back || '').slice(0, 4000),
      hint: c?.hint ? String(c.hint).slice(0, 500) : '',
    }))
    .filter((c) => c.front && c.back);

  await recordAiUsage(req.db, req.user.id, 'generate'); // count the paid call against the quota

  return res.json({
    ok: true,
    summary,
    cards,
    source: { kind: sourceKind, filename, charCount },
  });
});

// Approve step: persist edited/kept cards (and a source record) to the deck.
// Separate from generation so review-and-approve is a real gate, not cosmetic.
app.post('/api/decks/:id/cards', requireUser, async (req, res) => {
  const deckId = req.params.id;
  const { data: deck, error: deckErr } = await req.db.from('decks').select('id').eq('id', deckId).maybeSingle();
  if (deckErr || !deck) return res.status(404).json({ ok: false, error: 'Deck not found.' });

  const incoming = Array.isArray(req.body?.cards) ? req.body.cards : [];
  const rows = incoming
    .slice(0, 60)
    .map((c) => ({
      deck_id: deckId,
      card_type: c?.type === 'cloze' ? 'cloze' : 'basic',
      front: String(c?.front || '').trim().slice(0, 2000),
      back: String(c?.back || '').trim().slice(0, 4000),
      hint: c?.hint ? String(c.hint).slice(0, 500) : null,
    }))
    .filter((c) => c.front && c.back);

  if (!rows.length) return res.status(400).json({ ok: false, error: 'No cards to add.' });

  if ((await getPlan(req.db, req.user.id)) !== 'pro') {
    const { count } = await req.db.from('cards').select('id', { count: 'exact', head: true });
    if ((count || 0) + rows.length > FREE_CARDS) {
      return res.status(403).json({ ok: false, error: 'The free plan is limited to ' + FREE_CARDS + ' cards — request access for unlimited.', code: 'free_limit' });
    }
  }

  // Record the source these cards came from (summary + metadata; no raw text kept for alpha).
  const src = req.body?.source;
  if (src && typeof src === 'object') {
    await req.db.from('sources').insert({
      user_id: req.user.id,
      deck_id: deckId,
      kind: typeof src.kind === 'string' ? src.kind : 'text',
      filename: typeof src.filename === 'string' ? src.filename.slice(0, 200) : null,
      char_count: Number.isFinite(src.charCount) ? src.charCount : 0,
      summary: typeof src.summary === 'string' ? src.summary.slice(0, 4000) : null,
    });
  }

  const { error } = await req.db.from('cards').insert(rows);
  if (error) {
    console.error('[cards] bulk insert failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not save the cards.' });
  }
  return res.json({ ok: true, added: rows.length });
});

// List a deck's cards (for the deck view and the review queue).
app.get('/api/decks/:id/cards', requireUser, async (req, res) => {
  const { data, error } = await req.db
    .from('cards')
    .select('id, card_type, front, back, hint, ease, interval_days, repetitions, due_at, sort_order')
    .eq('deck_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[cards] list failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not load cards.' });
  }
  return res.json({ ok: true, cards: data || [] });
});

// What a deck was built from — the sources + AI summaries, newest first.
app.get('/api/decks/:id/sources', requireUser, async (req, res) => {
  const { data, error } = await req.db
    .from('sources')
    .select('id, kind, filename, summary, created_at')
    .eq('deck_id', req.params.id)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[sources] list failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not load the deck overview.' });
  }
  return res.json({ ok: true, sources: data || [] });
});

// Edit a single card (front/back/hint/type). RLS scopes it to the owner.
app.patch('/api/cards/:id', requireUser, async (req, res) => {
  const patch = {};
  if (typeof req.body?.front === 'string') patch.front = req.body.front.trim().slice(0, 2000);
  if (typeof req.body?.back === 'string') patch.back = req.body.back.trim().slice(0, 4000);
  if (typeof req.body?.hint === 'string') patch.hint = req.body.hint.slice(0, 500) || null;
  if (req.body?.type === 'basic' || req.body?.type === 'cloze') patch.card_type = req.body.type;
  if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'Nothing to update.' });
  if (patch.front === '' || patch.back === '') return res.status(400).json({ ok: false, error: 'Front and back cannot be empty.' });
  const { error } = await req.db.from('cards').update(patch).eq('id', req.params.id);
  if (error) {
    console.error('[cards] update failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not update the card.' });
  }
  return res.json({ ok: true });
});

// Delete a single card.
app.delete('/api/cards/:id', requireUser, async (req, res) => {
  const { error } = await req.db.from('cards').delete().eq('id', req.params.id);
  if (error) {
    console.error('[cards] delete failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not delete the card.' });
  }
  return res.json({ ok: true });
});

// Fact-check a card against general knowledge (NOT strict-from-source — this is
// the deliberate opposite of generation: verify the card is actually correct).
const FACTCHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    accurate: { type: 'boolean' },
    context: { type: 'string' },
    hasSuggestion: { type: 'boolean' },
    suggestedFront: { type: 'string' },
    suggestedBack: { type: 'string' },
  },
  required: ['accurate', 'context', 'hasSuggestion', 'suggestedFront', 'suggestedBack'],
};
const FACTCHECK_SYSTEM =
  'You are a fact-checker for study flashcards. Given a card (question = front, answer = back), judge whether ' +
  'the answer is factually accurate and precise, and give 1-3 sentences of useful supporting context. If the ' +
  'answer is wrong, incomplete, or imprecise, set hasSuggestion true and provide a corrected front and back; ' +
  'otherwise set hasSuggestion false and echo the original front and back. Base everything on well-established, ' +
  'verifiable facts.';

app.post('/api/cards/:id/factcheck', requireUser, async (req, res) => {
  if (!anthropic) return res.status(503).json({ ok: false, error: 'AI is not configured on this server yet.' });
  const gate = await aiGate(req);
  if (gate) return res.status(gate.status).json(gate.body);
  const { data: card, error } = await req.db.from('cards').select('front, back').eq('id', req.params.id).maybeSingle();
  if (error || !card) return res.status(404).json({ ok: false, error: 'Card not found.' });

  let result;
  try {
    const msg = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 2000,
      system: FACTCHECK_SYSTEM,
      output_config: { format: { type: 'json_schema', schema: FACTCHECK_SCHEMA }, effort: 'low' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Question (front): ' + card.front + '\nAnswer (back): ' + card.back }] }],
    });
    if (msg.stop_reason === 'refusal') return res.status(422).json({ ok: false, error: 'The AI declined to check this card.' });
    const block = (msg.content || []).find((b) => b.type === 'text');
    result = JSON.parse(block?.text || '{}');
  } catch (ex) {
    console.error('[factcheck] failed:', ex?.message);
    return res.status(502).json({ ok: false, error: 'Fact-check failed. Please try again.' });
  }
  await recordAiUsage(req.db, req.user.id, 'factcheck'); // count the paid call against the quota
  return res.json({
    ok: true,
    accurate: !!result.accurate,
    context: String(result.context || ''),
    hasSuggestion: !!result.hasSuggestion,
    suggestedFront: String(result.suggestedFront || ''),
    suggestedBack: String(result.suggestedBack || ''),
  });
});

// FSRS scheduler (replaces SM-2). Cards migrated from SM-2 arrive as state=New
// and re-initialize on their next review. UI grade -> FSRS Rating mapping below.
const scheduler = fsrs(generatorParameters({ enable_fuzz: true }));
const GRADE_TO_RATING = { 0: Rating.Again, 3: Rating.Hard, 4: Rating.Good, 5: Rating.Easy };

// Grade a review with FSRS. grade: 0 Again, 3 Hard, 4 Good, 5 Easy.
app.post('/api/cards/:id/review', requireUser, async (req, res) => {
  const grade = Number(req.body?.grade);
  if (![0, 3, 4, 5].includes(grade)) {
    return res.status(400).json({ ok: false, error: 'Invalid grade.' });
  }
  const { data: row, error } = await req.db
    .from('cards')
    .select('id, deck_id, due_at, stability, difficulty, interval_days, repetitions, lapses, learning_steps, fsrs_state, last_review')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error || !row) return res.status(404).json({ ok: false, error: 'Card not found.' });

  const now = new Date();
  // Reconstruct the FSRS card from stored state (New cards start with zeros).
  const card = {
    due: row.due_at ? new Date(row.due_at) : now,
    stability: row.stability ?? 0,
    difficulty: row.difficulty ?? 0,
    elapsed_days: 0,
    scheduled_days: row.interval_days ?? 0,
    reps: row.repetitions ?? 0,
    lapses: row.lapses ?? 0,
    learning_steps: row.learning_steps ?? 0,
    state: row.fsrs_state ?? 0,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };

  let next;
  try {
    next = scheduler.next(card, now, GRADE_TO_RATING[grade]).card;
  } catch (ex) {
    console.error('[review] fsrs schedule failed:', ex?.message);
    return res.status(500).json({ ok: false, error: 'Could not schedule the review.' });
  }

  const dueAt = new Date(next.due).toISOString();
  const { error: upErr } = await req.db
    .from('cards')
    .update({
      due_at: dueAt,
      stability: next.stability,
      difficulty: next.difficulty,
      interval_days: next.scheduled_days,
      repetitions: next.reps,
      lapses: next.lapses,
      learning_steps: next.learning_steps,
      fsrs_state: next.state,
      last_review: new Date(next.last_review).toISOString(),
    })
    .eq('id', row.id);
  if (upErr) {
    console.error('[review] update failed:', upErr.message);
    return res.status(500).json({ ok: false, error: 'Could not save the review.' });
  }
  // Log the review for streaks / progress (best-effort).
  await req.db.from('reviews').insert({ user_id: req.user.id, card_id: row.id, deck_id: row.deck_id, grade })
    .then(({ error: e }) => { if (e) console.error('[review] log failed:', e.message); });

  return res.json({ ok: true, interval_days: next.scheduled_days, due_at: dueAt });
});

// Review queue: due cards across all decks, or one deck with ?deckId=.
app.get('/api/review/due', requireUser, async (req, res) => {
  const nowIso = new Date().toISOString();
  let q = req.db
    .from('cards')
    .select('id, card_type, front, back, hint, due_at, decks!inner(title)')
    .lte('due_at', nowIso);
  if (typeof req.query.deckId === 'string' && req.query.deckId) q = q.eq('deck_id', req.query.deckId);
  const { data, error } = await q
    .order('due_at', { ascending: true })
    .limit(300);
  if (error) {
    console.error('[review] due query failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not load due cards.' });
  }
  const cards = (data || []).map((c) => ({
    id: c.id, card_type: c.card_type, front: c.front, back: c.back, hint: c.hint,
    deckTitle: (c.decks && c.decks.title) || '',
  }));
  return res.json({ ok: true, cards });
});

// Dashboard + Progress numbers (all real — no fabricated values).
app.get('/api/stats', requireUser, async (req, res) => {
  const now = new Date();
  const nowIso = now.toISOString();
  const dayStr = (d) => d.toISOString().slice(0, 10);

  const [decks, cards, due] = await Promise.all([
    req.db.from('decks').select('id', { count: 'exact', head: true }),
    req.db.from('cards').select('id', { count: 'exact', head: true }),
    req.db.from('cards').select('id', { count: 'exact', head: true }).lte('due_at', nowIso),
  ]);
  const { data: revs, error: revErr } = await req.db
    .from('reviews').select('grade, reviewed_at').order('reviewed_at', { ascending: false }).limit(3000);
  if (revErr) console.error('[stats] reviews query failed:', revErr.message);

  const rows = revs || [];
  const days = new Set(rows.map((r) => r.reviewed_at.slice(0, 10)));
  // Streak: consecutive days with a review, ending today (or yesterday as grace).
  let streak = 0;
  const cur = new Date(now);
  if (!days.has(dayStr(cur))) cur.setUTCDate(cur.getUTCDate() - 1);
  while (days.has(dayStr(cur))) { streak++; cur.setUTCDate(cur.getUTCDate() - 1); }

  const today = dayStr(now);
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const reviewedToday = rows.filter((r) => r.reviewed_at.slice(0, 10) === today).length;
  const reviewed7d = rows.filter((r) => r.reviewed_at >= weekAgo).length;
  const good = rows.filter((r) => r.grade >= 4).length;
  const retentionPct = rows.length ? Math.round((good / rows.length) * 100) : null;

  return res.json({
    ok: true,
    decks: decks.count || 0,
    cards: cards.count || 0,
    due: due.count || 0,
    streak,
    reviewedToday,
    reviewed7d,
    totalReviews: rows.length,
    retentionPct,
  });
});

// Profile (first/last name). Email comes from the verified token, not the table.
app.get('/api/profile', requireUser, async (req, res) => {
  const { data, error } = await req.db.from('profiles').select('first_name, last_name, plan, access_requested_at').eq('id', req.user.id).maybeSingle();
  if (error) {
    console.error('[profile] load failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not load your profile.' });
  }
  return res.json({
    ok: true,
    email: req.user.email,
    firstName: data?.first_name || '',
    lastName: data?.last_name || '',
    plan: data?.plan || 'free',
    accessRequested: !!data?.access_requested_at,
  });
});

// Free user asks for AI access — flags the account for the admin approval queue.
app.post('/api/request-access', requireUser, async (req, res) => {
  const { error } = await req.db
    .from('profiles')
    .upsert({ id: req.user.id, access_requested_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) {
    console.error('[access] request failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not submit your request.' });
  }
  return res.json({ ok: true });
});

app.patch('/api/profile', requireUser, async (req, res) => {
  const firstName = typeof req.body?.firstName === 'string' ? req.body.firstName.trim().slice(0, 80) : '';
  const lastName = typeof req.body?.lastName === 'string' ? req.body.lastName.trim().slice(0, 80) : '';
  const { error } = await req.db
    .from('profiles')
    .upsert({ id: req.user.id, first_name: firstName || null, last_name: lastName || null, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) {
    console.error('[profile] save failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not save your profile.' });
  }
  return res.json({ ok: true });
});

// Manual card reorder: persist 1-based positions for the given ordered ids.
app.post('/api/decks/:id/cards/reorder', requireUser, async (req, res) => {
  const ids = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.slice(0, 1000) : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: 'No card order provided.' });
  // One scoped update per card (RLS ensures only the caller's cards in this deck change).
  for (let i = 0; i < ids.length; i++) {
    const { error } = await req.db.from('cards').update({ sort_order: i + 1 }).eq('id', ids[i]).eq('deck_id', req.params.id);
    if (error) {
      console.error('[cards] reorder failed:', error.message);
      return res.status(500).json({ ok: false, error: 'Could not save the new order.' });
    }
  }
  return res.json({ ok: true });
});

// ── Notes (Evernote-like: notebooks + notes) ────────────────────────────────
// RLS-scoped to the owner (like decks/cards). Free to use — no AI, no plan gate.
// Body is plain text / light markdown; the client renders it.
const NOTE_TITLE_MAX = 200;
const NOTE_BODY_MAX = 100_000;
const NB_NAME_MAX = 80;

// List the caller's notebooks (newest first) with a note count each.
app.get('/api/notebooks', requireUser, async (req, res) => {
  const { data, error } = await req.db
    .from('notebooks')
    .select('id, name, created_at, notes(count)')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[notebooks] list failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not load notebooks.', detail: error.message });
  }
  const notebooks = (data || []).map((n) => ({
    id: n.id, name: n.name, created_at: n.created_at,
    noteCount: Array.isArray(n.notes) && n.notes[0] ? n.notes[0].count : 0,
  }));
  return res.json({ ok: true, notebooks });
});

app.post('/api/notebooks', requireUser, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ ok: false, error: 'A notebook name is required.' });
  const { data, error } = await req.db
    .from('notebooks')
    .insert({ user_id: req.user.id, name: name.slice(0, NB_NAME_MAX) })
    .select('id, name, created_at')
    .single();
  if (error) {
    console.error('[notebooks] create failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not create the notebook.' });
  }
  return res.json({ ok: true, notebook: { ...data, noteCount: 0 } });
});

app.patch('/api/notebooks/:id', requireUser, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ ok: false, error: 'A notebook name is required.' });
  const { error } = await req.db.from('notebooks').update({ name: name.slice(0, NB_NAME_MAX) }).eq('id', req.params.id);
  if (error) {
    console.error('[notebooks] rename failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not rename the notebook.' });
  }
  return res.json({ ok: true });
});

// Delete a notebook. Its notes are kept (notebook_id -> null via FK) so nothing is lost.
app.delete('/api/notebooks/:id', requireUser, async (req, res) => {
  const { error } = await req.db.from('notebooks').delete().eq('id', req.params.id);
  if (error) {
    console.error('[notebooks] delete failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not delete the notebook.' });
  }
  return res.json({ ok: true });
});

// List notes, newest-edited first. ?notebookId=<id> filters to one notebook;
// ?notebookId=none returns unfiled notes. Returns metadata + a short snippet.
app.get('/api/notes', requireUser, async (req, res) => {
  let q = req.db
    .from('notes')
    .select('id, notebook_id, title, body, updated_at')
    .order('updated_at', { ascending: false })
    .limit(500);
  const nb = req.query.notebookId;
  if (nb === 'none') q = q.is('notebook_id', null);
  else if (typeof nb === 'string' && nb) q = q.eq('notebook_id', nb);
  // Optional search: match title OR body, case-insensitive. Strip PostgREST filter
  // metacharacters so a user term can't break out of / manipulate the .or() grammar.
  const term = typeof req.query.q === 'string'
    ? req.query.q.replace(/[%,()*\\:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
    : '';
  if (term) q = q.or(`title.ilike.%${term}%,body.ilike.%${term}%`);
  const { data, error } = await q;
  if (error) {
    console.error('[notes] list failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not load notes.', detail: error.message });
  }
  const notes = (data || []).map((n) => ({
    id: n.id,
    notebook_id: n.notebook_id,
    title: n.title || '',
    // Body may be HTML (rich editor) or plain/markdown — strip tags for the snippet.
    snippet: (n.body || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140),
    updated_at: n.updated_at,
  }));
  return res.json({ ok: true, notes });
});

// Create a note (blank is fine — the editor saves as you type).
app.post('/api/notes', requireUser, async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, NOTE_TITLE_MAX) : '';
  const body = typeof req.body?.body === 'string' ? req.body.body.slice(0, NOTE_BODY_MAX) : '';
  const notebookId = typeof req.body?.notebookId === 'string' && req.body.notebookId ? req.body.notebookId : null;
  const { data, error } = await req.db
    .from('notes')
    .insert({ user_id: req.user.id, notebook_id: notebookId, title, body })
    .select('id, notebook_id, title, body, created_at, updated_at')
    .single();
  if (error) {
    console.error('[notes] create failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not create the note.' });
  }
  return res.json({ ok: true, note: data });
});

// Full single note (for the editor).
app.get('/api/notes/:id', requireUser, async (req, res) => {
  const { data, error } = await req.db
    .from('notes')
    .select('id, notebook_id, title, body, created_at, updated_at')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) {
    console.error('[notes] get failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not load the note.' });
  }
  if (!data) return res.status(404).json({ ok: false, error: 'Note not found.' });
  return res.json({ ok: true, note: data });
});

// Update a note (autosave). Any of title/body/notebookId; touches updated_at so it
// sorts to the top. notebookId can be null to unfile.
app.patch('/api/notes/:id', requireUser, async (req, res) => {
  const patch = { updated_at: new Date().toISOString() };
  if (typeof req.body?.title === 'string') patch.title = req.body.title.slice(0, NOTE_TITLE_MAX);
  if (typeof req.body?.body === 'string') patch.body = req.body.body.slice(0, NOTE_BODY_MAX);
  if ('notebookId' in (req.body || {})) {
    patch.notebook_id = typeof req.body.notebookId === 'string' && req.body.notebookId ? req.body.notebookId : null;
  }
  const { error } = await req.db.from('notes').update(patch).eq('id', req.params.id);
  if (error) {
    console.error('[notes] update failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not save the note.' });
  }
  return res.json({ ok: true, updated_at: patch.updated_at });
});

app.delete('/api/notes/:id', requireUser, async (req, res) => {
  const { error } = await req.db.from('notes').delete().eq('id', req.params.id);
  if (error) {
    console.error('[notes] delete failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not delete the note.' });
  }
  return res.json({ ok: true });
});

// ── Billing: RevenueCat webhook ─────────────────────────────────────────────
// RevenueCat is the entitlement source of truth across iOS (Apple IAP) and web
// (Stripe). It POSTs subscription events here; we map them to profiles.plan.
// Auth: RevenueCat sends the Authorization header we configure in its dashboard.
// app_user_id is the Supabase user id (set client-side via Purchases.logIn).
const RC_GRANT = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_EXTENDED', 'TRANSFER']);
const RC_REVOKE = new Set(['EXPIRATION']);
// Note: CANCELLATION = auto-renew off but still active until EXPIRATION → no change.
// BILLING_ISSUE → keep access (grace); mark status only.

app.post('/api/rc/webhook', async (req, res) => {
  if (!REVENUECAT_WEBHOOK_SECRET) return res.status(503).json({ ok: false });
  const auth = (req.headers.authorization || '').toString();
  if (auth !== 'Bearer ' + REVENUECAT_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false });
  }
  if (!supabase) return res.status(503).json({ ok: false });

  const ev = req.body && req.body.event;
  const userId = ev && ev.app_user_id;
  const type = ev && ev.type;
  if (!userId || !type) return res.json({ ok: true }); // nothing actionable

  const patch = {};
  if (RC_GRANT.has(type)) { patch.plan = 'pro'; patch.subscription_status = type === 'INITIAL_PURCHASE' && ev.period_type === 'TRIAL' ? 'trialing' : 'active'; }
  else if (RC_REVOKE.has(type)) { patch.plan = 'free'; patch.subscription_status = 'expired'; }
  else if (type === 'CANCELLATION') { patch.subscription_status = 'canceled'; } // keep pro until expiration
  else if (type === 'BILLING_ISSUE') { patch.subscription_status = 'billing_issue'; }
  else return res.json({ ok: true }); // ignore other event types

  if (ev.store) patch.subscription_store = String(ev.store).toLowerCase();
  if (ev.expiration_at_ms) patch.current_period_end = new Date(Number(ev.expiration_at_ms)).toISOString();

  // Service-role client: this is a trusted server-to-server call (no user JWT).
  const { error } = await supabase.from('profiles').upsert({ id: userId, ...patch }, { onConflict: 'id' });
  if (error) {
    console.error('[rc] profile update failed:', error.message);
    return res.status(500).json({ ok: false });
  }
  console.log('[rc]', type, '→', patch.plan || patch.subscription_status, 'for', userId);
  return res.json({ ok: true });
});

// ── Admin dashboard (Supabase Auth, superuser-gated, READ-ONLY) ─────────────
// Login is proxied through the server so Supabase keys never touch the browser.
// Only emails in SUPERUSER_EMAILS may sign in or read admin data. Every DB call
// below is a SELECT — no insert/update/delete/truncate is ever performed here.

// POST /api/admin/login { email, password } -> { token, name }
// Verifies the password via Supabase Auth, gated on the superuser allowlist.
app.post('/api/admin/login', async (req, res) => {
  const ip = clientIp(req);
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

// Admin: list users (profiles + emails), access-requests first — the approval queue.
app.get('/api/admin/users', requireSuperuser, async (_req, res) => {
  const { data: profs, error } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, plan, access_requested_at')
    .order('access_requested_at', { ascending: false, nullsFirst: false });
  if (error) {
    console.error('[admin] users query failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Failed to load users.' });
  }
  const emailById = {};
  try {
    const { data: list } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    (list?.users || []).forEach((u) => { emailById[u.id] = u.email; });
  } catch (ex) { console.error('[admin] listUsers failed:', ex?.message); }
  const users = (profs || []).map((p) => ({
    id: p.id,
    email: emailById[p.id] || '',
    firstName: p.first_name || '',
    lastName: p.last_name || '',
    plan: p.plan || 'free',
    accessRequestedAt: p.access_requested_at,
  }));
  return res.json({ ok: true, users });
});

// Admin: set a user's plan — approve (→ 'pro') or revoke (→ 'free').
app.post('/api/admin/users/:id/plan', requireSuperuser, async (req, res) => {
  const plan = req.body?.plan === 'pro' ? 'pro' : 'free';
  const { error } = await supabase.from('profiles').upsert({ id: req.params.id, plan }, { onConflict: 'id' });
  if (error) {
    console.error('[admin] set plan failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Could not update the user.' });
  }
  return res.json({ ok: true, plan });
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

// KaTeX (math rendering) — served from node_modules so its CSS-referenced fonts
// resolve under the same /vendor/katex path.
app.use('/vendor/katex', express.static(join(__dirname, '..', 'node_modules', 'katex', 'dist'), { maxAge: '7d' }));

// Serve the static landing page.
app.use(express.static(SITE_DIR, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(join(SITE_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`Krakenote site listening on :${PORT} (supabase: ${Boolean(supabase)})`);
});
