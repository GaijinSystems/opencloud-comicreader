#!/bin/sh
# Builds public/vendor/unarr/unarr-rar.{mjs,wasm} from native/unarr.
#
# The outputs are not committed: run this once after cloning, and again after
# changing anything named in native/unarr/build-inputs.txt (`npm run build`
# says when that is needed). It needs podman or
# docker, nothing else: the compiler runs in the Emscripten SDK container.
# See scripts/lib/emsdk.sh for how, and for the pinned compiler.
#
#   sh scripts/build-unarr.sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/lib/emsdk.sh"

emsdk_build "$ROOT/native/unarr" "$ROOT/public/vendor/unarr" unarr-rar.mjs unarr-rar.wasm

echo "Built public/vendor/unarr. Expected hashes are in native/outputs.sha256:"
cd "$ROOT"
checksum public/vendor/unarr/unarr-rar.mjs public/vendor/unarr/unarr-rar.wasm
