# 7-Zip's 7z reader and decryption routines, compiled to WebAssembly

What the reader uses for password-protected comics, and for nothing else:

- **7z** (`.cb7`, `.c7z`). libarchive, which reads every other 7z,
  recognises 7z encryption and stops there; [7-Zip](https://www.7-zip.org/)'s
  own 7z reader decodes it.
- **RAR** (`.cbr`), and **zip with AES** in a compression method zip.js
  lacks. The reader's other decoders decompress these but cannot decrypt
  them. 7-Zip's decryption routines are used to turn such an archive into
  the same archive without the encryption, which those decoders then read.
  Nothing is decompressed in that step.

This directory is everything needed to build the module shipped in
`public/vendor/sevenzip/`. An archive without a password never reaches it.

| Path | What it is |
| --- | --- |
| `sources.txt` | Where the 7-Zip source release is downloaded from: `7z2606-src.tar.xz`, 7-Zip 26.06, from the project's GitHub releases. |
| `sources.sha256` | The SHA-256 the download must have. It is checked before the compiler starts, and again inside the container. |
| `glue.cpp` | The C++ interface exported to JavaScript: open (with a password), count, name, size, whether an entry is encrypted and has a checksum, extract everything through three callbacks, close. The archive is not copied in: 7-Zip reads it through a fourth callback, a part at a time. Plain exported functions, no Embind. Modelled on 7-Zip's own sample client (`CPP/7zip/UI/Client7z`). |
| `build.sh` | The compile command, with the list of every 7-Zip file compiled. Runs inside the Emscripten container. |
| `build-inputs.txt` | The files the output depends on, including the pinned compiler in `scripts/lib/emsdk.sh`. Their hashes make up the build stamp, written to `BUILD-STAMP` (not committed). |
| `.cache/` | The downloaded tarball (not committed). |

No 7-Zip source is kept in this repository, and none is modified: the build
unpacks the release tarball, adds `glue.cpp`, and compiles.

## What is compiled

The files 7-Zip's own extract-only 7z library is made of
(`CPP/7zip/Bundles/Format7zExtract`, which 7-Zip ships as `7zxa.dll`): the 7z
container, the LZMA, LZMA2, PPMd, Deflate, BZip2 and Copy
decoders, the BCJ, BCJ2, Delta, byte-swap and other branch filters (ARM,
ARM64, ARMT, PowerPC, SPARC, IA-64, RISC-V), and AES-256 with SHA-256. Three
differences from that library, all in `build.sh`:

- the four files that export it as a DLL and register the format and codecs
  by name for one (`ArchiveExports`, `DllExports2`, `CodecExports`,
  `7zRegister`) are left out, because `glue.cpp` creates the 7z handler
  directly;
- `Common/MyWindows.cpp` and `Common/UTFConvert.cpp` are added: the Windows
  types on other systems, and the UTF-8 conversion for names and the
  password;
- `Windows/System.cpp` is left out. Its one function used here asks the
  operating system how much memory the machine has; `glue.cpp` answers with
  the most the module's heap can hold (2 GiB).

Added to that, for decrypting RAR and zip AES: `Crypto/Rar20Crypto.cpp`
(RAR 2.x, the cipher from before AES), `Crypto/RarAes.cpp` (RAR 3 and 4),
`Crypto/Rar5Aes.cpp`, `Crypto/WzAes.cpp` (WinZip AES), and what they use
(`HmacSha1`, `HmacSha256`, `Pbkdf2HmacSha1`, `C/Sha1.c`). `glue.cpp`
exposes them as a cipher that is created for one encrypted run of bytes,
started (which is where a password check happens, where the archive has
one) and fed the bytes. A RAR 3/4 archive uses one cipher throughout and
gives it each entry's salt, so that 7-Zip derives the key again only when
the salt changes; the RAR 2.x cipher carries its state on from block to
block, so each entry gets one of its own. For RAR5, `glue.cpp` works out
itself whether the archive's password check value is intact, since 7-Zip
accepts any password without a word when it is not. A WinZip AES password
longer than HMAC's block is handed to 7-Zip as its SHA-1 (which is what the
key derivation makes of it anyway), because 7-Zip stops at 99 bytes.
`cr7_crc` is 7-Zip's CRC-32, for the checksums of stored entries. Walking the containers is this app's own code, in
`public/vendor/sevenzip/decrypt-rar.mjs` and `decrypt-zip.mjs`, over what
they share in `decrypt-common.mjs`.

It is built single-threaded (`Z7_ST`) and without compressors
(`Z7_EXTRACT_ONLY`).

## Licence

7-Zip is licensed under the GNU LGPL, version 2.1 or later, with some files
in the public domain. Its licence notice also covers parts that are **not**
compiled here: the RAR decoders (`CPP/7zip/Compress/Rar*`), which carry the
"unRAR license restriction", and the BSD-licensed LZFSE, Zstandard and
xxHash code. None of those files is in the list in `build.sh`. The RAR
*decryption* files that are in it (`CPP/7zip/Crypto/Rar*`) are not among the
restricted ones: they are plain LGPL. The notice and the LGPL text ship beside the
module (`public/vendor/sevenzip/License.txt`, `copying.txt`, `NOTICE.txt`).

## Building

    sh scripts/build-sevenzip.sh    # from source/web-app-comic-reader

It needs podman or docker, and curl for the first run, which downloads the
tarball. The outputs (`public/vendor/sevenzip/sevenzip.mjs` and
`sevenzip.wasm`) are not committed, so run it once after cloning, and again
after changing `glue.cpp` or `build.sh`: `npm run build` refuses a module
whose stamp no longer matches the tree. The build is reproducible: the script
pins the Emscripten 7.0.0 image by digest, runs it without network access,
and lets it write only to a scratch directory; the two outputs are then
copied into place. It yields the hashes recorded in `../outputs.sha256`,
which `npm run build` checks the built files against. If they change, update
that file, and the copies in `public/vendor/sevenzip/NOTICE.txt` and
`public/THIRD-PARTY-NOTICES.txt`.

## Three things the build guarantees

- **No dynamic code evaluation.** It is compiled with `-sDYNAMIC_EXECUTION=0`
  and without Embind, and `build.sh` fails if the generated loader contains
  the words `eval` or `Function` at all. The module therefore needs
  `'wasm-unsafe-eval'` in the page's CSP, which libarchive already requires,
  and nothing more.
- **Only the 7z reader, and decryption.** No reader for zip, RAR, tar or any
  other format of 7-Zip's, and no RAR decompression.
- **Failures stay inside.** 7-Zip reports some failures by throwing. The
  module is built with WebAssembly exception handling (`-fwasm-exceptions`)
  and `glue.cpp` catches everything at its boundary, so a bad archive ends as
  an error value, not as an aborted module. (The other direction is the
  extraction loop's job: its callbacks run inside 7-Zip and must not throw,
  so each catches and the error is raised once 7-Zip has returned.) This is why a password-protected
  7z needs Chrome 95, Firefox 114 or Safari 15.2 or later (Firefox 100 has
  the exception handling; the module worker the decoder runs in needs 114).

## Updating 7-Zip

Change the address in `sources.txt` and the hash in `sources.sha256` to the
new release, check that the file list in `build.sh` still matches
`CPP/7zip/Bundles/Format7zExtract/makefile` in it, rebuild, run
`npm run test:unit` and `npm run verify:formats`, and record the new output
hashes as described above, along with the version in the two notices.

## How it is used

`public/vendor/sevenzip/sevenzip-extract.mjs` is the extraction loop: one
pass over every entry, with the same limits as the unarr loop, reading the
archive from a source (a Blob in the worker, bytes in the tests) as 7-Zip
asks for it. The worker
beside it (`sevenzip-worker.mjs`) runs it, and so do
`tests/unit/sevenZipExtract.spec.ts` and `scripts/verify-formats.mjs`, so
what the tests exercise under Node is the file the browser runs.
`src/archive/sevenZipAdapter.ts` starts the worker.
