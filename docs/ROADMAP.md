# Krakenote build roadmap

Confirmed backlog from the 2026-07-25 review session. Ordered into batches.
Status: ⬜ todo · �build in progress · ✅ done

## Decisions locked
- **FSRS** replaces SM-2 (ts-fsrs). ~20–30% fewer reviews; self-tuning.
- **Card types**: user picks Basic / Cloze / Mix before generating.
- **Upload nav**: removed (Decks + in-deck capture cover it).
- **Re-add Easy**: "Study again this session" button in review (no schedule change).
- **Names**: stored in a `profiles` table, editable in Account.
- **Input persistence**: keep input through preview; clear on Add-to-deck / Discard; add explicit Clear.

## Batch 1 — Visual / nav / layout polish
- ⬜ Loading animation during generation (spinner, not just a disabled button)
- ⬜ Bigger nav icons
- ⬜ Krakenote logo +40% in header
- ⬜ Lighter-blue main background (distinguish content from nav/header)
- ⬜ Sticky sidebar (pinned on scroll to bottom)
- ⬜ Collapsible sidebar (‹/› toggle; collapsed = icons only)
- ⬜ Remove top-right sign-out (keep nav + Account = 2 entry points)
- ⬜ Remove Upload nav panel
- ⬜ Custom delete modal (replace browser confirm())

## Batch 2 — Card management + review + card types
- ⬜ Manual card creation (no AI)
- ⬜ Delete individual cards (DELETE /api/cards/:id)
- ⬜ Edit individual cards (PATCH /api/cards/:id)
- ⬜ Card-type control in capture form (Basic/Cloze/Mix → prompt)
- ⬜ Filter review by deck (Review nav)
- ⬜ "Study again this session" in review

## Batch 3 — FSRS migration
- ⬜ Add FSRS card-state columns (difficulty, stability, state, last_review) via migration
- ⬜ Replace SM-2 scheduler with ts-fsrs in the review endpoint
- ⬜ Keep the reviews log feeding it

## Batch 4 — Account expansion
- ⬜ `profiles` table (first_name, last_name) + migration
- ⬜ Edit first/last name in Account
- ⬜ Billing — WIP placeholder section

## Batch 5 — Bulk upload + queue
- ⬜ Multi-file / queued generation with a visible pending-queue UI

## Research shortlist (from web search 2026-07-25)
- **ts-fsrs** — modern spaced repetition (adopting, Batch 3).
- **KaTeX** — LaTeX math rendering for STEM/chemistry/coding cards.
- **@extractus/article-extractor** (or Mozilla Readability) — better URL extraction than the current tag-stripper.
- **youtube-transcript** — "paste a YouTube link" ingestion source.
- **OCR** — not needed separately; Claude vision handles images.
- **Later:** ElevenLabs / OpenAI TTS (audio study mode); Stripe / RevenueCat (billing).
