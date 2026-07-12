#!/usr/bin/env bash
# Reproducible build of dist/loomfall.html — a single self-contained, offline,
# file://-runnable browser build of the single-player Loomfall voxel game.
#
# Pipeline:
#   1. Copy public/ to a writable BUILD dir (public/ stays pristine).
#   2. Patch the BUILD copy for offline single-player (see PATCHES below).
#   3. esbuild -> one minified IIFE bundle (three aliased to the vendored copy;
#      node builtins externalized; NO runtime local dynamic import()).
#   4. assemble.mjs -> fold bundle + inlined CSS + data-URI brand images +
#      an embedded /content & /ux map + a fetch/WebSocket shim into ONE html.
#
# PATCHES applied to the BUILD copy (NOT to public/):
#   - src/net/NetClient.js        connect() resolves a synthetic offline welcome
#                                 from localStorage (loomfall.worlds /
#                                 loomfall.edits.<id>); sendEdit persists edits;
#                                 all other wire methods are offline no-ops.
#   - graphics/src/greedyMesher.js  top-level `await import('three')` shim ->
#                                 static imports; node self-test block removed
#                                 (top-level await is illegal in an IIFE).
#   - graphics/src/chunkManager.js, graphics/src/instancedProps.js
#                                 node self-test blocks (top-level await) gated
#                                 to `if (false)`.
#   - ui-integrate/integrate.js   _loadComponent/_importUx: runtime dynamic
#                                 import(computedPath) -> static import maps;
#                                 _linkCss made a no-op (CSS is inlined).
#   - audio-integrate/integrate.js  dynamic import of volume-settings.js ->
#                                 static side-effect import.
#   - ux/options/options-store.js  _ensureCss made a no-op (CSS is inlined).
set -euo pipefail

REPO=/home/user/MinecraftV2
SCRATCH=/tmp/claude-0/-home-user-MinecraftV2/04ddf0be-7d6d-5fd2-8d4b-0a801ef56ca9/scratchpad
BUILD="${BUILD:-$SCRATCH/buildsrc}"   # must already contain the patched copy
BUNDLE="${BUNDLE:-$SCRATCH/bundle.js}"

echo "[build] esbuild bundle -> $BUNDLE"
npx --yes esbuild@0.24.2 "$BUILD/src/main.js" \
  --bundle --format=iife --platform=browser --target=es2020 \
  --alias:three="$BUILD/vendor/three.module.js" \
  --loader:.json=json --minify --legal-comments=none \
  --external:node:fs/promises --external:node:url --external:node:fs \
  --external:node:path --external:node:http \
  --outfile="$BUNDLE" --log-level=error

echo "[build] import() sanity (expect only node: externals):"
grep -oE ".{12}import\(.{30}" "$BUNDLE" || true

echo "[build] assemble -> $REPO/dist/loomfall.html"
node "$REPO/dist/assemble.mjs"

echo "[build] done."
