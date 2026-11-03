# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install JS deps (Rust deps fetch on first build)
npm install

# Run the full app (Tauri shell + Vite dev server on :1420)
npm run tauri dev

# Frontend-only dev server (no Rust backend, mostly useless on its own)
npm run dev

# Type-check + build the frontend bundle into ./dist
npm run build

# Build production installers (.dmg / .msi / .deb / .AppImage / ...) into
# src-tauri/target/release/bundle/
npm run tauri build
```

There is no test runner, lint script, or formatter configured. Type-checking happens via `tsc` inside `npm run build`. `tsconfig.json` enables `strict`, `noUnusedLocals`, `noUnusedParameters` — any unused symbol fails the build.

The local transcription sidecar (Python) installs with:

```bash
pip install -r transcription_service/requirements.txt
```

It is launched and killed by the Rust backend via `transcription::start_transcription_service` — you do not normally run it by hand.

## Environment

`.env` (loaded by `src-tauri/build.rs` via `dotenv`) bakes a few values into the Rust binary at compile time:

- `APP_ENDPOINT`, `API_ACCESS_KEY`, `PAYMENT_ENDPOINT` — only needed for the Pluely licensed/cloud API path. Local DeepSeek + Faster-Whisper works without them.
- `POSTHOG_API_KEY` — telemetry (session recording / pageviews are force-disabled in `lib.rs`).
- `TRANSCRIPTION_PORT` (default `8787`), `WHISPER_MODEL` (default `small.en`), `WHISPER_COMPUTE_TYPE` (default `int8`) — read at runtime by the Python sidecar.

## Architecture

Pluely is a Tauri 2 desktop app: **React 19 + TypeScript frontend** (`src/`), **Rust backend** (`src-tauri/src/`), and an **optional Python FastAPI sidecar** for local Whisper transcription (`transcription_service/`). All persistent app data lives on the user's device — SQLite for chat/prompts, `localStorage` for settings, OS keychain for license keys.

### Window model — two React entry points in one bundle

`src/main.tsx` branches on `getCurrentWindow().label`:

- Labels starting with `capture-overlay-` render only the `<Overlay>` component (used by `capture::start_screen_capture` for the screenshot selection UI). **No providers, no router.**
- Everything else mounts `<ThemeProvider><AppProvider><AppRoutes /></AppProvider></ThemeProvider>` and uses React Router.

Routing (`src/routes/index.tsx`):
- `/` → the **main overlay** (`pages/app`) — a 600×54 transparent, always-on-top, screen-capture-protected window defined in `src-tauri/tauri.conf.json`.
- `/dashboard`, `/chats`, `/chats/view/:conversationId`, `/system-prompts`, `/shortcuts`, `/screenshot`, `/settings`, `/audio`, `/responses`, `/dev-space` → all wrapped in `DashboardLayout` and rendered inside the separate `dashboard` window (created up-front in `lib.rs` setup via `window::create_dashboard_window`).

On macOS the main window is converted to an `NSPanel` via `tauri-nspanel` (see `init()` at the bottom of `src-tauri/src/lib.rs`) so it floats above full-screen apps, doesn't steal focus, and is invisible to screen-share/recording (`macOSPrivateApi: true` + `contentProtected: true`).

### Rust backend modules (`src-tauri/src/`)

Everything is plumbed through `tauri::generate_handler![...]` in `lib.rs`. When the frontend calls `invoke("foo", ...)`, look in:

- `window.rs` — main/dashboard window creation, sizing, positioning, move/toggle.
- `capture.rs` — screenshot capture (full screen + drag-to-select via per-monitor `capture-overlay-N` windows).
- `shortcuts.rs` — global shortcut registration with `tauri-plugin-global-shortcut`. `RegisteredShortcuts` holds the active bindings; the central handler in `lib.rs` dispatches by action_id, with a special `move_window_<direction>` prefix for press/release handling of arrow-key window movement. `LicenseState` gates certain actions.
- `speaker/` — system audio capture, split per OS (`macos.rs` uses `cidre` ScreenCaptureKit, `windows.rs` uses WASAPI loopback, `linux.rs` uses PulseAudio). Shared VAD config + ringbuf in `mod.rs`; commands in `commands.rs`.
- `transcription.rs` — manages the Python FastAPI sidecar lifecycle. Killed automatically when the `main` window is destroyed (see `on_window_event` in `lib.rs`).
- `api.rs` — server-side HTTP calls for licensed/cloud features (chat streaming, transcription, models, prompts, activity).
- `activate.rs` — license activation, validation, masking; secure storage via `tauri-plugin-keychain`.
- `db/` — `tauri-plugin-sql` SQLite migrations (`migrations/system-prompts.sql`, `migrations/chat-history.sql`). Migrations are owned by Rust; the frontend talks to the same DB via `@tauri-apps/plugin-sql` (`src/lib/database/config.ts`, DB name `sqlite:pluely.db`).

The window-destroyed handler only acts when `window.label() == "main"` — closing the dashboard does not kill the transcription service.

### Frontend structure (`src/`)

- `contexts/app.context.tsx` is the central state hub. It owns the system prompt, selected AI/STT providers, custom curl-based providers (parsed/validated with `@bany/curl-to-json`), audio device selection, screenshot config, shortcut config, license state, and customizable settings (theme, transparency, autostart, dock visibility, always-on-top, cursor type). It listens to Tauri events and persists most state to `localStorage` via `lib/storage/`.
- `hooks/` — feature-level hooks (`useChatCompletion`, `useCompletion`, `useSystemAudio`, `useGlobalShortcuts`, `useHistory`, `useSettings`, …). These are the layer the pages compose.
- `lib/functions/` — the actual AI / STT request execution. `ai-response.function.ts` and `stt.function.ts` substitute the `{{TEXT}}`, `{{IMAGE}}`, `{{SYSTEM_PROMPT}}`, `{{MODEL}}`, `{{API_KEY}}`, `{{AUDIO}}`, `{{LANGUAGE}}` variables into user-defined curl templates and stream responses. `pluely.api.ts` is the licensed/cloud path.
- `lib/database/` — chat-history and system-prompt actions; works on top of the SQLite DB the Rust side migrates.
- `lib/storage/` — typed wrappers around `localStorage` for each settings cluster.
- `config/ai-providers.constants.ts` and `config/stt.constants.ts` — the curated list of pre-configured providers (OpenAI, Anthropic, Gemini, Groq, Ollama, Whisper, Deepgram, …). Custom providers are user-added curl commands stored under `curl_custom_*` keys in `localStorage`.
- `components/ui/` — shadcn/ui components (Radix + Tailwind v4).
- `pages/<feature>/` — each route is a folder with `index.tsx` plus `components/`. Page barrels are re-exported from `src/pages/index.ts`.

Path alias: `@/*` → `src/*` (see `tsconfig.json` and `vite.config.ts`).

### Custom provider pipeline (the "Dev Space" feature)

Both AI and STT providers can be defined by the user as a curl command containing `{{VARIABLES}}`. The runtime path:

1. User pastes a curl in Dev Space → validated with `@bany/curl-to-json` → stored as JSON in `localStorage` under `curl_custom_ai_providers` or `curl_custom_speech_providers`.
2. `AppProvider` (`src/contexts/app.context.tsx`) loads + re-validates these on every mount and merges them with the constants list.
3. At call time, `lib/functions/ai-response.function.ts` / `stt.function.ts` interpolate runtime values (`{{TEXT}}`, `{{IMAGE}}`, `{{API_KEY}}`, `{{AUDIO}}`, …) and execute through `@tauri-apps/plugin-http` (bypasses CSP/CORS).

When adding a new built-in provider, add it to `src/config/ai-providers.constants.ts` or `stt.constants.ts` — do **not** add it to the Rust side; all third-party LLM calls go out from the frontend.

### Privacy invariants (don't break these)

- Chat history, attachments, settings: never leave the device. Telemetry (PostHog) is opted in to events only — session recording, pageviews, pageleaves are disabled in `lib.rs`.
- API keys and license tokens: keys live in `localStorage`; the license key is in OS keychain via `activate::secure_storage_*`.
- Third-party LLM/STT calls go **directly** from the user's device to the chosen provider — there is no proxy. Preserve this when adding providers.
