# Krakenote — Product Requirements Document

**Name:** *Krakenote* (locked) — Kraken mascot + "note"; "crack the exam"
**Platforms:** iOS 17+ (native SwiftUI) and a companion web app
**Status:** Apple TV concept shelved; all focus on this product
**Author:** Anthony
**Last updated:** July 2026

---

## 1. Vision & positioning

**Pitch:** Point your phone at any notes, textbook page, slide, or PDF — or upload a document on the web — and in seconds get smart flashcards, quizzes, and an AI tutor that shows its work, generates fresh practice, and critiques yours. Then a memory-science review loop drills you on exactly what you're about to forget, across your phone and the web.

**What makes it top-tier (the wedge):** competitors do one of these; we do the whole spine.

> **Capture** (camera / PDF / doc / audio) → **Understand** (cards + Tutor: show-work, examples, critique) → **Retain** (spaced repetition, streaks) → **Prove** (quizzes, exam mode, readiness score) — synced between **iOS and web**.

The retention moat is the spaced-repetition loop; the acquisition hook is instant capture; the premium differentiator is Tutor mode.

## 2. Brand & identity

**Name:** **Krakenote** — the Kraken (a bold, mascot-ready sea monster; "crack the exam") fused with "note." Instantly legible as a study app, with a lovable character to anchor the visual identity and ad creative. App Store subtitle: "AI Flashcards, Quizzes & Tutor."

**Trademark & logo (practical read, not legal advice).** No existing app or company named "Krakenote" surfaced in search. "Kraken" is public-domain folklore and can't be monopolized; the major Kraken marks (crypto exchange, Seattle Kraken/NHL, Kraken rum) live in unrelated classes, and "Krakenote" is a distinctive coined compound in the software/education class — low conflict risk. Use an **original** kraken mascot (don't copy the Seattle Kraken tentacle-"S" mark or Kraken rum's engraving), and lean into study cues so it reads friendly-scholarly rather than nautical/sports/spirits. To-do: USPTO clearance search (classes 9 software / 41 education / 42 SaaS), register the wordmark + logo at launch, and a short attorney opinion before ad spend.

**Mascot direction:** a friendly cartoon kraken — round-eyed and approachable, a tentacle holding a quill or pencil, maybe reading glasses. Works as an app icon (kraken silhouette in a rounded squircle), an empty-state/loading character, and ad talent. All-ages, not scary.

**Color palette — "Deep Sea Scholar":**

| Role | Name | Hex |
|---|---|---|
| Primary dark / brand base | Abyss | `#0A1A2F` |
| Secondary dark / surfaces | Deep Sea | `#12314F` |
| Primary accent (brand / links) | Kraken Teal | `#22C3B6` |
| Secondary accent / gradient | Tentacle Violet | `#7B61FF` |
| CTA / warm pop | Coral | `#FF6B5C` |
| Light surface (the "note") | Parchment | `#F7F4ED` |
| Neutral light background | Mist | `#EEF3F6` |
| Text on light | Ink | `#0B1220` |
| Muted text | Slate | `#5A6B7B` |
| Borders / dividers | Fog | `#D9E1E8` |

The signature look: deep-ocean navy backgrounds with a bioluminescent **teal→violet** glow (the kraken's light), a warm **coral** for calls-to-action, and **parchment** for study warmth on light surfaces. Teal-on-Abyss and Coral CTAs are high-contrast and accessible (use Ink text on Coral for small type). Type: a friendly geometric sans for headings/UI (Poppins or Satoshi) + a clean readable sans for body (Inter).

## 3. Target market & positioning

Build for all ages; **market to college students and adult exam/cert learners (18+) first.** They have their own payment methods, acute deadline-driven pain, and convert on paid social. Marketing to under-13s triggers **COPPA** (verifiable parental consent, no behavioral ad targeting) and Apple's Kids-Category restrictions that would block the analytics/ad SDKs our growth depends on — so we rate the app 4+, serve everyone, but point launch ads at college + certification learners (nursing/NCLEX, real estate, AWS/PMP, bar, languages), then widen down-market later. Breadth becomes a *creative* strategy (different faces/subjects per ad), not a positioning statement.

## 4. Scope — v0 / v1 / v1.1 / v2

**v0 — Brand & web foundation (do this FIRST):**
- **Secure assets:** `krakenote.com` (+ `.app`/`.ai` defensively), @krakenote on TikTok/Instagram/X, Apple Developer enrollment, a Supabase project, a GitHub repo, and an analytics account.
- **Brand basics:** finalize the palette (§2), commission or generate the kraken mascot/logo, set typography, and define the app-icon direction.
- **Landing page (marketing site):** hero with the pitch + mascot, feature highlights, **email waitlist capture** (start building a launch audience now), and the App-Store-required **privacy policy + support/terms** pages.
- **Initial web UI / design system:** turn the palette into reusable components (buttons, cards, nav, type scale) that both the landing page and the v1 web companion inherit — so every later screen is already on-brand.

*Why first:* the landing page is required regardless (privacy/support URLs for App Store review, plus a destination for ads), and a waitlist started today compounds into launch-day momentum. Locking brand + design system now means no rework later.

**v1 (ship first):**
- iOS capture: document-scanner camera + photo library.
- **Document upload in v1:** PDF import on iOS via the system file importer (Files app also surfaces iCloud Drive, Dropbox, and Google Drive as providers — so basic "cloud" import comes free without native APIs). PDF text extracted on-device; scanned PDFs OCR'd.
- On-device OCR → AI generation of flashcards + multiple-choice quiz (strict JSON).
- Decks, spaced-repetition review (SM-2), quiz with scoring.
- **Companion web (v1, lightweight):** account/auth, subscription management, and **read-only review of everything** — all decks, cards, quiz history, and progress. Plus drag-and-drop document upload on web (the easy surface for `.docx` and large PDFs).
- Cross-device sync (same account on iOS + web).
- Freemium paywall (subscription).

**v1.1 (first big update, a second marketing moment):**
- **Tutor mode** (the marquee feature): show step-by-step work, "give me N more practice problems like this," adjustable explanation depth, and **critique my work** (submit a solution/essay → structured feedback). Math rendered with KaTeX; math answers verified through a symbolic engine where possible.
- Streaks, reminders, Home/Lock-Screen widgets.
- Audio lecture capture → notes → cards.

**v2 (later):**
- Native Dropbox + Google Drive integrations (OAuth) beyond the Files-provider path.
- `.docx`/PPTX parsing at scale (server-side), exam/mock-test mode with readiness scoring, shared/community decks, web subscription checkout (web-to-app funnel), Android.

## 5. Feature specifications

**5.1 Capture & ingestion.** Sources: camera (VisionKit document scanner), photo library, PDF/file import (iOS file importer; web drag-drop). Pipeline: images → Vision OCR on-device; text PDFs → PDFKit text extraction; scanned PDFs → render pages → Vision OCR; `.docx` → parsed server-side (web-first). Extracted text (never raw images) is sent to the generation service to keep cost and latency low and privacy high.

**5.2 Generation.** Backend service returns strict JSON: an array of cards `{front, back, hint?}` and quiz items `{question, choices[4], answerIndex, explanation}`. Validate; retry once on malformed JSON.

**5.3 Review (retention core).** SM-2 scheduler per card (ease, interval, due date). "Review today" queue surfaces due cards; grading (Again/Hard/Good/Easy) updates the schedule. Runs fully offline.

**5.4 Quiz & (v2) exam mode.** Auto-generated quiz from a deck; score + "review these" list. Exam mode: timed mock test + a "you're 78% ready" readiness estimate.

**5.5 Tutor mode (v1.1).** One surface, three actions: **Show the work** (step-by-step solution, KaTeX math), **More like this** (generate fresh practice at a chosen difficulty), **Critique my work** (user submits a solution/essay → rubric-style feedback with specific fixes). Guardrail: label AI math as a study aid, let users flag a bad step, and verify final numeric/algebraic answers with a symbolic engine (e.g., a SymPy service) before presenting them as correct.

**5.6 Companion web.** v1: auth (Sign in with Apple + email), billing, and full **read** access to decks/cards/quiz history/progress dashboards, plus document upload. It reads the same backend as iOS. v2: full study parity + web checkout.

**5.7 Audio Study Mode (SHAPING — idea captured, not yet scoped to a version).** The passive, hands-free counterpart to flashcards: "walk with your notes." Where cards are active recall (lean-in, screen-on), this is ambient review (lean-back, screen-off) — it turns commuting, walking, and the gym into study time. Available on both **web and mobile**.

- **Sources are not siloed.** Lectures, typed notes, scanned notes, and PDFs are all just *inputs*. The user chooses which ones to **consolidate** into a single study set, and can **summarize across the combined set** — e.g., merge a recorded lecture with the day's typed notes into one summary. It's the user's call to combine, never forced this-or-that.
- **Two directions, both user-selectable (not either/or):**
  - **Capture (audio → text):** record a lecture or voice memo → transcribe → summarize → optionally auto-generate cards.
  - **Playback (text → audio):** take any notes/summary → generate a spoken **narration** the user listens to on the go.
- **Voice / TTS:** prefer **ElevenLabs** for quality if the cost works; fall back to a cheaper neural TTS (e.g., OpenAI TTS) or Apple's on-device voice if not. Keep the provider swappable.
- **Persistence — "indefinitely" means *access*, not *unlimited generation*.** Generation stays metered/Pro-gated, but **once a transcript or audio artifact is created, it lives on the user's account and stays accessible forever.** Transcripts (text) are cheap to keep for everyone; raw/large audio is the cost tail → compress (Opus), keep originals for Pro, and/or regenerate TTS on demand rather than storing.
- **Opt-in sharing (future/community seed):** a user may *optionally* make one of their transcriptions/audio reviewable and accessible to **other users** — only ever with the original owner's explicit permission. This is the seed of the shared/community layer (see §4 v2 "shared/community decks"). Default is strictly private per-user.
- **Playback surfaces:** iOS background audio + lock-screen + **CarPlay** controls; standard audio player on web. This is what makes true screen-off, walking-around review work.
- **Monetization fit:** clean Pro feature — free tier gets a monthly minute cap on generation; **Pro = unlimited audio generation + indefinite storage.**
- **Open questions to resolve when scoping:** ElevenLabs cost per active user at expected volume; storage policy for raw audio (keep vs. regenerate); on-device vs. server transcription for long lectures; sharing model + moderation before any community exposure.

## 6. System architecture

The web companion needs to read the *same* user data as the app, so we do **not** use CloudKit (Apple-only). We use a cross-platform backend both clients share.

```
┌─────────────┐        ┌──────────────────────┐        ┌─────────────┐
│  iOS app    │        │   Backend (Supabase) │        │  Web app    │
│  SwiftUI    │◀──────▶│  Postgres + Auth     │◀──────▶│  Next.js    │
│  Vision OCR │        │  Storage + Edge Fns  │        │  React      │
│  PDFKit     │        └──────────┬───────────┘        └─────────────┘
│  SwiftData  │                   │  (key-holding proxy)
│  (cache)    │                   ▼
└─────────────┘        ┌──────────────────────┐
                       │  AI generation API   │
                       │  (LLM, swappable)    │
                       └──────────────────────┘
```

- **Backend:** Supabase (managed Postgres, Auth, Storage, Edge Functions). One database, both clients. (Firebase is a fine alternative; Postgres/SQL is the reason I lean Supabase.)
- **AI key never ships in the app.** A Supabase Edge Function (or Cloudflare Worker) holds the key, calls the LLM, enforces per-user rate limits, returns validated JSON.
- **iOS local cache:** SwiftData mirrors the user's decks for offline review; syncs to Supabase when online.
- **Payments:** iOS = StoreKit 2 via RevenueCat; Web (v2) = Stripe. RevenueCat consolidates entitlement state.
- **Storage:** uploaded PDFs/docs in Supabase Storage; text extraction result cached so we don't re-OCR.

## 7. Data model (Postgres)

```sql
-- Users are managed by Supabase Auth (auth.users). App tables reference auth.uid().

create table decks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  title        text not null,
  subject      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table cards (
  id           uuid primary key default gen_random_uuid(),
  deck_id      uuid not null references decks(id) on delete cascade,
  front        text not null,
  back         text not null,
  hint         text,
  -- SM-2 scheduling state
  ease         real not null default 2.5,
  interval_days integer not null default 0,
  repetitions  integer not null default 0,
  due_at       timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create table quiz_attempts (
  id           uuid primary key default gen_random_uuid(),
  deck_id      uuid not null references decks(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  score        real not null,
  total        integer not null,
  taken_at     timestamptz not null default now()
);

create table sources (            -- uploaded/captured originals
  id           uuid primary key default gen_random_uuid(),
  deck_id      uuid references decks(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null,     -- 'image' | 'pdf' | 'docx' | 'audio'
  storage_path text,              -- Supabase Storage key
  extracted_text text,
  created_at   timestamptz not null default now()
);

-- Row-Level Security: every table filters on user_id = auth.uid()
alter table decks enable row level security;
create policy "own decks" on decks for all using (user_id = auth.uid());
-- (repeat equivalent policies for cards via deck ownership, quiz_attempts, sources)
```

## 8. Generation API contract

`POST /functions/v1/generate` (Supabase Edge Function). Body: `{ text, mode: "cards" | "quiz" | "both", count }`. Response:

```json
{
  "cards": [
    { "front": "What is the powerhouse of the cell?", "back": "The mitochondrion", "hint": "Makes ATP" }
  ],
  "quiz": [
    {
      "question": "Which organelle produces most of the cell's ATP?",
      "choices": ["Nucleus", "Mitochondrion", "Ribosome", "Golgi apparatus"],
      "answerIndex": 1,
      "explanation": "Mitochondria carry out oxidative phosphorylation, producing ATP."
    }
  ]
}
```

The Edge Function prompts the LLM for exactly this schema, validates it, and retries once on invalid JSON before returning an error the app can show gracefully.

## 9. Key code snippets (Swift / SwiftUI)

**9.1 Document scanner (VisionKit).**

```swift
import VisionKit
import SwiftUI

struct ScannerView: UIViewControllerRepresentable {
    var onScan: ([UIImage]) -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController()
        vc.delegate = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: VNDocumentCameraViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onScan: ([UIImage]) -> Void
        init(onScan: @escaping ([UIImage]) -> Void) { self.onScan = onScan }

        func documentCameraViewController(_ c: VNDocumentCameraViewController,
                                          didFinishWith scan: VNDocumentCameraScan) {
            var pages: [UIImage] = []
            for i in 0..<scan.pageCount { pages.append(scan.imageOfPage(at: i)) }
            c.dismiss(animated: true) { self.onScan(pages) }
        }
    }
}
```

**9.2 On-device OCR (Vision).**

```swift
import Vision
import UIKit

func extractText(from image: UIImage) async throws -> String {
    guard let cg = image.cgImage else { return "" }
    return try await withCheckedThrowingContinuation { cont in
        let request = VNRecognizeTextRequest { req, err in
            if let err { cont.resume(throwing: err); return }
            let text = (req.results as? [VNRecognizedTextObservation] ?? [])
                .compactMap { $0.topCandidates(1).first?.string }
                .joined(separator: "\n")
            cont.resume(returning: text)
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        do { try VNImageRequestHandler(cgImage: cg).perform([request]) }
        catch { cont.resume(throwing: error) }
    }
}
```

**9.3 PDF text extraction + file import.**

```swift
import PDFKit
import SwiftUI

func extractText(fromPDF url: URL) -> String {
    guard let doc = PDFDocument(url: url) else { return "" }
    return (0..<doc.pageCount)
        .compactMap { doc.page(at: $0)?.string }
        .joined(separator: "\n")
    // If pageCount text is empty, the PDF is scanned → render pages to images and run extractText(from:).
}

struct ImportButton: View {
    @State private var showImporter = false
    var onPicked: (URL) -> Void
    var body: some View {
        Button("Import document") { showImporter = true }
        .fileImporter(isPresented: $showImporter,
                      allowedContentTypes: [.pdf, .plainText],  // Files app exposes Dropbox/Drive too
                      allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first { onPicked(url) }
        }
    }
}
```

**9.4 SM-2 spaced-repetition scheduler.**

```swift
enum Grade: Int { case again = 0, hard = 3, good = 4, easy = 5 }

struct SM2State { var ease = 2.5; var interval = 0; var reps = 0 }

func schedule(_ s: SM2State, grade: Grade) -> SM2State {
    var n = s
    let q = Double(grade.rawValue)
    if grade == .again {                     // failed → reset interval, keep learning
        n.reps = 0; n.interval = 1
    } else {
        n.reps += 1
        n.interval = n.reps == 1 ? 1 : n.reps == 2 ? 6 : Int((Double(s.interval) * s.ease).rounded())
    }
    n.ease = max(1.3, s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
    return n  // next due = now + n.interval days
}
```

**9.5 Calling the generation service.**

```swift
struct Card: Codable, Identifiable { let id = UUID(); let front: String; let back: String; let hint: String? }
struct QuizItem: Codable { let question: String; let choices: [String]; let answerIndex: Int; let explanation: String }
struct GenerationResult: Codable { let cards: [Card]; let quiz: [QuizItem] }

func generate(text: String, mode: String = "both", count: Int = 15) async throws -> GenerationResult {
    var req = URLRequest(url: URL(string: "\(Config.supabaseURL)/functions/v1/generate")!)
    req.httpMethod = "POST"
    req.setValue("Bearer \(await Session.accessToken())", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONEncoder().encode(["text": text, "mode": mode, "count": "\(count)"])
    let (data, _) = try await URLSession.shared.data(for: req)
    return try JSONDecoder().decode(GenerationResult.self, from: data)
}
```

## 10. Companion web snippet (Next.js + Supabase)

```tsx
// app/decks/page.tsx — read-only review of everything the user has studied
import { createServerComponentClient } from '@supabase/auth-helpers-nextjs'
import { cookies } from 'next/headers'

export default async function DecksPage() {
  const supabase = createServerComponentClient({ cookies })
  const { data: decks } = await supabase
    .from('decks')
    .select('id, title, subject, cards(count), quiz_attempts(score, total, taken_at)')
    .order('updated_at', { ascending: false })

  return (
    <main>
      <h1>Your study library</h1>
      {decks?.map(d => (
        <a key={d.id} href={`/decks/${d.id}`} className="deck-card">
          <h2>{d.title}</h2>
          <p>{d.subject} · {d.cards?.[0]?.count ?? 0} cards</p>
        </a>
      ))}
    </main>
  )
}
```

Row-Level Security means the user only ever sees their own rows — no per-query ownership checks needed in app code.

## 11. Monetization

Freemium subscription. Free: limited AI scans/day + full review of existing cards. **Pro (~$4.99/mo or $29.99/yr, 7-day trial):** unlimited scans, Tutor mode, exam mode, cloud upload, priority generation. No ads (they cheapen a paid utility and hurt conversion). Annual + trial is what makes paid acquisition math work. Unit economics: a Pro user pays ~$30/yr against at-most a few dollars of AI cost → healthy margin that lets ad spend pay for itself once conversion is known. Web checkout (v2, Stripe) avoids Apple's cut for web-acquired users.

## 12. Cloud-storage integrations (roadmap)

v1: free "cloud import" via the iOS Files provider system (Dropbox/Drive/iCloud already appear in the file importer). v2: native **Dropbox** and **Google Drive** OAuth integrations for browsing/auto-import, plus web-side connectors. This ordering gets you cloud import at launch with near-zero engineering, then deepens it only if usage justifies the OAuth work.

## 13. Marketing plan (Google + social, paid)

The value is visual and instant, which is ideal for paid social. Hero creative: a 6–15s vertical video — point phone at messy notes → cards fan out → quiz pops → "got it." Make 5–8 variants across subjects/ages to reach the breadth. Channels: **TikTok + Instagram Reels** (cheapest attention; time spend to back-to-school Aug–Sep and finals Nov–Dec/Apr–May), **Google App campaigns / YouTube Shorts** (auto-optimizes for installs + subscribers), and a small always-on **Apple Search Ads** campaign in parallel (usually the cheapest subscriber, catches people searching "flashcards/study app"). Discipline: instrument the funnel (install → first scan → first review → trial → paid) before scaling; kill losing creatives fast; feed budget to the winner. Underneath, do sharp ASO, a few organic TikToks, and a Product Hunt launch.

## 14. Costs

Apple Developer Program $99/yr; AI API pennies per generation (funded by subscriptions); Supabase free tier at launch → ~$25/mo as you grow; RevenueCat free until ~$2.5k/mo revenue; analytics free tier; optional icon designer a few hundred dollars (worth it). Reaching the App Store costs roughly the $99 fee plus optional design; the real spend is the ad budget, on your terms.

## 15. Milestones (sequenced)

0. **v0 — Foundation ← START HERE:** secure domain/socials/accounts, finalize palette + mascot/logo, ship the landing page with waitlist + legal pages, and stand up the web design system.
1. App foundations: Xcode project, Supabase project, auth, data model, navigation shell.
2. Capture + ingestion: scanner, photo import, PDF import, on-device OCR/extraction.
3. Generation: Edge Function + JSON contract + card/quiz creation flow.
4. Review + quiz: SM-2 scheduler, review UI, quiz + scoring.
5. Web companion (v1): auth, billing, read-only review dashboards, web upload.
6. Monetization + polish: RevenueCat paywall, onboarding, icon, empty states.
7. TestFlight beta → fix → submit.
8. v1.1: Tutor mode, streaks/widgets, audio capture.

## 16. Open questions / context I need from you

1. **AI provider:** any preference or existing account, or keep it swappable and pick on cost/JSON reliability?
2. **Web hosting:** Vercel (Next.js) + Supabase OK, or do you have a stack preference?
3. **Logo:** commission a designer for the kraken mascot, or want me to generate initial concepts to get moving?
4. **Bundle ID / team:** Apple Developer account handy, or set that up when we reach submission?
5. **Waitlist email:** which provider for capture (e.g., a simple form → Supabase table, or a tool like ConvertKit/Mailchimp)?
