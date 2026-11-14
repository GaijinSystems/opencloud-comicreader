#!/bin/sh
# Compiles libarchive and the libarchive.js C wrapper to WebAssembly.
#
# Runs INSIDE an Emscripten container; use scripts/build-libarchive.sh to
# start it. Nothing here touches the network.
#   /src    this directory (native/libarchive), read-only. /src/.cache holds
#           the source tarballs listed in sources.txt, already checked
#           against sources.sha256
#   /out    an empty scratch directory; receives libarchive.js (the loader)
#           and libarchive.wasm, which are then copied to native/libarchive/out
set -eu

WORK=/tmp/libarchive-build
PREFIX=$WORK/prefix
JOBS=$(nproc 2>/dev/null || echo 2)
mkdir -p "$WORK" "$PREFIX/lib" "$PREFIX/include"
cd "$WORK"

# Checked again here, so the build cannot run on sources it was not meant for.
(cd /src/.cache && sha256sum -c /src/sources.sha256)
# Only the tarballs that were just checked. The cache may hold others, such as
# the previous version after an update, and those must not be compiled.
while read -r _ archive || [ -n "$archive" ]; do
  tar xzf "/src/.cache/$archive"
done < /src/sources.sha256

# This app's changes to libarchive itself: see the README beside this file.
# Each must be named in build-inputs.txt, so that it is part of the build
# stamp, and must fit exactly: a hunk that is already there, or that only
# fits loosely (after a new libarchive release, say), is an error.
for change in /src/patches/*.patch; do
  grep -qx "native/libarchive/patches/$(basename "$change")" /src/build-inputs.txt || {
    echo "$change is not listed in build-inputs.txt" >&2
    exit 1
  }
  patch --forward --batch --fuzz=0 -p1 -d libarchive-*/ < "$change"
done

# The codecs libarchive is built on. Static, no programs, no assembler.
(
  cd zlib-*/
  emconfigure ./configure --static --prefix="$PREFIX"
  emmake make -j"$JOBS" libz.a
  cp libz.a "$PREFIX/lib/"
  cp zlib.h zconf.h "$PREFIX/include/"
)
(
  cd bzip2-*/
  emmake make -j"$JOBS" libbz2.a CC=emcc AR=emar RANLIB=emranlib \
    CFLAGS="-O2 -D_FILE_OFFSET_BITS=64"
  cp libbz2.a "$PREFIX/lib/"
  cp bzlib.h "$PREFIX/include/"
)
(
  cd xz-*/
  emconfigure ./configure --prefix="$PREFIX" --enable-static --disable-shared \
    --disable-assembler --enable-threads=no --disable-nls --disable-doc \
    --disable-xz --disable-xzdec --disable-lzmadec --disable-lzmainfo \
    --disable-lzma-links --disable-scripts
  emmake make -j"$JOBS"
  emmake make install
)

# libarchive itself. No crypto library at all: OpenSSL, which upstream
# libarchive.js links, is left out on purpose. Its old licence does not combine
# with the AGPL, and this app refuses encrypted archives anyway. Without one,
# libarchive cannot decrypt AES-encrypted zip or 7z, and reports them as such.
(
  cd libarchive-*/
  CPPFLAGS="-I$PREFIX/include" LDFLAGS="-L$PREFIX/lib" \
    emconfigure ./configure --prefix="$PREFIX" --enable-static --disable-shared \
    --disable-bsdtar --disable-bsdcat --disable-bsdcpio --disable-bsdunzip \
    --enable-posix-regex-lib=libc --disable-xattr --disable-acl \
    --without-openssl --without-mbedtls --without-nettle --without-cng \
    --without-lz4 --without-zstd --without-lzo2 --without-libb2 \
    --without-xml2 --without-expat
  emmake make -j"$JOBS" libarchive.la
  emmake make install-libLTLIBRARIES install-includeHEADERS
)

# The wrapper libarchive.js's worker calls into, and the final link.
# -sDYNAMIC_EXECUTION=0 keeps eval() and new Function() out of the loader, so
# the module needs 'wasm-unsafe-eval' in the page's CSP and nothing more.
# -sWASM_BIGINT=0 makes 64-bit results (archive_entry_size) arrive in
# JavaScript as plain numbers, which is what libarchive.js's worker, written
# against an older Emscripten, does arithmetic on. Only the low 32 bits
# arrive, signed: sizes are right below 2 GiB and negative from there to
# 4 GiB. The adapter treats a negative size as an entry it cannot read.
emcc -O3 -I"$PREFIX/include" -c /src/libarchivejs/main.c -o main.o
emcc -O3 main.o \
  "$PREFIX/lib/libarchive.a" "$PREFIX/lib/liblzma.a" "$PREFIX/lib/libz.a" "$PREFIX/lib/libbz2.a" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=libarchive \
  -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 \
  -sDYNAMIC_EXECUTION=0 -sWASM_BIGINT=0 \
  -sEXPORTED_FUNCTIONS=@/src/libarchivejs/lib.exports \
  -sEXPORTED_RUNTIME_METHODS=cwrap,HEAPU8 \
  -o /out/libarchive.js

# Neither word appears anywhere in a clean loader.
if grep -q 'Function\|eval' /out/libarchive.js; then
  echo "the generated loader contains dynamic code evaluation" >&2
  exit 1
fi
if grep -qi 'openssl' /out/libarchive.wasm; then
  echo "OpenSSL found its way into the module" >&2
  exit 1
fi

echo "built libarchive with $(emcc --version | head -1)"
