# Pluely Roadmap: Speed, UX, Personalization & Live Transcription

_Drafted 2026-11-03. Decisions taken:_

- **Hybrid STT**: cloud streaming first, local Whisper fallback. **Deepgram and AssemblyAI both ship as built-in streaming presets.**
- **Local embeddings** for memory search, **model bundled in the installer** (works offline from first launch).
- **All platforms in every phase**: macOS, Windows and Linux stay working at the end of each phase.
- **Licensed Pluely cloud path removed**: bring-your-own-key providers only.
- **Past-answer learning deferred** (no mic capture of the user for now).
- **AI-drafted stories are never used live until you approve them.**

---

## 1. Codebase deep dive: what exists today

### 1.1 Feature inventory

| Area | What it does | Where |
|---|---|---|
| Overlay window | 600×54 always-on-top, content-protected NSPanel; chat input, screenshot, audio | `src/pages/app`, `src-tauri/src/lib.rs`, `window.rs` |
| Dashboard window | Chats, system prompts, shortcuts, screenshot config, audio devices, response settings, Dev Space | `src/pages/*`, `DashboardLayout` |
| Chat completion | Text + image attachments, streaming, history persisted to SQLite | `hooks/useCompletion.ts`, `lib/functions/ai-response.function.ts` |
| System-audio assistant | Captures speaker output → VAD → STT → LLM, quick actions ("What should I say?", "Recap"…) | `hooks/useSystemAudio.ts`, `src-tauri/src/speaker/*` |
| Mic dictation | Browser VAD (`@ricky0123/vad-react`) → STT → fills input | `pages/app/components/completion/AutoSpeechVad.tsx` |
| Screenshots | Full-screen or drag-select, auto-send or attach | `src-tauri/src/capture.rs`, `components/Overlay.tsx` |
| Providers | 11 built-in LLMs + STT presets incl. Local Faster-Whisper; any curl as a custom provider | `config/*.constants.ts`, `pages/dev` |
| System prompts | CRUD in SQLite, templates (Interview Assistant etc.), AI-generated prompts via Pluely API | `pages/system-prompts`, `lib/platform-instructions.ts` |
| Response settings | Length + language instructions appended to every system prompt | `lib/response-settings.constants.ts` |
| Licensing / cloud | Pluely API for chat/STT/models/prompts, keychain-stored license | `src-tauri/src/api.rs`, `activate.rs` |
| Local STT sidecar | FastAPI + faster-whisper, token-auth, one request at a time | `transcription_service/main.py`, `src-tauri/src/transcription.rs` |

### 1.2 How live interview audio flows today

```
Speaker output (ScreenCaptureKit / WASAPI / Pulse)
  → Rust RMS/peak "VAD" (commands.rs: run_vad_capture)
  → wait for ~1.0 s of silence
  → whole utterance encoded as 16-bit WAV at the device rate (usually 48 kHz)
  → base64 → Tauri event "speech-detected"
  → JS decodes base64 → Blob → fetchSTT (HTTP POST, full file)
  → sidecar writes temp file → faster-whisper beam_size=5 → JSON text
  → fetchAIResponse (streaming) → overlay
```

**End-to-end latency** ≈ utterance length + 1.0 s silence + upload + full-file Whisper decode + LLM time-to-first-token. Nothing appears on screen while the interviewer is talking.

### 1.3 Bugs and bottlenecks found (fix these first)

| # | Issue | Location | Impact |
|---|---|---|---|
| B1 | **Conversation history is sent to custom providers newest-first.** System-audio messages are prepended (`[new, ...prev.messages]`) and passed straight to `buildDynamicMessages`, which assumes chronological order. Only the Pluely API path reverses it. | `useSystemAudio.ts` `processWithAI`, `common.function.ts:139` | LLM sees the interview backwards → worse follow-up answers with DeepSeek/OpenAI/etc. |
| B2 | **Abort never reaches the request.** `processWithAI` creates an `AbortController` but does not pass `signal` to `fetchAIResponse`. | `useSystemAudio.ts` | Stopping capture or a new question doesn't cancel the old stream; two answers can interleave in `lastAIResponse`. |
| B3 | **Utterances are dropped while Whisper is busy.** Sidecar returns 429 if a transcription is in flight. | `main.py` `_transcription_lock` | Interviewer's next sentence silently lost during back-to-back speech. |
| B4 | **Stale closures in the speech listener.** Effect deps omit `systemPrompt`, `useSystemPrompt`, `contextContent`, `processWithAI`. | `useSystemAudio.ts` speech-detected effect | Changing prompt/provider mid-session uses old values. |
| B5 | **Mid-question pauses split one question into several LLM calls.** Fixed 1 s silence endpointing with energy VAD. | `commands.rs` | Duplicate/partial answers, wasted tokens. |
| B6 | **Slow local decode.** `beam_size=5`, temp-file round trip, CUDA attempt on macOS (always fails, adds startup time), 48 kHz audio sent then resampled. | `main.py`, `commands.rs` | Seconds of extra latency per utterance on CPU. |
| B7 | **Sidecar isn't bundled and may use the wrong Python.** `find_python` tries `python` first (not the venv); `transcription_service` isn't in `tauri.conf.json` `resources`. | `transcription.rs`, `tauri.conf.json` | Local Whisper fails in production installs or when deps are only in the venv. |
| B8 | **Base64 audio over IPC.** Multi-MB strings through the event bus, then `atob` loop in JS. | `commands.rs`, `useSystemAudio.ts` | CPU spikes, GC pauses in the overlay. |
| B9 | **Pluely API streaming polls every 50 ms** instead of yielding on events. | `ai-response.function.ts`, `chat-constants.ts` | Adds up to 50 ms jitter per chunk (cloud path only). |
| B10 | **No personalization layer.** The only way to add a resume is pasting into a system prompt template; no file upload, no retrieval, whole prompt resent every turn. | `platform-instructions.ts` | Large prompts → slower + costlier; no story recall. |

---

## 2. Target architecture

```
                 ┌─────────────── Rust (src-tauri) ────────────────┐
Speaker audio ──►│ capture → resample 16 kHz PCM16 → Silero VAD     │
                 │      │                                           │
                 │      ├─► Streaming STT client (Deepgram/Assembly │──► provider (direct, no proxy)
                 │      │      WebSocket, interim + final results)  │
                 │      └─► Local fallback: sidecar WS /stream       │──► faster-whisper (sliding window)
                 │                                                  │
                 │ transcript events: partial / final / endpoint    │
                 │ Memory engine: chunk → embed (fastembed-rs) →    │
                 │   SQLite BLOB vectors → cosine top-k             │
                 └──────────────────────────────────────────────────┘
                                   │ events
                 ┌──────────── React (src) ────────────────────────┐
                 │ Live transcript panel (partials stream in)       │
                 │ Question detector → auto-answer trigger          │
                 │ Context builder: profile summary + retrieved     │
                 │   resume/portfolio/story chunks + session JD     │
                 │ fetchAIResponse (unchanged provider pipeline)    │
                 │ Story Bank, Profile, Interview Sessions pages    │
                 └──────────────────────────────────────────────────┘
```

Note on the "LLM calls go out from the frontend" rule: LLM calls stay in the frontend. **Streaming STT is the one deliberate exception** — the audio already lives in Rust, and a Rust WebSocket client avoids pushing ~30 audio events/second through IPC. The privacy invariant (device → provider directly, no proxy) is preserved. Update `CLAUDE.md` to record this.

---

## 3. Phased plan

### Phase 0 — Correctness & quick speed wins (≈2–3 days)

Low risk, immediate benefit; do before any new feature.

1. **B1** Keep system-audio `conversation.messages` chronological (append, render reversed in UI), or reverse before calling `fetchAIResponse`. Audit `useChatCompletion.ts` for the same pattern.
2. **B2** Pass `abortControllerRef.current.signal` into `fetchAIResponse`; reset `lastAIResponse` only for the active request id.
3. **B4** Move prompt/context values into refs (pattern already used in `useCompletion.ts` with `screenshotConfigRef`).
4. **B3** Replace 429 with a small FIFO queue (max 3) in the sidecar; or serialize on the client.
5. **B6** Sidecar: `beam_size=1`, `condition_on_previous_text=False`, decode from in-memory numpy array (no temp file), skip CUDA on macOS, default model `distil-small.en` / `small.en int8`; pass `initial_prompt` with role keywords (see 4.3).
6. **B6/B8** Resample to 16 kHz mono in Rust before encoding (3× smaller payloads); send raw bytes via a Tauri `Channel`/`ipc::Response` instead of base64 events.
7. **B7** Resolve Python from `transcription_service/.venv` first; add the folder to bundle `resources`; show a clear setup state in the UI with a "Test local STT" button.
8. **Remove the licensed Pluely cloud path** (also resolves B9). Do this early so every later phase touches less code:
   - Rust: delete `api.rs` and `activate.rs`; remove their commands from `generate_handler!` in `lib.rs`; drop `LicenseState` gating in `shortcuts.rs`; drop `APP_ENDPOINT` / `API_ACCESS_KEY` / `PAYMENT_ENDPOINT` from `build.rs` and the keychain plugin if nothing else uses it.
   - Frontend: delete `lib/functions/pluely.api.ts` and every `shouldUsePluelyAPI()` branch (`ai-response.function.ts`, `stt.function.ts`, `useCompletion.ts`, `useChatCompletion.ts`, `useSystemAudio.ts`, `AutoSpeechVad.tsx`, `chats/components/AudioRecorder.tsx`, `chats/components/View.tsx`); delete `GetLicense.tsx`, `Promote.tsx`, `system-prompts/PluelyPrompts.tsx`, the dashboard `Usage` panel; strip license state from `app.context.tsx`, `DragButton.tsx`, `ShortcutManager.tsx`.
   - Keep **"Generate system prompt"** (`system-prompts/Generate.tsx`) but reimplement it on the user's selected AI provider.
   - Update `CLAUDE.md` (Environment + Architecture sections) to match.
9. Add a latency HUD (dev toggle): speech-end → transcript → first token → done. Every later phase is measured against it.

### Phase 1 — Fast, live transcription (≈1.5–2 weeks)

**Goal:** words appear while the interviewer speaks; an answer starts streaming < 1.5 s after they finish the question (cloud), < 3 s (local).

1. **Better VAD.** Replace RMS/peak with Silero VAD (ONNX, `voice_activity_detector` or `ort` crate) in Rust. Keep the current settings UI but map it to Silero thresholds; keep RMS as fallback.
2. **Streaming STT provider type.** New provider kind `streaming` alongside curl providers:
   - Two built-in presets behind one Rust trait (`StreamingStt`): Deepgram Live (`nova-3`, `interim_results`, `endpointing`, `smart_format`, `keyterm` boosting) and AssemblyAI Universal-Streaming (turn detection, `keyterms_prompt`). Both map to the same partial/final/turn-end events, so the UI never knows which is active.
   - Rust module `src-tauri/src/stt_stream/` (`tokio-tungstenite`): opens a socket when capture starts, sends 16 kHz PCM16 frames, emits `transcript-partial`, `transcript-final`, `utterance-end` events.
   - API key read from the existing STT provider variables in `localStorage` and passed on `start_system_audio_capture`.
3. **Local streaming fallback.** Sidecar gets `WS /stream`: rolling buffer, re-decode last ~10 s every 500 ms with `beam_size=1`, emit stable prefix ("local agreement") as final, rest as partial. Auto-fallback when offline / no key / socket error.
4. **(Optional spike, macOS 26)** Evaluate Apple `SpeechAnalyzer`/`SpeechTranscriber` via a small Swift bridge: on-device, streaming, no Python. Because every phase must keep Windows/Linux working, this would only be an *extra* Mac-only local engine; the Whisper streaming fallback stays the cross-platform default.
   - **Cross-platform check for Phase 1:** speaker capture already exists on all three OSes (ScreenCaptureKit / WASAPI loopback / PulseAudio); verify the 16 kHz resampler, Silero VAD (`ort` ships Win/Linux/macOS binaries) and the WebSocket client on each before closing the phase.
5. **Smart endpointing & question detection.** Combine provider `utterance_end` / VAD silence with a cheap heuristic (ends with "?", starts with wh-/"tell me"/"walk me through"/"how would you", trailing intonation not needed). Merge fragments arriving within ~1.5 s into one question (fixes B5).
6. **Auto-answer modes** (setting): `Manual` (press shortcut), `On question` (default), `Every utterance`. Optional **speculative start**: begin the LLM call on a confident partial, cancel/restart if the final text differs materially.
7. **Live transcript UI** in the overlay: scrolling transcript with speaker label "Interviewer", partial text in muted style, detected questions highlighted, click any line → "Answer this".
8. **Auto-start capture** (opt-in): start when Zoom/Meet/Teams/Webex audio is active or a calendar-linked session begins; always show a visible "listening" indicator.
9. **Keyterm boosting.** Feed company name, tech stack, and names from the active profile/session into Deepgram `keyterm` or Whisper `initial_prompt` for better accuracy on jargon.

### Phase 2 — Personal profile & knowledge base (≈1.5–2 weeks)

**Goal:** the assistant knows who you are without you pasting a giant prompt.

1. **Profile page** (new dashboard route `/profile`):
   - Personal info: name, current role, years of experience, target roles, location/work authorization, salary expectations (optional, never auto-shared), preferred tone, "things never to say".
   - **Resume upload**: PDF (`pdfjs-dist`), DOCX (`mammoth`), TXT/MD. Parsed locally → editable structured view (experience, skills, education, projects).
   - **Portfolio / links**: website URL, GitHub, LinkedIn export, blog. Fetch with `@tauri-apps/plugin-http`, strip HTML to text (Readability-style), show preview, re-sync button. GitHub: pull README + repo descriptions via public API.
   - Free-form "About me" notes.
2. **Knowledge store** (new SQLite migration `knowledge.sql`):
   ```sql
   documents(id, kind, title, source_uri, content, created_at, updated_at)
   -- kind: resume | portfolio | note | job_description | story | transcript
   chunks(id, document_id, ord, text, embedding BLOB, tokens)
   profile(key TEXT PRIMARY KEY, value TEXT)
   ```
3. **Local embeddings in Rust** with `fastembed` (ONNX). **Bundled in the installer**: ship `all-MiniLM-L6-v2` quantized (~25 MB) or `bge-small-en-v1.5` (~35–130 MB depending on quantization) under `src-tauri/resources/models/`, add it to `tauri.conf.json` `resources`, and load it from `app.path().resource_dir()` via fastembed's user-defined-model API (no network at runtime). Prefer the smallest model that passes a retrieval spot-check on real resume/story data, since it's added to every platform's installer. Commands: `kb_ingest(document_id)`, `kb_search(query, k, kinds[])`. Brute-force cosine in Rust is fine up to tens of thousands of chunks; FTS5 hybrid (BM25 + vector, RRF merge) for exact keyword hits like "Kubernetes".
4. **Context builder** (`src/lib/context/build-context.ts`), used by both chat and system-audio paths:
   - Always-on **profile summary** (≤ 300 tokens, auto-generated once from the resume, user-editable).
   - **Active session** block (company, role, JD highlights — see Phase 4).
   - **Top-k retrieved chunks** for the current question (k≈5, token budget ≈1.5k).
   - Stable parts first so DeepSeek/Anthropic/OpenAI prefix caching kicks in → faster + cheaper.
   - Replaces pasting the resume into the system prompt; existing system prompts still work on top.
5. **Privacy:** everything stored locally; a per-source "include in AI context" toggle; a "what will be sent" preview for any answer.

### Phase 3 — Story Bank & story generation (≈1–1.5 weeks)

**Goal:** when asked "Tell me about a time…", the overlay instantly surfaces your best real story, shaped for the question.

1. **Story Bank page** (`/stories`): STAR/CAR structured stories — title, situation, task, action, result, metrics, skills/competencies tags (leadership, conflict, failure, ambiguity, ownership…), linked company/role, "verified" flag.
2. **Story mining:** "Generate stories from my resume/portfolio" → LLM proposes draft STAR stories per role/project, clearly marked **Draft – fill in real details**; the user edits/approves. Never presented as true until approved.
3. **Story gap analysis:** map stories against a standard behavioral competency list and the active JD; show "you have no story for *disagreeing with a manager*" with a guided prompt to write one.
4. **Live retrieval:** when a behavioral question is detected, search stories first (`kinds=['story']`), show the top 1–2 as a compact card ("Use: *Payments migration outage* — 30-sec version / 2-min version") before the full AI answer streams.
5. **Answer modes** quick-switch: *Talking points*, *30-second*, *Full STAR script*, *Follow-up likely*.
6. **Saved interview transcripts as context (read-only):** past sessions' interviewer questions + generated answers are indexed (`kind=transcript`) so "they asked this last time at Company X" can surface. (Learning from *your spoken* answers stays deferred.)

### Phase 4 — Interview sessions & UX polish (≈1–1.5 weeks)

1. **Interview Session object**: company, role, round type (recruiter/behavioral/technical/system design), interviewer names, JD paste/URL, date. Selecting a session sets context, keyterms, and the system prompt template. Conversation rows link to `session_id`.
2. **Pre-interview prep**: from JD + profile generate likely questions, matched stories, gaps, and "questions to ask them"; one-glance cheat sheet pinned in the overlay.
3. **Question-type routing**: classify each detected question (behavioral / technical concept / coding / system design / situational / small talk / logistics) and use a tailored prompt per type; coding questions suggest taking a screenshot.
4. **Post-interview debrief**: auto summary, questions asked, topics to brush up on, thank-you email draft, saved to the session.
5. **Overlay UX**: keyboard-first controls (shorter / expand / give example / next question), compact "teleprompter" view with large text and auto-scroll, pin answer, copy, adjustable opacity per mode, remember window position per display.
6. **Onboarding wizard**: pick providers → test STT → upload resume → create first session → practice run.

### Later / deferred

- **Learning from your own answers** (needs mic channel + diarization): flag great vs. weak answers, refine stories from what you actually said, pace/filler-word coaching.
- **Mock interview mode**: AI interviewer asks questions from the JD via TTS, you answer by mic, get scored feedback.
- Encrypted-at-rest knowledge DB (SQLCipher) with keychain-held key.
- Export/import profile + story bank (JSON) for backup or a second machine.

---

## 4. Suggested features (beyond the ask), ranked by value / effort

| Feature | Why it fits Pluely | Effort |
|---|---|---|
| **Live transcript with click-to-answer** | Biggest perceived-speed win; user stays in control | M |
| **Question-type routing** | Behavioral vs. coding vs. system design need very different answers | S |
| **Story cards before full answer** | Glanceable in < 1 s; reduces reading load mid-interview | S |
| **Prep pack from JD** | Turns the app from reactive to proactive | M |
| **"Questions to ask them" generator** | Common end-of-interview moment, trivial to add | S |
| **Glossary / jargon explainer** | Interviewer says an unknown acronym → one-line definition inline | S |
| **Follow-up predictor** | After each answer show 2 likely follow-ups + how to handle them | S |
| **Debrief + thank-you email** | Uses data already captured; high perceived value | S |
| **Salary / negotiation helper** | Uses profile expectations; only on explicit request | S |
| **Multi-profile** (e.g., "Backend Eng" vs. "Eng Manager") | Different resumes/stories per target role | M |
| **Meeting mode reuse** | Same pipeline with a "meeting" profile: action items, who-said-what | M |
| **Latency HUD & provider benchmark** | Lets users pick the fastest STT/LLM combo on their machine | S |
| **Mock interview mode** | Practice with the same knowledge base | L |

---

## 5. Speed budget (targets to verify with the latency HUD)

| Stage | Today (est.) | Target cloud | Target local |
|---|---|---|---|
| Silence wait before processing | 1.0 s fixed | 0.3–0.6 s (endpointing) | 0.5–0.8 s |
| STT final after speech end | 1–5 s (full-file, beam 5) | 0.2–0.4 s | 0.8–1.5 s |
| Context build (retrieval) | n/a | < 50 ms | < 50 ms |
| LLM time-to-first-token | 0.5–2 s | 0.4–1 s (prefix cache, small prompt) | same |
| **Question end → first answer words** | **~3–8 s** | **≤ 1.5 s** | **≤ 3 s** |

---

## 6. Implementation order & file touch-list

1. Phase 0 fixes — `useSystemAudio.ts`, `useChatCompletion.ts`, `ai-response.function.ts`, `speaker/commands.rs`, `transcription_service/main.py`, `transcription.rs`, `tauri.conf.json`.
2. Streaming STT — new `src-tauri/src/stt_stream/`, `speaker/commands.rs`, new `vad/` (Silero), `config/stt.constants.ts` (streaming kind), `pages/app/components/speech/*` (live transcript).
3. Knowledge base — new migration in `src-tauri/src/db/`, new `src-tauri/src/kb/` (fastembed + search), `src/lib/database/knowledge.action.ts`, `src/lib/context/`, `src/pages/profile/`.
4. Story Bank — `src/pages/stories/`, story extraction prompts in `src/config/`.
5. Sessions & UX — `src/pages/sessions/`, conversation `session_id` migration, overlay controls.

Each phase ships independently; Phase 0 and Phase 2 can be built in parallel (no shared files).

---

## 7. Resolved decisions (2026-11-03)

| Question | Decision | Consequence |
|---|---|---|
| Streaming STT provider | Deepgram **and** AssemblyAI built in | Shared `StreamingStt` trait in Phase 1; ~2–3 extra days |
| Embedding model delivery | Bundled in installer | Pick the smallest model that retrieves well; installer grows ~25–130 MB on every OS |
| Platforms | All platforms every phase | Each phase ends with a Windows + Linux check; Apple SpeechAnalyzer is an optional Mac extra, not the default |
| Licensed Pluely cloud path | Removed | New Phase 0 step; "Generate system prompt" moves to the user's own provider |
| AI-drafted stories | Not used live until approved | Story Bank stores a `verified` flag; live retrieval filters on it |

Remaining open item: CI or a test machine for Windows/Linux, since nothing in the repo builds or tests those platforms today.
