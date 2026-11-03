# Work split: two parallel tracks

_Written 2026-11-03, after Phase 0 (`5449d16`). Read with [ROADMAP.md](ROADMAP.md)._

Phases 1–4 are split into two tracks by **file ownership**, so two agents can work at the same time without editing the same files.

| | Track A — Live audio & overlay | Track B — Knowledge & personalization |
|---|---|---|
| Agent | Claude Code | Codex |
| Branch | `claude/live-audio` | `codex/knowledge` |
| Worktree | `PluelyComp/` (this folder) | `../PluelyComp-codex` |
| Roadmap scope | Phase 1 (all); Phase 4 items 3 and 5 (question-type routing, overlay UX) | Phase 2 (all); Phase 3 (all); Phase 4 items 1, 2, 4, 6 (sessions, prep pack, debrief, onboarding) |

---

## 1. File ownership

Only the owner edits these paths. Anything else needs the shared-file rules in section 2.

**Track A (Claude) owns**
- `src-tauri/src/speaker/**`
- new `src-tauri/src/stt_stream/**`, `src-tauri/src/vad/**`
- `src-tauri/src/transcription.rs`, `transcription_service/**`
- `src/hooks/useSystemAudio.ts`, `src/hooks/useCompletion.ts`, `src/hooks/useChatCompletion.ts`
- `src/pages/app/**` (the overlay window)
- `src/lib/functions/stt.function.ts`, `src/lib/functions/ai-response.function.ts`
- `src/config/stt.constants.ts`, `src/pages/audio/**`, `src/pages/dev/components/stt-configs/**`
- new `src/lib/interview/**` (question detection and classification)

**Track B (Codex) owns**
- new `src-tauri/src/kb/**` (embeddings, chunking, search)
- `src-tauri/src/db/**`: **all** new migrations (knowledge, stories, sessions, `conversations.session_id`)
- new `src-tauri/resources/models/**` (bundled embedding model)
- new `src/lib/context/**` (context builder; see section 3)
- `src/lib/database/**`
- new `src/contexts/profile.context.tsx` (profile and active-session state)
- new pages `src/pages/profile/**`, `src/pages/stories/**`, `src/pages/sessions/**`
- `src/pages/dashboard/**`, `src/pages/system-prompts/**`, `src/pages/chats/**`
- `src/lib/platform-instructions.ts`

---

## 2. Shared files

Each change to a shared file must be small and append-only, with a marked block per track. Rebase onto `main` before every merge.

| File | Rule |
|---|---|
| `src-tauri/src/lib.rs` | Each track adds its `mod` lines and `generate_handler!` entries inside its own block: `// --- track A: live audio ---` / `// --- track B: knowledge ---`. Don't reorder or reformat other lines. |
| `src-tauri/Cargo.toml` | Add dependencies under a `# track A` / `# track B` comment. On a `Cargo.lock` conflict, take `main`'s version and rebuild. |
| `package.json` | Same rule as `Cargo.toml`; regenerate `package-lock.json` with `npm install` after rebasing. |
| `src-tauri/tauri.conf.json` | Track B adds the model to `bundle.resources` (a map). Track A doesn't touch `bundle`. |
| `src/routes/index.tsx`, `src/pages/index.ts`, `src/hooks/useMenuItems.tsx` | **Track B only** (new pages and sidebar items). Track A adds no routes. |
| `src/main.tsx` | **Track B only**: wraps the tree in `ProfileProvider`. |
| `src/contexts/app.context.tsx`, `src/types/context.type.ts` | **Frozen for both tracks.** New state goes into a new context. If a change here is unavoidable, make it its own commit and tell the user before pushing. |
| `CLAUDE.md`, `docs/ROADMAP.md` | Each track edits only the section for its own module; doc-only commits. |

---

## 3. Interfaces between the tracks

These are fixed now so neither track waits on the other.

### 3.1 Context builder (Track B implements, Track A calls)

Track B commits `src/lib/context/index.ts` **first**, as a working stub that returns empty results, so Track A can import it straight away.

```ts
// src/lib/context/index.ts
export type QuestionType =
  | "behavioral" | "technical" | "coding" | "system_design"
  | "situational" | "small_talk" | "logistics" | "other";

export interface StoryCard {
  id: string;
  title: string;
  short: string;   // ~30-second version
  long?: string;   // full STAR version
  verified: boolean; // only verified stories are returned live
}

export interface ContextRequest {
  question: string;
  questionType?: QuestionType;
  history?: { role: "user" | "assistant"; content: string }[];
}

export interface ContextResult {
  // Appended after the user's system prompt; stable parts first for prefix caching.
  systemPromptAddendum: string;
  stories: StoryCard[];   // max 2, verified only
  keyterms: string[];     // names, company, tech stack, for STT boosting
}

export async function buildInterviewContext(req: ContextRequest): Promise<ContextResult>;
```

- Must return within ~50 ms after warm-up and never throw: on any error, return empty results.
- Reads the active session itself (section 3.2); Track A doesn't pass a session id.

### 3.2 Active session across windows (Track B)

The overlay (`main` window) and the dashboard are separate webviews. Track B persists the active session id in `localStorage` key `active_interview_session_id` and emits the Tauri event `active-session-changed` (payload: id or `null`). Track A only *reads* through `buildInterviewContext`.

### 3.3 Question classification (Track A)

Track A owns `src/lib/interview/classify.ts`, exporting `classifyQuestion(text): QuestionType` (the type is imported from `src/lib/context`). Track B may import it, for example for prep-pack generation, but doesn't edit it.

### 3.4 Transcripts (no new interface)

Track A keeps saving system-audio conversations through the existing `saveConversation` in `src/lib/database/chat-history.action.ts`. Track B owns that file and may add `session_id` to it; it must keep the existing `saveConversation(conversation)` signature working (new fields optional).

---

## 4. Order of work

1. **Track B, first commit:** the `src/lib/context/index.ts` stub (section 3.1). Merge to `main` immediately.
2. Both tracks then work in parallel. Merge small, independently working slices to `main` often (at least daily), rebasing first.
3. **Integration point:** once Track B's real `buildInterviewContext` lands, Track A wires it into `useSystemAudio.ts`: story cards in the overlay and keyterms for STT.
4. Each track ends each phase with the checks in section 5.

---

## 5. Definition of done (both tracks)

- `npm run build` passes (strict TypeScript; no unused symbols).
- `cargo check` passes in `src-tauri/` (needs a Rust toolchain: https://rustup.rs).
- `node --test tests/` passes; sidecar tests pass if `transcription_service/` changed.
- macOS, Windows and Linux all keep working: no platform-only code without `cfg` guards and a fallback.
- Privacy invariants in `CLAUDE.md` hold: user data stays on device; third-party calls go directly from the device to the provider.
- No licensed/cloud Pluely API code reintroduced.
- Commit messages carry **no AI co-author or "generated with" lines**.

---

## 6. Prompt for Codex

```text
You are working on Pluely, a Tauri 2 desktop interview/meeting assistant
(React 19 + TypeScript frontend in src/, Rust backend in src-tauri/src/,
optional Python Whisper sidecar in transcription_service/).

Another agent (Claude Code) is working on the same repo at the same time.
To avoid clashing you MUST follow docs/WORKSPLIT.md exactly. Read these
first, in this order: CLAUDE.md, docs/ROADMAP.md, docs/WORKSPLIT.md.

SETUP
- Work only in your own worktree and branch, never in the main folder:
    git worktree add ../PluelyComp-codex -b codex/knowledge main
    cd ../PluelyComp-codex
- Install deps there: npm install; Rust via rustup if `cargo` is missing.

YOUR TRACK: "Track B — Knowledge & personalization"
- ROADMAP Phase 2 (profile page, resume PDF/DOCX + portfolio/GitHub
  ingestion, SQLite knowledge store, local embeddings in Rust with the
  model BUNDLED in the installer, hybrid vector + FTS5 search, context
  builder).
- ROADMAP Phase 3 (Story Bank with STAR fields and a `verified` flag,
  AI-drafted stories that are never used live until the user approves
  them, story gap analysis, indexing past interview transcripts).
- ROADMAP Phase 4 items 1, 2, 4, 6 (interview sessions with company/role/
  JD, prep pack, post-interview debrief + thank-you email, onboarding).

HARD RULES
1. Edit only files your track owns (WORKSPLIT section 1). For shared files
   follow WORKSPLIT section 2: small, append-only, inside a
   "// --- track B: knowledge ---" block. Never edit the files Track A
   owns. src/contexts/app.context.tsx is frozen: put new state in
   src/contexts/profile.context.tsx.
2. Your FIRST commit is the working stub of src/lib/context/index.ts with
   the exact interface in WORKSPLIT section 3.1, merged to main right
   away. Do not change that interface without the user agreeing.
3. buildInterviewContext must never throw and must return only verified
   stories (max 2).
4. Privacy: everything stays on the device. Embeddings run locally. LLM
   calls go through the existing fetchAIResponse in
   src/lib/functions/ai-response.function.ts with the user's selected
   provider (import it; do not modify it). No proxies, no new telemetry.
5. Every phase must work on macOS, Windows and Linux.
6. Do not reintroduce any licensed/cloud Pluely API code.
7. Commit in small, working slices; rebase on main before each merge.
   Commit messages must not contain AI co-author trailers or "generated
   with" lines.
8. Definition of done for every merge: WORKSPLIT section 5
   (npm run build, cargo check, node --test tests/).

When something you need is owned by Track A, or the interface in
section 3 doesn't cover it, stop and write the question down for the user
instead of editing Track A's files.
```
