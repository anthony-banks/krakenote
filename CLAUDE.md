# CLAUDE.md — Krakenote

Guidance for Claude Code when working in this repository.

## 🚨 Critical safety rule — database mutations

**NEVER clear, delete, truncate, drop, or bulk-mutate any database — test OR production — unless the user has, in that same conversation, manually typed `CONFIRM` in all caps.**

- This applies to every environment: the production Supabase project, the staging Supabase project, and any future database.
- It covers `DELETE`, `TRUNCATE`, `DROP`, bulk `UPDATE`, and any REST/SQL call that removes or overwrites rows in bulk.
- Reads (`SELECT`), single-row inserts for verification, and schema-additive migrations are fine without confirmation, but when in doubt, ask.
- Do not accept "yes", "go ahead", or a thumbs-up as confirmation for a destructive DB action — require the literal token **`CONFIRM`**.
- If a task seems to need a destructive DB action, explain what will be affected and wait for `CONFIRM`.

## Project overview

Krakenote is an AI-first study app — **iOS (SwiftUI)** + **companion web app**. Snap notes/PDFs → AI flashcards, quizzes, and a tutor; spaced-repetition review; synced across iOS and web. Full product spec: [`docs/PRD.md`](docs/PRD.md) (source of truth).

## Repo layout

| Path | What |
|------|------|
| `site/` | Marketing landing page + legal/support pages (static HTML) |
| `server/` | Express server: serves `site/` + `POST /api/waitlist` → Supabase |
| `supabase/migrations/` | Postgres schema as versioned migrations — apply with `supabase db push` (never paste SQL by hand) |
| `docs/PRD.md` | Product requirements (source of truth) |

## Infrastructure

- **Hosting:** Railway, project `krakenote` (workspace: *anthony-banks's Projects*). Auto-deploys from GitHub.
  - **production** env ← `main` branch → `krakenote-production.up.railway.app` + `www.krakenote.com`
  - **staging** env → `krakenote-staging.up.railway.app`
- **Database:** Supabase — **separate projects** for prod and staging (test data never touches prod). Schema lives in `supabase/migrations/` (Supabase CLI). Change flow: add a migration with `supabase migration new <name>`, then `supabase db push` (after a one-time `supabase login` + `supabase link --project-ref <ref>`). Never hand-paste SQL in the dashboard.
- **Secrets:** `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` live only as Railway env vars, never committed. The service/secret key bypasses RLS and must never reach the browser.
- **Domain:** `krakenote.com` at GoDaddy → CNAME `www` → Railway; apex 301-forwards to `www`.

## Dev commands

```bash
npm install        # install server deps
npm start          # run server locally (serves site/ + /api/waitlist)
```

Local dev needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in a `.env` (see `.env.example`); without them the site serves but the waitlist returns 503.

## Workflow

- Keep `docs/PRD.md` as the living product record — capture shaping ideas there.

## Deploying — the only supported way

Both environments deploy from a branch. **This is the whole procedure — do not use
`railway up`, `railway redeploy`, or one-off uploads. They create detached builds
that the next branch push or variable change silently wipes.**

| To deploy… | Do this |
|---|---|
| **staging** | `git push origin staging` (merge your branch into `staging` first) |
| **production** | merge to `main` (PR); the push to `main` deploys prod |

That's it — deploying is a git push, nothing more. To preview a feature branch on
staging: `git switch staging && git merge <branch> && git push origin staging`.

**One-time setup this depends on:** the Railway *staging* service must have its
deploy source set to the **`staging` branch** (Railway → krakenote → staging env →
service → Settings → Source). If staging suddenly serves `main`'s code, that setting
was reset — fix it there, don't reach for `railway up`.

Setting a Railway env var triggers a redeploy **of the connected branch** — so set
vars first, then push, and the var is present for the build. Env vars are never in
git; they live only as Railway service variables per environment (prod and staging
have separate Supabase projects, so use each one's own keys).
