# Dependency and security maintenance — 3 November 2026

## Verification

- npm: all 48 direct packages are on their latest stable releases; `npm outdated` returns `{}`. `npm audit` reports **0 vulnerabilities**.
- Python: 33 runtime dependencies are pinned with upstream artifact hashes. `pip-audit` reports **0 known vulnerabilities**. The fresh project virtual environment passes runtime imports and `pip check`.
- Regression tests: **7 JavaScript, 8 Python, and 1 Rust tests pass**.
- Frontend: TypeScript checking and the Vite production build pass. Vite still reports large output chunks; bundle optimization belongs to the improvement phase.
- Rust: the native debug build and library test pass. RustSec reports **0 known vulnerabilities in the compiled macOS build graph**. The full lockfile retains **1 unpatched advisory in an unused SQLx MySQL dependency**, detailed below. No advisories were suppressed.
- Audit JSON, the compiled dependency tree, and validation details are saved in `security-audit/2026-11-03/`.

## Findings addressed

| ID | Severity | Finding and remediation | Evidence in updated source |
| --- | --- | --- | --- |
| SEC-01 | Critical | The original npm tree included critical dependency advisories. Upgraded packages, removed an unused keychain JavaScript package with vulnerable build dependencies, and selected patched KaTeX and fflate transitive versions. Streamdown's current code, math, and diagram plugins preserve those rendering features. | `package.json`, `package-lock.json`, `src/components/Markdown/index.tsx` |
| SEC-02 | High | The transcription service listened on every interface without authentication and allowed every browser origin. It now binds to loopback, requires a per-launch bearer token, restricts CORS, and validates the Host header. This prevents unauthenticated remote clients and websites from using the local inference service. | `transcription_service/main.py:53`, `src-tauri/src/transcription.rs`, `src/lib/functions/stt.function.ts` |
| SEC-03 | High | License credentials were written to plaintext `secure_storage.json`; selected provider keys and custom cURL templates were stored in localStorage. Credentials now use the native OS credential store. Migration removes plaintext only after the secure write succeeds. LocalStorage retains non-sensitive synchronization metadata. | `src-tauri/src/activate.rs:82`, `src/lib/storage/provider-credentials.ts:5`, `src/contexts/app.context.tsx` |
| SEC-04 | High | `API_ACCESS_KEY` was embedded into the Rust executable by the build script. Removed that compilation path. Cloud features now require the key at runtime; development loads the local `.env` at startup. Added environment files and Python environments to `.gitignore`. | `src-tauri/build.rs`, `src-tauri/src/api.rs:21`, `src-tauri/src/activate.rs:20`, `.env.example` |
| SEC-05 | Medium | Audio uploads and inference requests had no explicit resource limits. Added a body limit before multipart processing, a 25 MiB audio limit, one active inference, file cleanup, and generic client-facing errors. | `transcription_service/main.py:48`, `transcription_service/test_security.py` |
| SEC-06 | Medium | Desktop CSP was disabled and VAD executable assets could be loaded remotely. Enabled a policy that blocks remote scripts and frames, bundles VAD assets locally, and permits WebAssembly. Inline styles remain necessary for React/chart/KaTeX styling; JavaScript eval and inline scripts are not allowed. Markdown links now accept only HTTP(S), and chart styles use React text children instead of raw HTML insertion. | `src-tauri/tauri.conf.json:33`, `scripts/prepare-vad-assets.mjs`, `src/components/Markdown/index.tsx`, `src/components/ui/chart.tsx` |
| SEC-07 | Medium | Transcript contents and license-bearing error payloads could enter logs. Removed transcript text, uploaded filenames, and serialized license payloads from routine logs. Client errors no longer expose internal exception details. | `transcription_service/main.py`, `src-tauri/src/api.rs` |
| SEC-08 | Low | Configurable object-path helpers could traverse prototypes, and template variable names became regular expressions. Blocked prototype path segments, restricted reads to own properties, and made substitutions literal. The vulnerable setter had no current internal call sites; the fix prevents unsafe future use. | `src/lib/functions/common.function.ts:3`, `tests/template-security.test.mjs` |
| SEC-09 | Medium | The sidecar launcher searched the arbitrary working directory for Python code. It now searches application directories and the fixed development source directory, prefers an installed service virtual environment, and serializes startup between windows. | `src-tauri/src/transcription.rs:32`, `src-tauri/src/transcription.rs:64` |

## Remaining upstream notices

**RUSTSEC-2023-0071 — rsa 0.9.10:** the latest stable RSA release has no patch for its timing-side-channel advisory. SQLx records its optional MySQL driver and RSA dependency in Cargo.lock even though this app enables SQLite only. `cargo tree` confirms that neither RSA nor the MySQL driver is compiled in this macOS build. The full-lockfile audit intentionally remains visible with this finding; it has not been ignored or described as fixed. [Upstream advisory](https://rustsec.org/advisories/RUSTSEC-2023-0071.html).

The full lockfile also contains five unmaintained-crate notices (`paste`, `proc-macro-error`, `zbus_names`, `zvariant`, and `zvariant_derive`) and the GLib 0.18.5 iterator-unsoundness notice from the Linux GTK dependency path. The compiled macOS tree contains only the informational `paste` maintenance notice. Those platform/upstream notices require tracking; this pass does not certify the Linux build as free of advisories.

Eight other Rust advisories were removed by replacing the obsolete PostHog plugin/SDK HTTP and TLS stack with the app's patched reqwest transport. Only the two existing event types and an explicit allowlist of non-content properties are accepted. Replaced unmaintained `dotenv` with `dotenvy`. A Rust regression test confirms that credentials, conversation text, and session-recording events cannot enter analytics payloads.

## Operational notes

- Use Node 22.18 or newer. The frontend now uses TypeScript 7, Vite 8, React 19.3, Recharts 3, and Streamdown 2.
- The native macOS panel integration now uses the maintained published `tauri-nspanel` release. The updater's native process plugin is registered for relaunch support.
- Python installation and standalone-service authentication are documented in `transcription_service/README.md`.
- No Git repository was present. Original source files are preserved in `/private/tmp/pluely-before-upgrade/source.tar.gz`; the old Python virtual environment is preserved alongside it.
- These checks cover dependency advisories and the reviewed application paths. They do not constitute a penetration test or verification of external cloud services. Hardware capture, microphone permissions, installer signing, and Windows/Linux runtime behavior require platform testing.

## References

- [PostHog event capture API](https://posthog.com/docs/api/capture)

- [Tauri content security policy](https://v2.tauri.app/security/csp/)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Keyring platform credential stores](https://docs.rs/keyring/latest/keyring/v1/)
- [Maintained macOS panel integration](https://github.com/ahkohd/tauri-nspanel/tree/v2.1)
