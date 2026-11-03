# Track B integration handoff

The public `ContextRequest`, `ContextResult`, `StoryCard`, `QuestionType`, and
`buildInterviewContext` interface follows WORKSPLIT section 3.1 with the user-approved optional `prepPack?: string` extension (2026-11-03).
Track A can import it without passing an active session id. It enforces a
45 ms fallback, verified/included stories only, at most two cards, and no
salary-expectations field in automatic context.

Profile and sessions have explicit inclusion controls. Active selection uses
`active_interview_session_id` and the Tauri `active-session-changed` event.
Existing conversations retain their session when a different session is selected.

## Questions requiring the user / Track A

- Prep packs are available on the session page. The overlay's pinned prep
  cheat sheet needs Track A UI. The user approved the read interface: `ContextResult.prepPack?: string` is approved.
  It contains the saved prep pack for the included active session; Track A owns its pin control.
- The overlay's story answer-mode switch belongs to Track A. StoryCard already
  supplies short and long approved content; Track A can render talking points,
  30-second, STAR and likely-follow-up controls without Track B editing the overlay.
- Native Windows/Linux build runners are not configured in this repository.
  A supported CI runner or test machine is needed for native platform validation.

## Privacy and storage

- MiniLM files are bundled under resources/models/minilm with pinned provenance,
  Apache-2.0 license, and SHA-256 checksums. There is no runtime model download.
- PDF/DOCX parsing and embeddings are local. URL import fetches only on a user action.
- Every AI drafting request uses the unchanged fetchAIResponse with the selected
  provider and an editable input preview. No proxy, telemetry, or licensed API.
- Story edits revoke approval. Atomic index/approval checks prevent approval of
  facts changed while embeddings were computing.
- Historical transcripts are indexed explicitly and excluded by default. AI
  suggestions are labelled and cannot count as candidate-authored achievements.
- Deleting chats also removes their indexed transcript copies.

## Verification

Run `npm run build`, `cargo check` in src-tauri, `node --test tests/`, and
`node --test src/lib/context/knowledge.test.mjs`.
Rust retrieval/model tests: `cargo test --lib kb:: -- --nocapture`.
