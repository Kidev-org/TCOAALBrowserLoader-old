#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Build the TCOAAL desktop apps (Tauri v2) as standalone, portable builds and
# drop them into tools/bin/. No installers (deb/rpm/AppImage/dmg/msi/NSIS) are
# produced: each app is a folder you can copy anywhere and run in place.
# Runs the same steps as the CI workflow, locally:
#   - npm install (@tauri-apps/cli) per app
#   - generate icons from app/img/icon-512.png
#   - stage a Node runtime into src-tauri/runtime/ (this machine's node)
#   - tauri build --no-bundle
#   - assemble the portable layout under tools/bin/
#
# The app finds its bundled tools/, app/js/libs/ and Node runtime through
# Tauri's resource dir, which is resolved from the executable's location - so
# the layout is not cosmetic, it is what makes the build runnable:
#   Linux    tools/bin/<Product>/bin/<exe>       + <Product>/lib/<Product Name>/
#   Windows  tools/bin/<Product>/<exe>.exe       + <Product>/{tools,app,runtime}
#   macOS    tools/bin/<Product Name>.app        (the .app *is* the standalone app)
# On macOS a bare executable cannot work at all (it resolves resources at
# ../Resources), so there we ask Tauri for the `app` bundle, which is the
# application itself and not an installer.
#
# Usage:
#   ./build.sh            # build both apps (creator + user)
#   ./build.sh creator    # build only the creator app
#   ./build.sh user       # build only the installer app
set -euo pipefail

# This script lives in tools/; TOOLS is tools/, ROOT is the repo root.
TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$TOOLS")"
DESKTOP="$TOOLS/desktop"
BIN="$TOOLS/bin"
ICON_SRC="$ROOT/app/img/icon-512.png"
STAGE_PORTABLE="$DESKTOP/stage-portable.js"

# node.exe on Windows (git-bash / msys), node elsewhere.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) PLATFORM="windows"; NODE_NAME="node.exe"; EXE_EXT=".exe" ;;
  Darwin*) PLATFORM="macos"; NODE_NAME="node"; EXE_EXT="" ;;
  *) PLATFORM="linux"; NODE_NAME="node"; EXE_EXT="" ;;
esac

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' not found in PATH" >&2; exit 1; }; }
need node
need npm
need cargo

# On git-bash `command -v node` reports the path without the .exe suffix; most
# msys tools cope, but be explicit so `cp` never misses.
NODE_BIN="$(command -v node)"
[ -f "$NODE_BIN" ] || NODE_BIN="$NODE_BIN.exe"
[ -f "$NODE_BIN" ] || { echo "error: cannot locate the node binary ($NODE_BIN)" >&2; exit 1; }

# conf_get <tauri.conf.json> <key>
conf_get() {
  node -e 'process.stdout.write(String(require(process.argv[1])[process.argv[2]] ?? ""))' "$1" "$2"
}

# build_app <app-dir-name> <cargo-bin-name>
build_app() {
  local app="$1" binname="$2"
  local appdir="$DESKTOP/$app"
  echo
  echo "==> Building '$app' ($binname)"
  [ -d "$appdir" ] || { echo "error: no such app: $appdir" >&2; exit 1; }
  cd "$appdir"

  # Tauri CLI (local devDependency).
  if [ ! -x "node_modules/.bin/tauri" ]; then
    echo "    npm install..."
    npm install --no-audit --no-fund >/dev/null
  fi

  # Icons (Tauri build needs them present).
  if [ ! -f "src-tauri/icons/icon.ico" ]; then
    echo "    generating icons..."
    npx --yes @tauri-apps/cli icon "$ICON_SRC" >/dev/null
  fi

  # Bundle a Node runtime for the app to shell out to.
  echo "    staging node runtime..."
  mkdir -p "src-tauri/runtime"
  cp "$NODE_BIN" "src-tauri/runtime/$NODE_NAME"
  chmod +x "src-tauri/runtime/$NODE_NAME" 2>/dev/null || true

  echo "    tauri build (first run compiles the crate graph; be patient)..."
  if [ "$PLATFORM" = "macos" ]; then
    npx --yes @tauri-apps/cli build --bundles app
  else
    npx --yes @tauri-apps/cli build --no-bundle
  fi

  # Assemble the portable build in tools/bin/.
  local product rel out
  product="$(conf_get "$appdir/src-tauri/tauri.conf.json" productName)"
  [ -n "$product" ] || { echo "error: tauri.conf.json has no productName" >&2; exit 1; }
  rel="$DESKTOP/target/release"
  mkdir -p "$BIN"

  if [ "$PLATFORM" = "macos" ]; then
    # The `app` bundler already staged the resources into Contents/Resources.
    local src="$rel/bundle/macos/$product.app"
    [ -d "$src" ] || { echo "error: tauri produced no app bundle at $src" >&2; exit 1; }
    rm -rf "$BIN/$product.app"
    cp -R "$src" "$BIN/"
    echo "    -> $BIN/$product.app"
    return
  fi

  [ -f "$rel/$binname$EXE_EXT" ] || {
    echo "error: tauri produced no executable at $rel/$binname$EXE_EXT" >&2
    exit 1
  }
  out="$BIN/${product// /-}"
  rm -rf "$out"
  if [ "$PLATFORM" = "windows" ]; then
    # Windows resolves resources next to the executable.
    mkdir -p "$out"
    cp "$rel/$binname$EXE_EXT" "$out/"
    node "$STAGE_PORTABLE" "$appdir/src-tauri" "$out"
  else
    # Linux resolves them at <exe dir>/../lib/<productName>.
    mkdir -p "$out/bin"
    cp "$rel/$binname" "$out/bin/"
    node "$STAGE_PORTABLE" "$appdir/src-tauri" "$out/lib/$product"
  fi
  echo "    -> $out/"
}

target="${1:-all}"
case "$target" in
  creator) build_app creator tcoaal-mod-creator ;;
  user)    build_app user tcoaal-mod-installer ;;
  all)
    build_app creator tcoaal-mod-creator
    build_app user tcoaal-mod-installer
    ;;
  *) echo "usage: $0 [creator|user|all]" >&2; exit 1 ;;
esac

echo
echo "Done. Standalone builds are in: $BIN"
