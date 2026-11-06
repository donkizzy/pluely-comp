#!/usr/bin/env bash
# Cross-compiles the Windows NSIS installer from macOS, without Windows or CI.
# MSI output is not possible here: WiX only runs on Windows.
#
# Prerequisites (Docker must be running):
#   brew install llvm lld
#   rustup target add x86_64-pc-windows-msvc
#   cargo install --locked cargo-xwin
#
# cargo-xwin downloads the Microsoft CRT and Windows SDK; using it accepts
# Microsoft's license: https://go.microsoft.com/fwlink/?LinkId=2086102
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tools="$(mktemp -d)"
trap 'rm -rf "$tools"' EXIT

# Homebrew's makensis 3.13 aborts with bad_alloc on any script on arm64 macOS,
# so makensis runs from a Linux container that sees the same absolute paths.
# Tauri's installer template needs NSIS 3.11+, which rules out older Debian.
docker build -q -t pluely-makensis - >/dev/null <<'EOF'
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends nsis && rm -rf /var/lib/apt/lists/*
EOF

cat >"$tools/makensis" <<EOF
#!/usr/bin/env bash
exec docker run --rm \\
  -v "$root:$root" \\
  -v "$HOME/Library/Caches/tauri:$HOME/Library/Caches/tauri" \\
  -w "\$PWD" pluely-makensis makensis "\$@"
EOF
chmod +x "$tools/makensis"

export PATH="$tools:/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"

cd "$root"
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
