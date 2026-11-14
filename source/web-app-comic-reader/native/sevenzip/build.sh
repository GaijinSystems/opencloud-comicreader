#!/bin/sh
# Compiles 7-Zip's 7z reader, its decryption routines for RAR and zip AES,
# and glue.cpp to WebAssembly.
#
# Runs INSIDE an Emscripten container; use scripts/build-sevenzip.sh to start
# it. Nothing here touches the network.
#   /src    this directory (native/sevenzip), read-only. /src/.cache holds the
#           source tarball named in sources.txt, already checked against
#           sources.sha256
#   /out    an empty scratch directory; the two outputs are copied from it
#           into public/vendor/sevenzip afterwards
set -eu

WORK=/tmp/sevenzip-build
mkdir -p "$WORK"
cd "$WORK"

# Checked again here, so the build cannot run on sources it was not meant for.
(cd /src/.cache && sha256sum -c /src/sources.sha256)
# Only the tarball that was just checked; the cache may hold other versions.
while read -r _ archive || [ -n "$archive" ]; do
  tar xJf "/src/.cache/$archive"
done < /src/sources.sha256

# The glue is compiled from inside 7-Zip's tree, next to the sample client it
# is modelled on, so that its includes read like 7-Zip's own.
GLUE=CPP/7zip/UI/ComicReader
mkdir -p "$GLUE"
cp /src/glue.cpp "$GLUE/glue.cpp"

# What 7-Zip's own extract-only 7z library (7zxa, Bundles/Format7zExtract)
# is made of: the 7z container, its codecs (LZMA, LZMA2, PPMd, BCJ, BCJ2,
# Delta and the other branch filters, byte swap, Deflate, BZip2,
# Copy) and AES-256. Left out: the four files that export it as a DLL and
# register the format and codecs by name for one (ArchiveExports,
# DllExports2, CodecExports, 7zRegister), since glue.cpp creates the handler
# directly, and Windows/System.cpp, whose one function used here glue.cpp
# replaces. Added: MyWindows.cpp (the Windows types elsewhere)
# and UTFConvert.cpp (names and the password cross as UTF-8).
#
# Then the decryption routines for RAR 3 to 5 and for WinZip AES, with the
# HMAC, PBKDF2 and SHA-1 code they use: for archives the app's other
# decoders can decompress but not decrypt.
#
# No RAR decompression code is compiled (CPP/7zip/Compress/Rar*), which is
# the part under 7-Zip's unRAR licence restriction; the files in
# CPP/7zip/Crypto are not.
SOURCES="
CPP/Common/CRC.cpp CPP/Common/CrcReg.cpp CPP/Common/IntToString.cpp
CPP/Common/MyString.cpp CPP/Common/MyVector.cpp CPP/Common/MyWindows.cpp
CPP/Common/NewHandler.cpp CPP/Common/Sha256Reg.cpp CPP/Common/StringConvert.cpp
CPP/Common/StringToInt.cpp CPP/Common/UTFConvert.cpp CPP/Common/Wildcard.cpp
CPP/Windows/PropVariant.cpp CPP/Windows/Synchronization.cpp
CPP/7zip/Common/CreateCoder.cpp CPP/7zip/Common/CWrappers.cpp CPP/7zip/Common/InBuffer.cpp
CPP/7zip/Common/FilterCoder.cpp CPP/7zip/Common/LimitedStreams.cpp CPP/7zip/Common/MethodId.cpp
CPP/7zip/Common/MethodProps.cpp CPP/7zip/Common/OutBuffer.cpp CPP/7zip/Common/ProgressUtils.cpp
CPP/7zip/Common/PropId.cpp CPP/7zip/Common/StreamBinder.cpp CPP/7zip/Common/StreamObjects.cpp
CPP/7zip/Common/StreamUtils.cpp CPP/7zip/Common/VirtThread.cpp
CPP/7zip/Archive/Common/CoderMixer2.cpp CPP/7zip/Archive/Common/HandlerOut.cpp
CPP/7zip/Archive/Common/ItemNameUtils.cpp CPP/7zip/Archive/Common/OutStreamWithCRC.cpp
CPP/7zip/Archive/Common/ParseProperties.cpp
CPP/7zip/Archive/7z/7zCompressionMode.cpp CPP/7zip/Archive/7z/7zDecode.cpp
CPP/7zip/Archive/7z/7zExtract.cpp CPP/7zip/Archive/7z/7zHandler.cpp
CPP/7zip/Archive/7z/7zHeader.cpp CPP/7zip/Archive/7z/7zIn.cpp
CPP/7zip/Archive/7z/7zProperties.cpp
CPP/7zip/Compress/Bcj2Coder.cpp CPP/7zip/Compress/Bcj2Register.cpp
CPP/7zip/Compress/BcjCoder.cpp CPP/7zip/Compress/BcjRegister.cpp
CPP/7zip/Compress/BitlDecoder.cpp CPP/7zip/Compress/BranchMisc.cpp
CPP/7zip/Compress/BranchRegister.cpp CPP/7zip/Compress/ByteSwap.cpp
CPP/7zip/Compress/BZip2Crc.cpp CPP/7zip/Compress/BZip2Decoder.cpp
CPP/7zip/Compress/BZip2Register.cpp CPP/7zip/Compress/CopyCoder.cpp
CPP/7zip/Compress/CopyRegister.cpp CPP/7zip/Compress/DeflateDecoder.cpp
CPP/7zip/Compress/DeflateRegister.cpp CPP/7zip/Compress/DeltaFilter.cpp
CPP/7zip/Compress/Lzma2Decoder.cpp CPP/7zip/Compress/Lzma2Register.cpp
CPP/7zip/Compress/LzmaDecoder.cpp CPP/7zip/Compress/LzmaRegister.cpp
CPP/7zip/Compress/LzOutWindow.cpp CPP/7zip/Compress/PpmdDecoder.cpp
CPP/7zip/Compress/PpmdRegister.cpp
CPP/7zip/Crypto/7zAes.cpp CPP/7zip/Crypto/7zAesRegister.cpp
CPP/7zip/Crypto/MyAes.cpp CPP/7zip/Crypto/MyAesReg.cpp
CPP/7zip/Crypto/Rar20Crypto.cpp CPP/7zip/Crypto/Rar5Aes.cpp CPP/7zip/Crypto/RarAes.cpp
CPP/7zip/Crypto/WzAes.cpp
CPP/7zip/Crypto/HmacSha1.cpp CPP/7zip/Crypto/HmacSha256.cpp CPP/7zip/Crypto/Pbkdf2HmacSha1.cpp
C/Sha1.c C/Sha1Opt.c
C/7zCrc.c C/7zCrcOpt.c C/7zStream.c C/Aes.c C/AesOpt.c C/Alloc.c C/Bcj2.c C/Bra.c
C/Bra86.c C/BraIA64.c C/CpuArch.c C/Delta.c C/Lzma2Dec.c C/Lzma2DecMt.c C/LzmaDec.c
C/MtDec.c C/Ppmd7.c C/Ppmd7Dec.c C/Sha256.c C/Sha256Opt.c C/SwapBytes.c C/Threads.c
$GLUE/glue.cpp
"

# Z7_EXTRACT_ONLY: no compressors. Z7_ST: single-threaded, as a worker is.
#
# -fwasm-exceptions: 7-Zip reports some failures (out of memory, a truncated
# stream) by throwing, and glue.cpp catches them at the boundary. The native
# WebAssembly kind needs no JavaScript support code.
#
# -sDYNAMIC_EXECUTION=0 keeps eval() and new Function() out of the loader, so
# the module needs 'wasm-unsafe-eval' in the page's CSP and nothing more.
FLAGS="-O2 -DNDEBUG -DZ7_EXTRACT_ONLY -DZ7_ST -D_REENTRANT -D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE -fwasm-exceptions"
OBJ="$WORK/obj"
mkdir -p "$OBJ"
objects=""
for source in $SOURCES; do
  object="$OBJ/$(echo "$source" | tr '/' '_').o"
  case "$source" in
    *.c) emcc $FLAGS -c "$source" -o "$object" ;;
    *) em++ $FLAGS -std=c++17 -c "$source" -o "$object" ;;
  esac
  objects="$objects $object"
done

# shellcheck disable=SC2086  # a list of object files, none with spaces
em++ $FLAGS $objects \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 \
  -sDYNAMIC_EXECUTION=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,stringToNewUTF8 \
  -o /out/sevenzip.mjs

# Neither word appears anywhere in a clean loader, so match them bare: that
# also catches Function(...) without `new` and indirect eval.
if grep -q 'Function\|eval' /out/sevenzip.mjs; then
  echo "the generated loader contains dynamic code evaluation" >&2
  exit 1
fi

VERSION=$(sed -n 's/^#define MY_VERSION_NUMBERS "\([0-9.]*\)".*/\1/p' C/7zVersion.h)
[ -n "$VERSION" ] || { echo "could not read the 7-Zip version from C/7zVersion.h" >&2; exit 1; }
echo "built the 7z reader of 7-Zip $VERSION with $(emcc --version | head -1)"
