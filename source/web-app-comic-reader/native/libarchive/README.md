# libarchive, compiled to WebAssembly

The decoder behind CBR, CB7 and C7Z, and the fallback for zip methods zip.js
lacks. This directory is the recipe for the module the app ships as
`vendor/libarchive/libarchive.wasm`.

## Why it is built here

The app uses [libarchive.js](https://github.com/nika-begiashvili/libarchivejs),
which distributes a prebuilt module inside its npm package. That module links
OpenSSL 1.0.2, whose licence does not combine with the AGPL, and which has
been unsupported since 2019. So the prebuilt module is not used. libarchive is
built here instead, without any cryptography library, and libarchive.js's own
worker sources are bundled around the result.

Leaving the cryptography out costs nothing the reader used: libarchive is
never asked to decrypt. A password-protected zip is decrypted by zip.js and a
password-protected 7z by 7-Zip's reader (`../sevenzip/`); a password-protected
RAR is refused.

## What is in here

| Path | What it is |
| --- | --- |
| `sources.txt` | Where the four release tarballs come from: libarchive 3.8.11, zlib 1.4, XZ Utils 5.8.4 (for liblzma) and bzip2 1.0.8. |
| `sources.sha256` | The SHA-256 each download must have. Anything else is refused. |
| `libarchivejs/main.c`, `lib.exports` | libarchive.js 2.0.2's C wrapper and its list of exported functions (MIT; see `libarchivejs/LICENSE`). This is the interface its worker calls. `lib.exports` is unchanged; `main.c` has seven changes, each marked `Comic Reader:` in the file and listed below. |
| `patches/` | This app's changes to libarchive's own sources, applied to the unpacked tarball before it is compiled. One so far; see below. |
| `build.sh` | The compile commands. Runs inside the Emscripten container, without network access. |
| `build-inputs.txt` | The files the output depends on, including the pinned compiler in `scripts/lib/emsdk.sh`. Their hashes make up the build stamp. |
| `.cache/`, `out/`, `BUILD-STAMP` | Downloads, build output, and the stamp of the inputs it was built from. Not committed. |

## Building

    sh scripts/build-libarchive.sh    # from source/web-app-comic-reader

It needs podman or docker, and curl for the first run's downloads. It takes a
few minutes and writes `out/libarchive.js` (the loader Emscripten generates)
and `out/libarchive.wasm`, with a stamp recording what they were built from.
Only the four tarballs named in `sources.sha256` are unpacked, whatever else
is in `.cache/`. A second run does nothing unless one of the files in
`build-inputs.txt` has changed (`FORCE=1` rebuilds regardless), and
`npm run build` refuses to use an output whose stamp no longer matches the
tree. `npm run build` then runs
`scripts/prepare-decoders.mjs`, which bundles libarchive.js's worker
around that loader and puts `worker-bundle.js` and `libarchive.wasm` in
`public/vendor/libarchive/`. The loader and the module are generated as a
pair and only work together, which is why the worker is bundled here and not
taken prebuilt.

The build is reproducible. With the pinned Emscripten 7.0.0 image it yields
the two hashes recorded in `../outputs.sha256`:

    f20280b2f702f4774587fd88a78a0d3391f8c7d0c23d94d0ef34d3d25a98803e  libarchive.wasm
    3359f61f172fd5706105e0431732ea9d186315e31dd2ec3d3eb2fcc61e49d663  libarchive.js

`npm run build` compares the built files with that list and stops if they
differ. If you change anything that changes them, update `../outputs.sha256`,
the lines above and the hash in `public/THIRD-PARTY-NOTICES.txt`. Built with
another compiler (`EMSDK_IMAGE`) they will differ too; `DECODERS_UNVERIFIED=1`
lets such a build through with a warning.

## Changes to libarchive

`patches/stored-entry-checksums.patch`, two changes, each marked
`Comic Reader:` in the source it adds to.

libarchive 3.8.11 does not compare the checksum of a RAR entry that is
stored (not compressed). In the RAR reader, a read at the end of an entry
is answered "end of entry" before `read_data_stored` is asked, and that
function is where a stored entry's checksum is compared. In the RAR5
reader, the comparison is made for data that went through the unpacker, and
stored data does not. Either way a damaged stored page was returned as if
it were sound, and comics are very often stored. With the patch a stored
entry's checksum is compared when a read reaches its end, as a compressed
entry's is. (It does not hold after a seek within an entry, which this app
never does.) A candidate for reporting upstream.

## Changes to libarchive.js's `main.c`

- **Only the comic containers.** `archive_open` enables the RAR, RAR5, 7z
  and zip readers. Upstream enables every format and filter libarchive has,
  and libarchive picks one by looking at the file, so a `.cbr` could be a tar
  or an ISO image and be parsed as one.
- **One reader at a time.** libarchive.js's worker calls `archive_open` for
  every listing and every file read and frees only the last reader, so
  memory grew with each page turned. `archive_open` now frees the reader it
  returned before, and `archive_close` frees only that current one. This relies
  on the worker being done with a reader before it opens the next, which
  holds: each of its calls opens one and walks it within a single function.
- **A checked, zeroed allocation.** `get_filedata` returns an error when its
  allocation fails, where it used to read the entry to address 0, and the
  buffer is zeroed, so a read shorter than the declared size does not return
  old heap contents.
- **No leak on a failed read.** `get_filedata` frees its buffer when the
  read fails; it used to leave it allocated, up to the entry's declared size
  each time.
- **Checksums compared.** libarchive compares an entry's checksum at or
  after its last data: for RAR, on the read that finds nothing left.
  `get_filedata` asked for exactly the declared size and stopped, so that
  read never happened, and a damaged entry of a RAR came back as if it
  were sound. It now reads on to the end, and fails if libarchive then
  reports the entry bad. (For stored entries libarchive itself needed the
  change above as well.) An entry that declares no data is not read on:
  that includes directories, which the RAR5 reader refuses to read.
- **Zip checksums off, on request.** A locale ending in `@zip-unchecked`
  makes `archive_open` set libarchive's `zip:ignorecrc32` option (the locale
  is the one option the worker's API passes through). The app asks for it
  for a zip whose AES entries it has decrypted itself: the second version
  of that scheme stores no checksum, relying on an authentication code that
  the app has checked by then.
- **No use of a freed reader.** `archive_close` no longer asks a reader it
  has just freed for its error string.

## Three choices worth knowing about

- **No dynamic code evaluation.** Linked with `-sDYNAMIC_EXECUTION=0`, and
  the build fails if the loader contains the words `eval` or `Function`. The
  module needs `'wasm-unsafe-eval'` in the page's CSP and nothing more.
- **No OpenSSL.** The build fails if the string turns up in the module.
- **`-sWASM_BIGINT=0`.** libarchive.js's worker was written against an older
  Emscripten and does plain-number arithmetic on entry sizes. Without this
  flag current Emscripten hands it BigInts and every read throws. With it,
  only the low 32 bits of a size arrive, signed: an entry of 2 to 4 GiB
  shows up with a negative size (and a larger one wraps around, and is then read by the wrapped size). The
  app lists an entry with a negative size as unreadable and never asks the
  decoder for it.

## Updating a library

Change the URL in `sources.txt`, download the file, check it against what the
project publishes, put its hash in `sources.sha256`, rebuild, and run
`npm run verify:libarchive` and `npm run verify:formats`, which both drive
this build. Then update `../outputs.sha256`, and the versions and hashes in
`public/THIRD-PARTY-NOTICES.txt`. The previous tarball can stay in `.cache/`
or be deleted; it is not used.
