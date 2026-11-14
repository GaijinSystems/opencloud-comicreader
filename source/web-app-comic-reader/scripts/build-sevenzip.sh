#!/bin/sh
# Builds public/vendor/sevenzip/sevenzip.{mjs,wasm}: 7-Zip's 7z reader, which
# the app uses for password-protected 7z archives.
#
# The outputs are not committed: run this once after cloning, and again after
# changing anything named in native/sevenzip/build-inputs.txt (`npm run build`
# says when that is needed).
#
# Needs podman or docker, and curl for the one-time download of the 7-Zip
# source named in native/sevenzip/sources.txt. The download is checked
# against native/sevenzip/sources.sha256 before it is used, and the compiler
# runs without network access. See scripts/lib/fetch-sources.sh and
# scripts/lib/emsdk.sh.
#
#   sh scripts/build-sevenzip.sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/lib/emsdk.sh"
. "$ROOT/scripts/lib/fetch-sources.sh"
NATIVE="$ROOT/native/sevenzip"

fetch_sources "$NATIVE"

emsdk_build "$NATIVE" "$ROOT/public/vendor/sevenzip" sevenzip.mjs sevenzip.wasm

echo "Built public/vendor/sevenzip. Expected hashes are in native/outputs.sha256:"
cd "$ROOT"
checksum public/vendor/sevenzip/sevenzip.mjs public/vendor/sevenzip/sevenzip.wasm
