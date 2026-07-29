# Krakenote API contract

The backend both the web app and the iOS companion talk to. One Supabase project
per environment; one Express server (Railway) in front for AI + server-gated work.

- **Staging:** `https://krakenote-staging.up.railway.app`
- **Production:** `https://www.krakenote.com`

All JSON. All app-data endpoints return `{ ok: true, ... }` on success or
`{ ok: false, error: "..." }` with a 4xx/5xx status on failure.

---

## Auth model

Auth is **Supabase Auth**. Clients authenticate directly against Supabase with the
**anon key**, obtain a JWT, and send it to the Express API as a bearer token.
Row-Level Security (`user_id = auth.uid()`) is the security boundary — the anon key
is safe to embed in a client.

1. `GET /api/config` → `{ supabaseUrl, supabaseAnonKey }` (public runtime config).
2. Build a Supabase client with those, then:
   - **Web:** `supabase.auth.signInWithPassword({ email, password })`
   - **iOS:** `supabase-swift` sign-in, or Sign in with Apple via Supabase's Apple provider (needs configuring in the Supabase dashboard).
3. Send the session access token on every app-data request:
   `Authorization: Bearer <access_token>`

**Signup is server-side and waitlist-gated** (the anon key could call `signUp`
directly, so the gate lives where the client can't skip it):
`POST /api/auth/signup { email, password }` → creates the user only if `email` is
already in the `waitlist` table. `403 { error: "not_on_waitlist" }` otherwise.

> **iOS integration note.** Two valid paths, and you can mix them:
> - **Direct Supabase** (`supabase-swift`) for CRUD on `decks`/`cards`/`sources`/`profiles` — RLS protects it, no server round-trip. Good for offline-first sync (SwiftData cache ↔ Supabase).
> - **The Express API below** for anything needing a server-side secret or logic: AI generation, fact-check, and (currently) FSRS review scheduling. These can't run client-side because the Anthropic key is server-only.
> Decide per feature. Simplest start: use the Express API for everything (it's just HTTPS + the bearer token); move hot read paths to direct Supabase later if you want offline.

---

## App-data endpoints (require `Authorization: Bearer <jwt>`)

### Decks
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/decks` | — | `{ decks: [{ id, title, subject, created_at, cardCount }] }` |
| POST | `/api/decks` | `{ title, subject? }` | `{ deck: { id, title, subject, created_at, cardCount } }` |
| DELETE | `/api/decks/:id` | — | `{ ok }` (cards cascade) |
| GET | `/api/decks/:id/sources` | — | `{ sources: [{ id, kind, filename, summary, created_at }] }` |

`kind` ∈ `text | pdf | image | url | docx | pptx | file`.

### Cards
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/decks/:id/cards` | — | `{ cards: [Card] }` |
| POST | `/api/decks/:id/cards` | `{ cards: [{ type, front, back, hint? }], source?: { kind, filename?, charCount?, summary? } }` | `{ added }` — bulk create (manual add, CSV import, approved AI cards) |
| POST | `/api/decks/:id/cards/reorder` | `{ orderedIds: [id, ...] }` | `{ ok }` — sets `sort_order` = position |
| PATCH | `/api/cards/:id` | `{ front?, back?, hint?, type? }` | `{ ok }` |
| DELETE | `/api/cards/:id` | — | `{ ok }` |

**Card** = `{ id, card_type, front, back, hint, ease, interval_days, repetitions, due_at, sort_order }`.
`card_type` ∈ `basic | cloze` (cloze `front` contains `____`).

### AI generation (Anthropic — server-side key)
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/decks/:id/generate` | one of `{ text }`, `{ url }`, `{ file: { name, mediaType, dataBase64 } }`, plus `cardType?: "mix"\|"basic"\|"cloze"` | `{ summary, cards: [{ type, front, back, hint }], source: { kind, filename, charCount } }` |
| POST | `/api/cards/:id/factcheck` | `{}` | `{ accurate, context, hasSuggestion, suggestedFront, suggestedBack }` |

`generate` is **side-effect-free** — it returns *proposed* cards; nothing is saved
until you `POST /api/decks/:id/cards`. `mediaType`: `application/pdf`, `image/*`,
the docx/pptx OpenXML types, or omit for text. Strict-from-source: cards use only
facts in the material. `factcheck` is the opposite — verifies against general
knowledge and may suggest a correction.

### Review (FSRS)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/review/due` (optional `?deckId=`) | — | `{ cards: [{ id, card_type, front, back, hint, deckTitle }] }` |
| POST | `/api/cards/:id/review` | `{ grade: 0\|3\|4\|5 }` | `{ interval_days, due_at }` |

Grades: `0` Again · `3` Hard · `4` Good · `5` Easy (mapped to FSRS ratings
server-side). Each review is logged to the `reviews` table (streaks/analytics).
FSRS state lives on the card (`stability`, `difficulty`, `fsrs_state`, `lapses`,
`learning_steps`, `last_review`).

### Progress & profile
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/stats` | — | `{ decks, cards, due, streak, reviewedToday, reviewed7d, totalReviews, retentionPct }` |
| GET | `/api/profile` | — | `{ email, firstName, lastName }` |
| PATCH | `/api/profile` | `{ firstName, lastName }` | `{ ok }` |

---

## Other endpoints
| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | `{ ok, supabase }` |
| GET | `/api/config` | public runtime config (URL + anon key) |
| POST | `/api/waitlist` | `{ email, hp, source }` — public waitlist capture (honeypot `hp`) |
| POST | `/api/auth/signup` | `{ email, password }` — waitlist-gated user creation |
| GET | `/app` | serves the web app shell |
| POST | `/api/admin/login`, GET `/api/admin/waitlist[.csv]` | superuser-gated waitlist admin |

---

## Data model (Postgres / Supabase, all RLS-scoped to the owner)

- **profiles** — `id (=auth.uid)`, `first_name`, `last_name`
- **decks** — `id`, `user_id`, `title`, `subject`, timestamps
- **cards** — `id`, `deck_id`, `card_type`, `front`, `back`, `hint`, SM-2 cols (`ease`, `interval_days`, `repetitions`) kept for rollback, FSRS cols (`stability`, `difficulty`, `fsrs_state`, `lapses`, `learning_steps`, `last_review`), `due_at`, `sort_order`, `created_at`
- **sources** — `id`, `user_id`, `deck_id`, `kind`, `filename`, `char_count`, `summary`, `extracted_text`, `created_at`
- **reviews** — `id`, `user_id`, `card_id`, `deck_id`, `grade`, `reviewed_at`
- **waitlist** — `id`, `email`, `source`, `created_at`

Schema is defined as Supabase CLI migrations in `supabase/migrations/`; apply with
`supabase db push`. RLS policies scope every table to `auth.uid()`; `cards` inherit
ownership through their deck.
