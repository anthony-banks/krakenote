# Krakenote — Code & Security Review Findings

**Date:** 2026-08-01
**Reviewer:** Claude (Claude Code)
**Commit reviewed:** `7b3eabf` (tip of `main`)
**Scope:** `server/index.js`, `supabase/migrations/*`, `site/app.html`, `site/admin.html`, config & docs
**Purpose:** Full pre-launch review ahead of two workstreams — the **iOS companion app** and **Stripe / payments** — with the explicit goal of getting Krakenote to industry standard.

---

## How to use this document

Each finding has a stable ID (`KRK-NNN`), a severity, the exact location, the impact, a concrete
recommended fix, and an effort estimate. Findings are independent unless a **Depends on** note says
otherwise. An agent picking this up can work top-down by severity; **KRK-001 must land before any
payments code.**

Severity legend:

| Severity | Meaning |
|---|---|
| 🔴 **Critical** | Exploitable now; direct security or revenue loss. Fix immediately. |
| 🟠 **High** | Real risk; must clear before public launch. |
| 🟡 **Medium** | Should fix before scaling / GA; not immediately exploitable. |
| ⚪ **Low / Nit** | Hardening, hygiene, correctness-at-scale, or polish. |
| 🟢 **Positive** | Done right — documented so it isn't regressed. |

Severity is about impact, not effort — some Critical fixes are one migration.

---

## Summary table

| ID | Severity | Area | Finding |
|----|----------|------|---------|
| KRK-001 | 🔴 Critical | AuthZ / DB | Users can grant themselves `plan = 'pro'` via direct PostgREST write (entitlement bypass) |
| KRK-002 | 🟠 High | Auth | Email ownership never verified (`email_confirm: true`) on open signup |
| KRK-003 | 🟠 High | API / Mobile | No API versioning — breaking changes will orphan shipped mobile clients |
| KRK-004 | 🟡 Medium | Rate limiting | In-memory limiter is per-replica & resets on deploy (auth brute-force weakens at scale) |
| KRK-005 | 🟡 Medium | Quality | No automated tests or CI pipeline |
| KRK-006 | 🟡 Medium | Web security | CSP disabled; heavy inline scripts leave XSS blast radius unmitigated |
| KRK-007 | 🟡 Medium | Observability | No structured logging, error monitoring, or request correlation |
| KRK-008 | 🟡 Medium | SSRF | Residual DNS-rebinding gap in the URL fetch guard (acknowledged in code) |
| KRK-009 | 🟡 Medium | Docs | Companion-app platform contradiction (SwiftUI vs React Native) across docs |
| KRK-010 | ⚪ Low | Info disclosure | Raw DB error string returned to client in `/api/decks` |
| KRK-011 | ⚪ Low | Data integrity | No DB `CHECK` constraints on enums/grades; direct writes can violate invariants |
| KRK-012 | ⚪ Low | Abuse | Users can insert arbitrary `reviews` rows (inflate streak/retention stats) |
| KRK-013 | ⚪ Low | Compliance | No account-deletion or data-export path (GDPR/CCPA, App Store 5.1.1(v)) |
| KRK-014 | ⚪ Low | DoS / cost | Non-AI authenticated endpoints unthrottled; 12 MB upload decoded in memory |
| KRK-015 | ⚪ Low | Scale | `/api/stats` pulls up to 3000 rows to compute in JS; admin `listUsers` capped at 1000 |
| KRK-016 | ⚪ Low | Supply chain | No `npm audit` / Dependabot; scraper deps (`youtube-transcript`, article-extractor) are fragile |
| KRK-017 | ⚪ Low | Cost | Default model is `claude-opus-4-8` (expensive) for generation |
| — | 🟢 Positive | — | See "What's already done right" |

---

## Critical

### KRK-001 — Users can self-grant `plan = 'pro'` (entitlement bypass)

**Severity:** 🔴 Critical
**Area:** Authorization / Row-Level Security
**Location:** `supabase/migrations/20260729120000_profiles.sql` (grants + policy), `supabase/migrations/20260730170000_access_plan.sql` (adds `plan`)

**Description.** The `profiles` table grants `authenticated` full-column `UPDATE`, and its RLS policy is
row-scoped but **not** column-scoped:

```sql
grant select, insert, update on public.profiles to authenticated;   -- every column
create policy "own profile" on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());       -- no column guard
```

The `plan` column — the entire freemium/entitlement boundary — lives on this table. The browser
legitimately holds the Supabase **anon key** (served publicly by `GET /api/config`) and the signed-in
user's **JWT** (`sb.auth.getSession()`). That is everything needed to call PostgREST directly and
bypass the Express server:

```js
// Run in the browser console as any signed-in free user:
sb.from('profiles').update({ plan: 'pro' }).eq('id', MY_USER_ID)
// RLS check: id === auth.uid() → passes. UPDATE is granted. No column restriction. → succeeds.
```

**Impact.**
- Any free user unlocks the paid AI endpoints (`/generate`, `/factcheck`) → **direct Anthropic spend** on your account, and the daily quota is Pro-tier.
- Free deck/card caps are lifted.
- **This voids payments before they exist:** once a Stripe/Apple webhook sets `plan = 'pro'` on payment, users can set it themselves and never pay. Every billing column you later add to `profiles` (`stripe_customer_id`, `subscription_status`, `current_period_end`, …) inherits the identical writable-by-user flaw.

The server code is disciplined (only name fields are written via `/api/profile`; admin sets `plan`
via the service-role client) — but the hole is at the **database grant layer**, so no amount of
app-side care closes it.

**Recommended fix.** Two options; do at least (A), prefer (B) for the billing era.

**(A) Minimal — column-scoped grant so `plan` is not user-writable:**

```sql
-- New migration, e.g. 20260801_lock_plan_column.sql
revoke update on public.profiles from authenticated;
grant update (first_name, last_name, updated_at, access_requested_at)
  on public.profiles to authenticated;
```

The admin plan-setter and future payment webhook use the **service-role** client, which bypasses
grants and RLS, so nothing server-side breaks. Verify `/api/profile` (writes name + `updated_at`) and
`/api/request-access` (writes `access_requested_at`) still succeed after the change.

**(B) Preferred — move entitlements to their own table, read-only to users:**

```sql
create table public.entitlements (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  plan         text not null default 'free',
  source       text,                 -- 'admin' | 'stripe' | 'apple'
  status       text,                 -- 'active' | 'canceled' | 'past_due' | ...
  current_period_end timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.entitlements enable row level security;
grant select on public.entitlements to authenticated;         -- read-only
create policy "read own entitlement" on public.entitlements
  for select using (user_id = auth.uid());
-- No insert/update/delete grant to authenticated → only service_role writes.
```

This is the shape you want for Stripe **and** Apple IAP (see KRK-payments), keeps billing state
un-spoofable, and cleanly separates identity (`profiles`) from entitlement.

**Effort:** ~1–2 hrs incl. server `getPlan()` repoint + a regression check.
**Verification:** as a normal user token, a direct `update({plan:'pro'})` must return a permissions error; admin approval and (later) the webhook must still flip the plan.

---

## High

### KRK-002 — Email ownership is never verified

**Severity:** 🟠 High
**Area:** Authentication
**Location:** `server/index.js:193-197` (`email_confirm: true`)

**Description.** Signup calls `auth.admin.createUser({ email_confirm: true })`, marking every address
confirmed without a verification round-trip. With **open** registration (changed in #10), anyone can
register any address they don't own.

**Impact.** Spam/abuse account creation; no trustworthy email for password reset, receipts, or
transactional mail; a real user can be locked out of "their" address because someone else claimed it
first. It also undermines any future email-based billing communication.

**Recommended fix.** Enable real email confirmation before public launch — either Supabase's built-in
confirmation flow (configure SMTP; the default sender is rate-limited and unsuitable for production —
wire a provider like Resend/Postmark/SES) or a magic-link flow. Gate AI/paid features on a confirmed
address. Already tracked as a release blocker in `docs/ROADMAP.md`; this formalizes it.

**Effort:** ~0.5–1 day incl. SMTP provider setup.

---

### KRK-003 — No API versioning (mobile clients can't be force-updated)

**Severity:** 🟠 High (for the mobile workstream)
**Area:** API design
**Location:** all routes are `/api/...` (e.g. `server/index.js:290`, `617`, `850`)

**Description.** Endpoints are unversioned. A web app you deploy continuously can tolerate this; a
**mobile app in the App Store cannot** — installed copies keep calling the old contract, and Apple
review + user upgrade lag means you cannot atomically migrate clients. A breaking change to, say,
`/api/decks` silently breaks every shipped version.

**Recommended fix.** Introduce a version prefix **now**, before the mobile client is written, so the
contract is stable from its first release:

```
/api/v1/decks, /api/v1/cards/:id/review, ...
```

Keep `/api/*` as an alias during the web transition if convenient. Adopt a deprecation policy (support
N-1 for a defined window). Pair with a lightweight `GET /api/v1/health` that returns a `minClient`
version so the app can prompt "update required."

**Effort:** ~2–3 hrs (route mount refactor + doc update).
**Depends on:** resolve KRK-009 (which client) first so the contract targets the right platform.

---

## Medium

### KRK-004 — In-memory rate limiter is per-replica and volatile

**Severity:** 🟡 Medium
**Location:** `server/index.js:79-96`

The limiter lives in a per-process `Map`; it resets on deploy and is not shared across Railway
replicas, so the effective limit is `max × replica_count`, and a deploy clears an attacker's counter.
The durable 24 h **AI quota** (DB-backed) correctly caps *cost*, so this is not a spend risk — but the
**auth brute-force** protection on `/api/admin/login`, `/api/auth/signup`, and `/api/waitlist` weakens
as you scale out. **Fix:** back the limiter with Redis/Upstash (or a Postgres table) keyed on
`req.ip`, once you run more than one replica. Acknowledged in-code as a known upgrade.

### KRK-005 — No automated tests or CI

**Severity:** 🟡 Medium
**Location:** repo-wide (`.github/workflows/` absent; only `docs/STAGING-TEST-PLAN.md`, a manual plan)

For an "industry standard" bar this is the biggest process gap. There is no unit/integration test and
no CI gate, so regressions in the security-critical paths (SSRF guard, RLS assumptions, AI gating,
FSRS math) can ship unnoticed. **Fix:** add a test runner (Vitest/Jest + Supertest) with, at minimum:
`assertPublicHost`/`ipIsPrivate`/`embeddedV4` unit tests (SSRF is exactly the kind of logic that
silently rots), an `aiGate` test, and a couple of auth/RLS integration tests against a local Supabase.
Add a GitHub Actions workflow running `npm ci`, lint, `npm audit`, and the tests on every PR. Wire a
SessionStart hook (see the `session-start-hook` skill) so web sessions can run them too.

### KRK-006 — Content-Security-Policy disabled; inline scripts everywhere

**Severity:** 🟡 Medium
**Location:** `server/index.js:66` (`helmet({ contentSecurityPolicy: false })`); `site/app.html`, `site/admin.html` are single-file with large inline `<script>`

Card content is rendered with `textContent` (good — see Positives), so there is no *known* injection
today, but with CSP off, **any** future HTML-sink mistake becomes a full XSS with no second line of
defense. The single-file inline-script structure is what blocks a strict policy. **Fix (sequenced):**
extract inline JS/CSS to served files, then enable a nonce- or hash-based CSP (`default-src 'self'`,
explicit `connect-src` for the Supabase origin, no `unsafe-inline`). This also unblocks a cleaner
mobile webview story if one is ever used. The rationale is already documented in-code; this tracks the
follow-through.

### KRK-007 — No production observability

**Severity:** 🟡 Medium
**Location:** error handling is `console.error(...)` throughout

There is no structured logging, no error-tracking (Sentry/equivalent), no request IDs, and no metrics.
In production you'll be blind to error spikes, latency, and AI-spend anomalies. **Fix:** add a JSON
logger (pino) with a per-request correlation id, an error monitor with alerting, and a minimal
dashboard for AI usage/cost. Add an alert on abnormal `ai_usage` growth as a spend circuit-breaker.

### KRK-008 — Residual DNS-rebinding gap in SSRF guard

**Severity:** 🟡 Medium
**Location:** `server/index.js:468-505` (`assertPublicHost` + `safeFetch`)

The guard resolves and validates the host, then calls `fetch`, which resolves **again** — a hostile
DNS server can return a public IP to the check and a private IP to the fetch (TOCTOU). The code already
documents this as a known residual. **Fix (when hardening):** resolve once, validate, then fetch with a
**pinned IP** via a custom `undici` dispatcher/agent (or connect to the validated IP with a `Host`
header), so the address used for the check is the address actually dialed. Everything else here
(redirect re-validation, IPv4-in-IPv6 unwrapping, metadata/loopback/ULA blocks) is already solid.

### KRK-009 — Companion-app platform contradicts itself across docs

**Severity:** 🟡 Medium (decision hygiene)
**Location:** `CLAUDE.md` & `docs/PRD.md` say **iOS / SwiftUI**; `docs/ROADMAP.md` (2026-07-30) says **React Native + Expo, separate repo**

These disagree on the single most consequential mobile decision. The backend serves either identically,
but the API contract, auth integration (supabase-swift vs supabase-js), and the App Store payment path
differ. **Fix:** pick one, record it as a locked decision in the PRD, and delete the contradiction.
This gates KRK-003 and the payments design.

---

## Low / Nits

### KRK-010 — Raw DB error returned to client
`server/index.js:299` returns `detail: error.message` in the `/api/decks` 500 response, leaking
internal DB/Postgres error text to the browser. No other handler does this. **Fix:** log server-side,
return a generic message (as the other handlers already do).

### KRK-011 — No DB `CHECK` constraints; app-layer-only invariants
`card_type` ('basic'|'cloze'), `plan` ('free'|'pro'), `grade` (0/3/4/5), and `fsrs_state` (0–3) are
enforced only in Express. Because RLS grants `authenticated` direct write access, a crafted PostgREST
call can store out-of-domain values (e.g. `grade = 99`, arbitrary `card_type`). **Fix:** add `CHECK`
constraints in a migration so the database is the last line of defense regardless of client. (After
KRK-001, `plan` becomes non-writable, but the others remain user-writable.)

### KRK-012 — Users can forge review history
`grant select, insert on public.reviews to authenticated` + own-row RLS lets a user insert arbitrary
`reviews` rows directly, inflating their own streak/retention numbers (`/api/stats`). Impact is limited
to *their own* cosmetic stats, but it's a data-integrity hole and pairs with KRK-011 (no `grade`
check). **Fix:** add a `grade` CHECK, and consider funnelling review writes exclusively through the
server (revoke direct `insert`, insert via a `SECURITY DEFINER` RPC or service role) if leaderboards or
social proof ever depend on these numbers.

### KRK-013 — No account deletion / data export
There's no user-facing "delete my account" or "export my data" path (Supabase cascades exist at the DB
level, but nothing surfaces them). This is a **GDPR/CCPA** requirement and an **App Store 5.1.1(v)**
requirement (apps with account creation must offer in-app account deletion). **Fix:** add authenticated
`DELETE /api/v1/account` (server deletes the auth user via admin API → cascades) and a data-export
endpoint before public/App-Store launch.

### KRK-014 — Unthrottled data endpoints; large in-memory uploads
Non-AI authenticated routes (deck/card CRUD, reorder) have no Express-layer rate limit, and
`/api/decks` accepts a 12 MB JSON body that is base64-decoded to a Buffer in memory (docx/pptx path).
Concurrent large uploads are a memory-pressure/DoS vector, and CRUD can be hammered. Cost is bounded
(no Claude calls) and RLS-scoped, so severity is low. **Fix:** a modest per-user rate limit on writes,
an explicit decoded-size cap, and a per-user concurrency guard on ingestion.

### KRK-015 — Queries that won't scale
`/api/stats` pulls up to 3000 review rows and computes streak/retention in JS (`server/index.js:945`);
admin `listUsers({ perPage: 1000 })` (`:1150`) silently truncates past 1000 users. Both are fine at
current scale. **Fix:** move stats to SQL aggregates (a view or RPC) and paginate the admin user list
before you cross those thresholds.

### KRK-016 — Supply chain / dependency hygiene
No `npm audit` in CI, no Dependabot, and two fragile scraper deps (`youtube-transcript`,
`@extractus/article-extractor`) that break when upstream sites change. **Fix:** enable Dependabot +
`npm audit` in CI (folds into KRK-005); add graceful-degradation tests for the scrapers and clear user
messaging when they fail (already partially handled in `fetchYouTube`).

### KRK-017 — Expensive default model
`AI_MODEL` defaults to `claude-opus-4-8` (`server/index.js:48`). Generation runs at `max_tokens: 16000`
per call; at scale on Opus that's a meaningful cost. The env override exists — **set an explicit,
cheaper default** (e.g. a Haiku/Sonnet tier) for generation and reserve the top model for fact-check or
Pro tiers, so cost is a deliberate choice rather than a default.

---

## What's already done right (🟢 — don't regress these)

- **RLS as the real boundary.** Every user route rebuilds a request-scoped client bound to the caller's JWT; ownership is enforced by Postgres, not app code. Service-role key is strictly server-side.
- **SSRF guard** (KRK-008 aside) is thorough: DNS validation, private/loopback/link-local/CGNAT/ULA + metadata blocks, IPv4-in-IPv6 unwrapping, manual redirect following with per-hop re-validation, and the article extractor is fed pre-fetched HTML so it can't fetch around the guard.
- **AI cost controls:** plan gate + in-memory burst + durable 24 h DB quota; `ai_usage` grants `select, insert` only (no delete) so users can't wipe usage to reset quota.
- **Bearer-token auth, not cookies** → no CSRF surface. Correct choice, and it's also ideal for mobile.
- **Structured AI outputs** validated against JSON schemas; all model output re-clamped server-side before storage.
- **XSS-safe rendering:** card content via `textContent`; fact-check output via an `escapeHtml` helper.
- **Consistent input validation & length clamping** across every write path.
- **`helmet`, `trust proxy` with a fixed hop count, honeypot on the waitlist** — all correct.
- **Admin surface is SELECT-only and allowlist-gated** before auth is attempted.
- **Migrations are idempotent and additive** (safe re-apply; SM-2 columns kept for rollback).

---

## Forward-looking: iOS companion app readiness

The backend is a good fit for a mobile client — **stateless JWT REST API**, RLS-enforced, no
server-side session. Concrete items before/while building it:

1. **Resolve KRK-009** (SwiftUI vs React Native) and **do KRK-003** (versioned API) first.
2. **Profile/entitlement seeding.** The free-tier `profiles` row is seeded only inside server
   `/api/auth/signup` (`server/index.js:208-212`). A mobile client that signs up **directly** via the
   Supabase SDK won't create it (it works by luck via lazy upserts, but the account won't appear in the
   admin queue until it writes something). **Fix:** add a Postgres trigger that seeds `profiles`
   (and, post-KRK-001, `entitlements`) on `auth.users` insert — robust across every client and provider,
   including Google/Apple sign-in.
3. **Sign in with Apple is mandatory** if Google login is offered in an iOS app (App Store Guideline
   4.8). Already on the roadmap — flagging it as a hard gate.
4. **Account deletion in-app** (KRK-013) is an App Store review requirement.
5. **CORS** isn't needed for native iOS, but will be if a web build is ever served from a different
   origin. No action now; note it.

## Forward-looking: Stripe / payments architecture

Read before implementing — two realities shape the whole design:

1. **KRK-001 is a hard prerequisite.** Paid gating is meaningless while users can set their own plan.
   Build on the read-only `entitlements` table (KRK-001 option B).
2. **Apple will not allow Stripe for in-app digital subscriptions on iOS** (Guideline 3.1.1). The
   payment path is therefore split and must reconcile to one entitlement:
   - **Web → Stripe** (Checkout + webhook).
   - **iOS → StoreKit / In-App Purchase**, with **App Store Server Notifications v2 → your server → set entitlement**.
   - Model the entitlement **provider-agnostic** (`source`, `status`, `current_period_end`), not as a Stripe-only flag.
   - **RevenueCat** (already on your shortlist) unifies Stripe + Apple (+ Google) into one entitlement and one webhook — strongly worth adopting to avoid two-sided reconciliation.
3. **Stripe webhook mechanics** (a footgun with the current setup): signature verification needs the
   **raw body**, but there's a global `express.json()`. Mount `express.raw({ type: 'application/json' })`
   on the webhook route **before** the JSON parsers, verify `stripe-signature`, make the handler
   **idempotent** (dedupe on Stripe event id), and write the entitlement via the **service-role**
   client. Never trust the client to self-report payment — the webhook is the source of truth.
4. **Checkout endpoint:** authenticated route creates a Stripe Checkout Session, stores
   `stripe_customer_id` server-side (never user-writable), and ties it to the Supabase user id.

---

## Suggested remediation order

1. **KRK-001** (entitlement lockdown) — before any payments work. *Blocking.*
2. **KRK-009** (pick the mobile platform) → **KRK-003** (versioned API) — before the mobile client. *Blocking for mobile.*
3. **KRK-002** (email verification), **KRK-013** (account deletion) — before public / App-Store launch.
4. **KRK-005** (tests + CI), **KRK-007** (observability) — foundational; unblocks safe iteration on everything else.
5. **KRK-006, KRK-008, KRK-004** — security hardening pass.
6. **KRK-010 … KRK-017** — hygiene/scale, batchable.

---

*Findings are point-in-time against commit `7b3eabf`. No application code was changed in the PR that
carries this document — it is a review artifact only.*
