# Staging test plan — PR #10 (freemium) + PR #11 (security)

Manual test pass for the two open PRs, on **staging**. Credentials are shared
separately (not committed). Check items off as you go.

## Where things are
| | URL |
|---|---|
| Web app | https://krakenote-staging.up.railway.app/app |
| Admin dashboard | https://krakenote-staging.up.railway.app/admin |

**Accounts**
- **Admin (superuser):** `abanks47@gmail.com` — password shared in chat. Admin login is by email allowlist, so only this account can open `/admin`.
- **Pro tester (already approved):** `krakenote-e2e@example.com` / `e2e-Test-123456` — use for the AI + security tests.
- **A fresh free account:** sign one up in the app during the freemium test below.

**Study material to feed the AI:** paste text from any file in `test-assets/`
(`cell-respiration.md`, `physics-kinematics.md`, `chemistry-basics.md`), upload a
PDF/image, or use a real article URL like
`https://en.wikipedia.org/wiki/Photosynthesis`.

---

## PR #10 — Cost-safe freemium access

### A. Free tier can use the manual study loop (no AI)
Sign up a **brand-new email** at `/app` (this becomes your free test account).
- [ ] Signup lands you in the app on the free tier.
- [ ] Create a deck, add cards **manually**, and **CSV import** cards — all work.
- [ ] Review (FSRS) and quizzes work on those cards.

### B. Free caps are enforced
- [ ] Create decks until you hit **2** — the 3rd is blocked with a "free plan is limited to 2 decks" message.
- [ ] Add cards until you approach **50** — going over is blocked with the free-card-limit message.

### C. AI is gated for free users (no Claude call happens)
- [ ] Open a deck → **Generate** → you get the upgrade / "request access" modal, **not** a generation.
- [ ] **Fact-check** a card → same upgrade prompt.
- [ ] Click **Request access** (in the modal or on the Account page) → you see a confirmation.

### D. Admin approval unlocks AI — *this is the "toggle AI usage" flow*
1. Open `/admin` and log in as the admin account.
2. In the **Users & access** panel, find your free test account (accounts that requested access sort to the top).
3. Click **Approve** → the plan flips to **Pro**.
- [ ] Back in `/app` as that user (reload), **Generate** now works and produces cards.
- [ ] In `/admin`, click **Revoke** on that user → plan returns to **Free**.
- [ ] Reload the app as that user → **Generate** is gated again.

---

## PR #11 — Security hardening
Do these signed in as the **Pro tester** (or your just-approved account).

### E. Normal AI generation still works (didn't break ingestion)
- [ ] Generate from a **real article URL** (e.g. the Photosynthesis link) → cards appear.
- [ ] Generate from **pasted text** (a `test-assets` note) → cards appear.

### F. SSRF guard blocks internal/metadata targets
In a deck, use **Generate → URL** with each of these. Each should fail with
**"That link points to a private or internal address, which is not allowed."**
- [ ] `http://169.254.169.254/latest/meta-data/`  (cloud metadata)
- [ ] `http://localhost:3000/`
- [ ] `http://127.0.0.1/`
- [ ] `http://[::1]/`

### G. Per-user AI rate limit
- [ ] Click **Generate** rapidly ~9 times in under a minute → after the 8th you get a **"generating too fast"** (HTTP 429) message, then it recovers after a minute.
- (The rolling 24-hour quota is 50 generations/user — not practical to hit by hand; it's there as the hard cost cap.)

### H. Security headers (optional, via browser DevTools → Network)
- [ ] A response to any page has **no** `X-Powered-By` header.
- [ ] It **has** `x-content-type-options: nosniff`, `x-frame-options`, and `strict-transport-security`.

---

## Notes
- Env knobs on staging (defaults): `AI_BURST_PER_MIN=8`, `AI_DAILY_LIMIT=50`, `TRUST_PROXY_HOPS=1`.
- The `ai_usage` table (rolling quota) is already migrated on staging; it still needs applying to prod during prod setup.
- Google sign-in button shows a graceful "not available yet" until the Supabase Google provider is configured.
