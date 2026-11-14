#!/bin/sh
# Builds libarchive for the browser: native/libarchive/out/libarchive.{js,wasm}.
#
# `npm run build` then bundles libarchive.js's worker around that loader and
# puts both files in public/vendor/libarchive/ (scripts/prepare-decoders.mjs).
#
# Needs podman or docker, and curl for the one-time download of the sources
# named in native/libarchive/sources.txt. Every download is checked against
# native/libarchive/sources.sha256 before it is used, and the compiler runs
# without network access. See scripts/lib/fetch-sources.sh and
# scripts/lib/emsdk.sh.
#
# The compile takes a few minutes, so it is skipped when nothing it depends
# on has changed since the last one. FORCE=1 runs it regardless.
#
#   sh scripts/build-libarchive.sh
#   FORCE=1 sh scripts/build-libarchive.sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/lib/emsdk.sh"
. "$ROOT/scripts/lib/fetch-sources.sh"
NATIVE="$ROOT/native/libarchive"
OUT="$NATIVE/out"

WANT="$(build_stamp "$NATIVE")" || { echo "could not hash the build inputs" >&2; exit 1; }

if [ -z "${FORCE:-}" ] && [ -s "$OUT/libarchive.js" ] && [ -s "$OUT/libarchive.wasm" ] &&
  [ "$(cat "$NATIVE/BUILD-STAMP" 2>/dev/null)" = "$WANT" ]; then
  echo "native/libarchive/out is up to date (FORCE=1 to rebuild)"
  exit 0
fi

fetch_sources "$NATIVE"

emsdk_build "$NATIVE" "$OUT" libarchive.js libarchive.wasm

echo "Built native/libarchive/out. Expected hashes are in native/outputs.sha256:"
cd "$ROOT"
checksum native/libarchive/out/libarchive.js native/libarchive/out/libarchive.wasm
