#!/usr/bin/env bash
# Installs the night-runner fork of T3 Code (Apple Silicon macOS) plus the
# local tools its features rely on:
#   curl -fsSL https://raw.githubusercontent.com/HockeyQuebec/t3code/night-runner-features/scripts/install-fork.sh | bash
set -euo pipefail

REPO="HockeyQuebec/t3code"
APP_NAME="T3 Code (Alpha).app"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This build only supports Apple Silicon Macs." >&2
  exit 1
fi

export PATH="$HOME/.local/bin:$PATH"

# claude-swap (cswap) powers multi-account Claude limits and account switching.
if ! command -v cswap >/dev/null 2>&1; then
  if ! command -v uv >/dev/null 2>&1; then
    echo "Installing uv (needed for claude-swap)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
  echo "Installing claude-swap..."
  uv tool install claude-swap
  uv tool update-shell >/dev/null 2>&1 || true
else
  echo "claude-swap already installed."
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Note: Claude Code CLI not found. Install it with: curl -fsSL https://claude.ai/install.sh | bash"
fi

echo "Finding the latest build..."
DMG_URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases" \
  | grep -o '"browser_download_url": *"[^"]*arm64\.dmg"' \
  | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
if [[ -z "$DMG_URL" ]]; then
  echo "Could not find a DMG in the $REPO releases." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'hdiutil detach "$TMP/mnt" -quiet >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

echo "Downloading $DMG_URL"
curl -fL --progress-bar -o "$TMP/t3code.dmg" "$DMG_URL"
hdiutil attach "$TMP/t3code.dmg" -nobrowse -quiet -mountpoint "$TMP/mnt"

if pgrep -xq "T3 Code (Alpha)"; then
  echo "Quit T3 Code (Alpha) before installing, then re-run this script." >&2
  exit 1
fi

rm -rf "/Applications/$APP_NAME"
ditto "$TMP/mnt/$APP_NAME" "/Applications/$APP_NAME"
xattr -dr com.apple.quarantine "/Applications/$APP_NAME" 2>/dev/null || true

echo "Installed /Applications/$APP_NAME"
echo "Run 'cswap add' to register your Claude accounts with claude-swap."
