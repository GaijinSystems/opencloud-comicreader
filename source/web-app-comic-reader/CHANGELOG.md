# Changelog

## 1.2.4 — 2026-11-22

Release files for OpenCloud's app store, and new screenshots. The reader
itself is unchanged from 1.2.3.

### Changed
- **Each release has a zip as well as a tarball, both named
  `opencloud-comicreader-<version>`.** OpenCloud's app store downloads apps as
  `.zip` files, so a release now has `opencloud-comicreader-<version>.zip` and
  `opencloud-comicreader-<version>.tar.gz`, each with its SHA-256. Both hold
  the same `comic-reader` folder. Up to 1.2.3 there was one file,
  `comic-reader-<version>.tar.gz`. `scripts/package.sh` makes both, and the
  same build always gives the same bytes.
- **New screenshots,** at 3:2 (the shape the app store uses), in OpenCloud's
  light and dark themes. The README shows the ones that match your GitHub
  theme.

### Fixed
- **The repository held four compiled Python files** (`scripts/__pycache__/`),
  left by the fixture scripts and committed by mistake, although the
  documentation says main has no compiled binaries. They are gone, and
  `__pycache__/` is ignored.
- **Out-of-date statements in the documentation,** among them: browser testing
  of 1.2.2 that was listed as not done; "CBZ works without WebAssembly", which
  is not so for a CBZ whose pages are in bzip2, LZMA or PPMd; installing
  described only as building, although releases have the app ready to install;
  `verify:formats` described as reading `testfiles/formats/` without being told
  to; and 7-Zip's 7z reader missing where the decoders are listed.

## 1.2.3 — 2026-11-17

The project is now called OpenCloud Comic Reader. The reader itself is
unchanged from 1.2.2.

### Changed
- **The name.** The documentation, `INSTALL.txt`, the licence notices and the
  source comments say "OpenCloud Comic Reader". Inside OpenCloud, where the
  context is clear, the app is still listed as "Comic Reader", and its menu
  entry still reads "Open in Comic Reader".
- The decoders load under a new cache key, because files in `vendor/` changed
  (their notices and comments), so a browser fetches them once more after the
  update.

### Fixed
- Two 7-Zip licence texts in `vendor/sevenzip/` were marked executable. The
  package now gives every file the same modes, whatever the source has, and so
  does the demo site's build.
- `docs/solid-rar.md` in the source package still said password-protected RAR
  archives were not supported.

### Not noted for 1.2.2
- **Its release was the first built by the repository's workflow.** Each
  release since has the app ready to install, `comic-reader-<version>.tar.gz`,
  with its SHA-256, built from the tagged source; `scripts/package.sh` makes
  the package the same way, byte for byte, and `scripts/release-notes.sh`
  checks that the version agrees everywhere before a release.
- Two tests that try hundreds of wrong passwords, which timed out on slower
  machines, got a time limit of their own then.

## 1.2.2 — 2026-11-13

Password-protected comics in every format, two fixes found by installing
1.2.1 over 1.2.0, and one older one.

### Password-protected comics

The reader now opens password-protected comics: CBZ, CB7/C7Z and CBR.

#### Added
- **A password prompt.** A protected comic opens to a password field in
  place of the pages. With the right password the comic opens as usual; with
  a wrong one the field comes back with a message. The archive is not
  downloaded again between attempts.
- **CBZ: ZipCrypto and AES.** zip.js decrypts each page as it is read, so a
  large protected CBZ still streams by range request. The password is checked
  before anything is shown: against up to three entries' check values, and
  where those are too few to be sure, by decoding one entry.
- **CBZ in bzip2, LZMA or PPMd.** These go to libarchive, as they do
  without a password. libarchive undoes the old zip encryption (ZipCrypto)
  itself. It cannot undo AES, so AES entries are decrypted first, each one's
  authentication code checked, and libarchive is given the zip without them
  encrypted.
- **CB7/C7Z, with file names readable or encrypted.** libarchive recognises
  7z encryption and stops there, so these go to a third decoder: 7-Zip's own
  7z reader (7-Zip 26.06, LGPL-2.1-or-later), compiled to WebAssembly. It
  runs in its own worker, reads the archive in one pass under the same
  limits and time limits as the solid-RAR decoder, and reads the archive
  from the downloaded file a part at a time, so the archive is not held a
  second time in the decoder's memory.
- **CBR: RAR4 and RAR5, with file names readable or encrypted, solid or
  not.** Neither RAR decoder decrypts. The archive is decrypted first, with
  7-Zip's decryption routines (in the same module as its 7z reader), and
  written out as the same archive without encryption; libarchive or unarr
  then reads it like any other. RAR5 records a check value, so a wrong
  password is refused at once. RAR4 records none, unless its headers are
  encrypted or an entry is stored: the pages are then read, and a password
  under which none of them decodes is reported wrong. The cipher RAR used
  before AES (RAR 2.x, 1996 to 2002) is decrypted too.
- **The password stays in the tab.** It is not sent to the server, not saved
  by the reader and not kept with the reading position; it is asked for
  each time the comic is opened.

#### Changed
- A 7z archive in which only some entries are encrypted is treated as
  encrypted: the reader asks for the password and does not show the part it
  could read without it.
- The letters that are keyboard shortcuts (`f`, `d`, `r`, `t`, `v`), the
  arrow keys and Space are left alone while a text field has the focus,
  which until now the reader did not have.
- The downloaded archive is let go once a page has been read without a
  password being asked for (or at once, for a RAR or 7z opened with its
  password), so that it does not sit in memory beside the decoded pages.

#### Not supported
- RAR encryption from before RAR 2.0 (archives from before 1996; 7-Zip has
  no implementation of it), and archives split into volumes (the reader
  opens one file). Each is refused with a message that says so.
- A protected CB7 or CBR, and an AES zip in bzip2, LZMA or PPMd, need
  Chrome 95, Firefox 114 or Safari 15.2 or later: the module that reads or
  decrypts them uses WebAssembly exception handling, in a module worker.

#### Limits
- 7z and RAR4 have no way to check a password except by using it, so a
  wrong password and an archive damaged throughout cannot be told apart.
  Both get the wrong-password message, which says so. Damage in part is
  told apart, however much of it there is: as long as one block, entry or
  page still decodes, the password is known to be right and the rest show
  as unreadable pages, in every format. The price is that for 7z, and for
  a RAR4 that gives nothing to check a password by, a wrong guess takes a
  pass over the archive, as opening with the right password does.
- A RAR4 with encrypted file names whose first encrypted header is damaged
  cannot be told from one opened with a wrong password: nothing after that
  header can be found without it.
- RAR 2.x encryption takes the password as bytes in a DOS code page the
  archive does not name. The reader sends UTF-8: right for a password in
  ASCII, a guess for any other. Only stored entries have been tested (no
  current archiver writes this encryption; the test archive is written by
  `scripts/rar_writer.py` and checked against RARLAB's unrar).
- A 7z built without checksums (7-Zip never writes one) gives the decoder
  nothing to check by. The pages that came out are then looked at, and
  unless at least half of them begin like images the password is reported
  wrong. A comic of that kind whose pages are mostly not images is
  therefore refused even with the right password.
- A 7z password longer than 1,024 characters is answered as wrong without
  being tried.
- Zip's own password check is short, so where too few entries accept the
  password to be sure, one is decoded at open and its checksum compared. A
  wrong password therefore does not get past the prompt, and one damaged
  entry among good ones does not keep the right one out. (A comic whose
  only page is damaged cannot be told from one opened with a wrong
  password.) Only when nothing can be checked or decoded at open (every
  entry over the size limit, say) is it left to the first page read, which
  then sends the reader back to the prompt.
- A zip whose AES entries were decrypted for libarchive is read without
  comparing checksums where it has entries in the second version of zip's
  AES scheme: that version stores none, relying on the authentication
  code, which has been checked by then.
- An AES entry of such a zip that does not decrypt while others do
  (damaged, or under a password of its own) shows as an unreadable page.
  The password is called wrong when no entry has decrypted and a thousand
  have refused it outright, or all of them in a smaller archive.
- A RAR in which only some pages are encrypted, and which gives nothing to
  check a password by, is judged by the encrypted entries alone. That
  needs the decoder's list of files to match the archive's; where it does
  not (more files than the reader lists, or links among them), every entry
  is judged, and one that never was encrypted then lets any password in,
  to a comic whose encrypted pages cannot be read.
- Decrypting a RAR, or the AES entries of a zip, writes the archive a
  second time (a Blob, which the browser may keep on disk). Both exist
  while the comic is being opened; the downloaded original is let go once
  it is.
- A solid RAR4 that was decrypted relies on unarr having read the marker
  that ends each entry by the time the entry is complete. It has, except
  for an entry whose last byte falls exactly where one of the decoder's
  working windows ends; the entries after such a one fail their checksums.
- A signed download link can expire while the prompt is up. The attempt then
  fails as a network error; "Try again" fetches a fresh link and asks for the
  password again.

#### Build
- **A third decoder to build:** `npm run build:native` now also runs
  `scripts/build-sevenzip.sh`, which downloads the 7-Zip 26.06 source
  release, checks it against a recorded SHA-256, and compiles the 7z reader
  and the decryption routines in the same pinned Emscripten container,
  without network access. No 7-Zip source is kept in the repository and none
  is modified. The build is reproducible; its two outputs are in
  `native/outputs.sha256` and under the same build-stamp check as the other
  decoders. The download-and-check step is now one function shared with the
  libarchive build (`scripts/lib/fetch-sources.sh`).
- Only 7-Zip's extract-only 7z library and its decryption code for RAR and
  zip AES are compiled: no RAR decompression code (which is what carries
  7-Zip's unRAR licence restriction), no compressors.
- **The other two decoders change with it, so all three are rebuilt.**
  unarr's glue (`native/unarr/glue.c`, this app's own) gains a function for
  solid archives that were decrypted; unarr's sources are untouched. The
  libarchive.js C wrapper gains a sixth marked change: an option, passed
  through the locale, not to compare zip checksums, for a zip the app has
  decrypted; and a seventh, below.
- `prune-dist` requires the new files in a release build and checks them for
  static imports, like the unarr ones.
- `npm run check:types` now checks the props templates give to OpenCloud's
  own components (`oc-button` and the rest), using the design system's type
  declarations, for which it is now a direct dev dependency. A wrong value
  used to pass unnoticed.
- The Node image in the README's build commands is named by digest.

#### Notices
- `THIRD-PARTY-NOTICES.txt` now has a section for the Emscripten runtime
  that is linked into all three WebAssembly modules (Emscripten itself,
  musl, the LLVM runtime libraries, dlmalloc), with the licence texts in
  `licences/`. It was missing for the two existing modules as well.

#### Tests
- 526 unit tests. New: the real 7-Zip module over
  password-protected 7z fixtures (right, wrong and missing password, limits,
  a partly encrypted archive, archives without checksums); the real
  decryption of eight password-protected RAR fixtures, read back with the
  real unarr module, and of AES zips, read back with zip.js; real AES and
  ZipCrypto zips through `openComic`; which decoder each protected format
  is sent to; the composable's unlock path; the prompt component; and the
  prompt end to end, with OpenCloud's real button component inside it,
  typed into and clicked, opening real zips through the real composable and
  real protected 7z and RAR archives through the real worker scripts and
  modules (in Node worker threads); `App.vue`'s wiring of the prompt, the
  keyboard and the focus; and the libarchive adapter's recovery after a
  failed one-pass unpack.
- Two test comics added to `testfiles/formats/`, both password protected
  with bzip2 pages: `zip-encrypted-zipcrypto-bzip2.cbz` and
  `zip-encrypted-aes256-bzip2.cbz`; and one in RAR 2.x encryption,
  `rar2-encrypted.cbr`. That makes twelve protected files of 29.
- `verify:formats` now requires all twelve, in every format, to decode in
  full with their password and to be refused with a wrong one, each through
  what the reader uses for it.
- The packaged 7-Zip worker was run in headless Chromium under a strict
  content security policy against both protected 7z test files: no password,
  the right one and a wrong one each gave the expected answer.

Checked in a real browser, on an earlier build of this version: the prompt
(by button and by Enter) opening the protected CBZ and CB7 test files. Not
checked there by anyone yet: protected CBR, and AES zips with bzip2 pages.

### Fixes

#### Fixed
- **A damaged page in a RAR could be shown as if it were sound.** The
  libarchive decoder did not compare the checksum of a RAR4 page, or of a
  stored RAR5 page, and handed a damaged one to the browser as it was, to
  show as a broken or garbled image. Two causes. libarchive compares a
  checksum on the read that reaches the end of an entry, and
  libarchive.js's C wrapper stopped one read short of it; the wrapper now
  reads to the end (its seventh marked change). And libarchive 3.8.11
  itself never compares the checksum of a stored RAR entry; it is now
  built with a two-line change to each of its RAR readers
  (`native/libarchive/patches/`). Such a page now shows as unreadable.
- **A one-pass unpack that failed left the pages not yet read unreadable.**
  A solid 7z or RAR5 is unpacked in one pass once it is seen to be slow page
  by page; if that pass failed (a damaged archive, memory), the decoder was
  dropped and every page it had not yet produced showed as unavailable. A
  fresh decoder is now started on the same archive, and the pages go on
  being read one at a time as before the pass.
- **An `assetBaseUrl` with a query string lost both the query and its last
  path segment** (`/apps/comic-reader?token=1` resolved decoders under
  `/apps/`). The path and the query are now kept, the query exactly as
  written. A value that cannot be a location (no `http(s)` scheme after
  resolving, or only a query or fragment) is ignored with a warning instead
  of breaking every decoder load.
- **After an upgrade, a browser could go on using the previous version's
  decoders, and a solid RAR4 then failed with "Solid RAR archive … cannot
  read these".** The decoder files in `vendor/` keep the same names from one
  build to the next, so a cached `unarr-worker.mjs` from 1.2.0 was paired
  with the 1.2.1 app; the two speak different protocols, the old worker
  answered "not supported", and the reader fell back to libarchive, which
  cannot read solid RAR4. The libarchive worker and its `.wasm` could be
  mismatched the same way. Every decoder URL now carries `?v=` and a hash of
  all the decoder files, and each worker passes it on to the modules and
  `.wasm` it loads, so a new build never reuses decoder files cached from
  another one.

#### Build
- `vite.config.ts` computes the hash of the decoder files that goes into
  `?v=`, and `prune-dist` fails a release build in which a decoder's worker
  would load something without it.

## 1.2.1 — 2026-11-13

Everything since 1.2.0, in the order it was done, newest first: fixes from the
final reviews; encrypted archives and a machine-run layout harness; both
decoders built from source, with no OpenSSL and no binaries in the
repository; and lower memory use, a retry for pages that fail to load, and
tighter limits.

### Fixes from the final reviews

Fixes from a review of everything written since the last one: the libarchive
build, the encrypted-archive handling, the layout harness and the tooling.

#### Fixed
- **An entry declaring 2 GiB or more (any size whose low 32 bits read as
  negative) made the libarchive decoder write at address zero of its own
  memory.** The module hands sizes to JavaScript
  as signed 32-bit numbers, so such a size arrived negative, slipped under
  the page-size limit, and the C wrapper then read the entry into a failed
  allocation. It stayed inside the decoder's WebAssembly sandbox. Such an
  entry is now listed as unreadable and not requested; a page declaring more
  than the page limit is refused before the decoder is asked for it; an
  archive holding either is read a page at a time, never unpacked in one
  pass; and the wrapper checks its allocation.
- **An entry name could write into `Object.prototype` for the whole OpenCloud
  page.** libarchive.js folds an archive's listing into an object keyed by
  path segment, so an entry under a directory called `__proto__` landed on
  the prototype every object shares, until the page was reloaded. The same
  folding merged entries that shared a name, which hid the one the decoder
  would actually read (and its size) behind the last. The reader now takes
  the flat listing straight from libarchive.js's worker and never builds
  that object. Of entries sharing a name only the first can be read, since
  that is the one the decoder returns; the rest show as unreadable pages.
  The same goes for a page whose path is first used by an entry that is not
  a regular file (a socket, a device), which the decoder would have read in
  its place, by its own declared size; and an archive in which such entries
  declare data is never unpacked in one pass.
- An entry named like `page.constructor` or `page.__proto__` was taken for an
  image, because the extension lookup answered with what every object
  inherits.
- **The libarchive decoder leaked memory on every page read.** libarchive.js's
  worker opens a new reader for each listing and each read and frees only the
  last, so a long session in a large RAR or 7z comic grew the worker's memory
  until reads failed. The C wrapper now frees the previous reader when the
  next is opened, and frees an entry's buffer when reading it fails, which
  leaked up to a page's size each time. That buffer is now zeroed first, so
  a read that comes up short cannot return what the worker's heap held.
- **libarchive would read any format it knows,** so a `.cbr`, a `.cb7`, or a
  zip handed over from zip.js could be a disguised tar, cpio or ISO image and
  be parsed as one. The module is now built with its RAR, 7z and zip readers
  only. A `.cbr` or `.cb7` whose first bytes are none of those is refused up
  front; a `.cbz` is still found from its end, as zips are.
- **The entry-count limit was not applied to archives read by libarchive.**
- **A RAR4 encrypted only after its first entry opened as a book of
  unreadable pages.** Any password-protected entry in the headers now gives
  the password-protected screen, as for every other format.
- **A sideways page in fit-width or fit-height lost a scrollbar's width** on
  systems with classic scrollbars: it was sized to the viewport's outer box.
  It is now sized to the space inside the scrollbar, which is reserved while
  the page is sideways so the measurement cannot chase its own result.
- Cancelling while a zip was being fetched for libarchive no longer carries on
  opening it with zip.js, and the progress label returns to "parsing" once
  that download is over.

The 2 GiB, memory and format fixes change libarchive.js's C wrapper
(`main.c`, each change marked), so `libarchive.wasm` has a new hash.

#### Build
- **A leftover tarball could be compiled in place of the pinned one.** The
  libarchive build unpacked everything in its download cache; after a version
  bump the previous release was still there and could be the one built. Only
  the four tarballs named in `sources.sha256` are unpacked now.
- **`npm run build` checks the decoders against recorded hashes.**
  `native/outputs.sha256` lists what the two reproducible builds produce, and
  a module that differs is refused (`DECODERS_UNVERIFIED=1` for a build made
  with another compiler). Before, the hashes were only documented.
- **unarr has a build stamp too,** so editing `glue.c` or the vendored sources
  without rebuilding is caught, and its build checks `upstream/` against
  `upstream.sha256`. Stamps now live in `native/<name>/BUILD-STAMP` and are
  removed before a build and written after it.
- **The loader swap is asserted.** With a symlinked `node_modules` (pnpm, a
  linked workspace) the package's own loader was bundled around our module
  and the build said nothing; the result could not start. The build now fails
  if the swap did not happen, and checks the bundled worker for `eval` and
  `new Function`.
- The package's prebuilt worker is dropped by a Vite plugin, so `build:w`
  no longer leaves it in `dist/`; the release build fails if it is there.
- `libarchive.js` is pinned to exactly 2.0.2. Downloads are HTTPS only, also
  across redirects. A checkout path with a space in it no longer breaks the
  libarchive build. `verify:libarchive` and `verify:formats` fail when they
  find nothing to check, and `verify:libarchive` now checks the worker calls
  the adapter uses, against an archive with duplicate names and a
  `__proto__` directory.

#### Tests
- The layout harness now checks the page's size in every fit mode; before,
  only fit-page had a size check, and a wrong size in the other three passed
  all 576 cases.
- New unit tests for the libarchive adapter's handling of names, sizes,
  entry counts and the one-pass unpack, for format detection, and for the zip handover's size limit,
  headers, cancellation and progress.

### Encrypted archives and the layout harness

Closing gaps left by the step below: encrypted archives were untested, the layout
harness was out of date and had never been run by a machine, and the fixture
scripts had been edited but not executed.

#### Fixed
- **An encrypted 7z with readable file names opened as a book of unreadable
  pages,** each with a "Try again" that could never work. libarchive's check
  at open only looks at the first header, and for such an archive it says
  "not encrypted"; the archive then lists normally and every read is refused.
  The reader now recognises that refusal, on the first read, and shows the
  password-protected screen. If the archive has a `ComicInfo.xml` that happens
  while opening; otherwise on the first page. Found by building encrypted test
  files; it predates the libarchive rebuild.

#### Added
- **Nine password-protected test archives** in `testfiles/formats/` (password
  `comic`): two zip, two 7z, two RAR5 and three RAR4, including
  header-encrypted and solid variants. `make-format-matrix.py` generates them
  and `verify:formats` checks that each would be reported as password
  protected, by whichever route the reader learns it. Eight already were; the
  ninth is the fix above.
- **`scripts/check-harness.sh`** runs the layout harness in a headless
  Chromium over every fit mode, rotation, page layout, scroll position and
  three window sizes: 576 cases.

#### Changed
- **The layout harness is rebuilt** (`docs/fit-rotation-harness.html`, now
  with the source). It loads nothing from the network; the previous one pulled
  Tailwind from a CDN for its own controls. It now also lays out the page-turn
  zones and the unreadable-page placeholder with its retry button, and checks
  them: zones over the visible area wherever the page is scrolled, zones
  adding no scroll of their own, a click at either edge landing on a zone, the
  retry button not covered by one. Every control is also a URL parameter and
  the outcome is written out as JSON, so it can be run unattended.
- `tests/unit/harness.spec.ts` compares the harness's copies of the
  component's styles with the component, so the two cannot drift unnoticed.

#### Verified in a browser, by machine
The harness passes all 576 cases in headless Chromium. To check the checks,
the two layout bugs fixed earlier were put back in scratch copies, and the
harness caught both: click zones that ignore the scroll position fail "zones
in view" and "edges turn pages" on any scrolled page (the 1.2.0 fix), and a
retry button without its `z-index` fails "retry clickable" in a two-page
spread (a fix listed under "Memory, retry and limits"). This is the layout code in a real browser engine; it
is not the app running inside OpenCloud, which still needs testing by hand.

#### Corrected
- The README said the test fixtures are generated and not committed. They are
  committed, and the four in `tests/fixtures/rar/` cannot be regenerated
  without the proprietary `rar` tool.

#### Tests
239 unit tests (was 217). All three fixture scripts (`make-fixtures.py`,
`make-test-comics.py`, `make-format-matrix.py`) were run end to end in a
container for the first time since they were last edited.


### Decoders built from source

No binaries in the repository, and no OpenSSL in the app. The reader's own
code is unchanged by this step; what changed is where the libarchive decoder
comes from.

#### Changed
- **libarchive is built from source, without OpenSSL.** The app used the
  WebAssembly module prebuilt inside the libarchive.js npm package. Reading
  that package's build recipe showed the module statically links OpenSSL
  1.0.2s alongside libarchive 3.7.2, zlib, liblzma and bzip2. OpenSSL 1.0.2's
  licence has advertising clauses that do not combine with the AGPL, and the
  library has been unsupported since 2019.

  `native/libarchive/` now holds a recipe that builds libarchive 3.8.11 with
  zlib 1.4, liblzma 5.8.4 and bzip2 1.0.8, and no cryptography library, in an
  Emscripten container without network access. The four release tarballs are
  downloaded once and must match recorded SHA-256 hashes. libarchive.js's
  worker is then bundled, from the sources in its npm package and unchanged,
  around the result. The build is reproducible and fails if OpenSSL, `eval`
  or `Function` turns up in its output.

  Nothing the reader used is lost: it refused encrypted archives already.
- **No compiled files are committed.** Both decoders (unarr and libarchive)
  are built by `npm run build:native`; the generated loaders and `.wasm` files
  are ignored. The verification scripts now drive this app's own libarchive
  build, where before they drove the one inside the npm package.
- **There are no prebuilt downloads.** The README's quick start builds the app
  from source, in containers, with nothing else installed.

#### Fixed
- **Third-party notices were incomplete.** They listed libarchive.js and
  libarchive but not zlib, bzip2 or liblzma, which are inside the same module,
  nor Comlink, which libarchive.js brings with it. All are now listed with
  version, source location, hash and licence text.

#### Compatibility note
libarchive.js's worker does plain-number arithmetic on entry sizes. Built with
a current Emscripten, libarchive hands it BigInts for those and every read
throws, so the module is linked with `-sWASM_BIGINT=0`. Entry sizes are good
to 4 GiB, as they were in the package's own build.

#### Not yet verified in a browser
`verify:libarchive` and `verify:formats` pass against the new module under
Node: every assumption the adapter makes holds, and all 17 archives in the
compression matrix decode. The browser worker is bundled from the same
sources as the Node one, and has not itself been run in a browser. Neither
has anything listed under "Memory, retry and limits".

#### Tests
217 unit tests, unchanged. The unarr tests now say so plainly, rather than
failing on a missing file, when the module has not been built.


### Memory, retry and limits

Lower memory use, a retry for pages that fail to load, and the results of
putting the unarr integration from 1.2.0 through the same reviews as the rest
of the source: a simplification pass, a bug review and a security review, with
a second review round on the fixes.

#### Changed
- **Archives and pages are Blobs from download to display.** Before, a file
  that had to be downloaded whole was collected as chunks, merged into one
  array, and copied again when handed to a decoder, so a 400 MB CBR was held
  two or three times over on the page while it opened. Now the download is
  folded into a Blob every 8 MB as it arrives, decoders receive that Blob by
  reference, and pages come back as Blobs that the cache types with `slice()`
  without copying.

  What this does not remove is the working copy each decoder makes inside its
  own worker. For a CBZ the saving is complete; for a CBR or CB7 the page-side
  copies are gone and the decoder's remains.
- **A solid RAR4 goes straight to unarr.** In 1.2.0 it was opened in
  libarchive first, found short, and then opened again in unarr, with both
  decoders holding the archive at once. The container's headers already say
  whether it is solid, so they are read first.
- **The RAR4 header check no longer reads the whole file.** It needs a few
  dozen bytes at the start of each block. It now reads the Blob through a
  64 KB window; before, it loaded the entire archive to do that.
- The unarr worker receives the archive as a Blob and copies it into its heap
  a slice at a time, so the archive is held there once, not twice.

#### Added
- **"Try again" on a page that could not be read.** A page that failed, for
  example on a dropped connection during a range read, used to stay failed
  until the comic was reopened. The button is shown only where a second
  attempt can help: not on a page over the size limit, and not on one the
  decoder holds no data for.
- `SECURITY.md` and `CONTRIBUTING.md` at the top of the bundle.

#### Fixed
- **A password-protected RAR4 was not reported as such.** unarr cannot
  decrypt, and listed the entries of an encrypted archive and returned them
  all unreadable, which hid libarchive's "password protected" error. Such an
  archive is now recognised from its headers and left to libarchive. This was
  a regression in 1.2.0.
- **One damaged page in a non-solid RAR4 cost every page after it** when the
  archive was read by unarr. Only a solid archive needs that; in a non-solid
  one each page stands alone.
- A solid RAR4 that unarr could not finish listing opened as a shorter comic
  with nothing said. The banner now reports how many entries were not reached.
- "Try again" was partly covered by the page-turn zones in a two-page spread.

#### Security
- **The unarr worker has an overall time limit,** 60 seconds plus a second per
  megabyte of archive, on top of the 30-second inactivity timeout. An archive
  controls how fast it decodes, so one built to decode very slowly could keep
  a worker busy for hours while never going silent.
- **Pages kept from a solid RAR4 are capped** at the ceiling libarchive's
  one-pass unpack already worked under (never below the archive's own size).
  Before, the only bound was four times the archive, which at the default
  1 GiB download limit is 4 GiB held for as long as the comic is open.
- libarchive's one-pass unpack is refused when any page declares no size, and
  what it returns is held to the same total by its real size.
- The RAR4 header walk skips a file block's data whatever its flags say, as
  the decoders do, so a crafted header cannot make it disagree with them.
- The extraction loop checks its scratch allocation, refuses archives of 2 GiB
  or more (the module's address space), and caps the length of an entry name.
- unarr's warnings are capped at 20 per archive. It prints one per malformed
  header, and a hostile file can contain millions.
- **The unarr build is pinned and isolated.** The Emscripten image is pinned
  by digest, the container writes only to a scratch directory, and
  `native/unarr/upstream.sha256` records a hash of every vendored source file.
  The notices now describe the snapshot accurately: unarr 1.2.0 plus the
  development commits after it, up to the recorded commit.
- The decoder was fuzzed with 123,000 mutated RAR4 archives: no hang, no
  crash, and every limit held.

#### Internal
- `ArchiveAdapter.readEntry` returns a Blob for every back end.
- The limits shared by the back ends (`ENTRIES_PER_PAGE_LIMIT`,
  `EXPANSION_LIMIT`) are defined once, in `src/config.ts`.
- A new error code, `page-unavailable`, marks a page that no retry can fix.
- Package author and copyright holder are now GaijinSystems.

#### Known and left
- libarchive's one-pass unpack still goes by the sizes an archive declares
  when deciding whether to start. One that understates them is unpacked
  inside the decoder's worker.
- A solid archive is held unpacked while it is open.
- Authenticated downloads follow redirects.
- The zip-to-libarchive fallback fetches the file again.

#### Not yet verified in a browser
The Blob change alters how every CBR, CB7 and small CBZ is opened, and the
decoder choice for RAR4 is new. Both are covered by the unit tests, the
decoder verification scripts and a run of the shipped worker file under Node,
and neither has been run in a browser against OpenCloud. The browser checks
recorded under 1.2.0 were made on 1.2.0.

#### Tests
217 unit tests (was 184).


## 1.2.0 — 2026-11-13

The first release that can be redistributed. UnRAR is gone, the licence is
AGPL-3.0-or-later, and the whole source went through a simplification pass, a
bug review and a security review, with three review rounds on the fixes.

### Upgrading
- **Replace the app folder; do not copy over it.** Otherwise the old
  `vendor/unrar/` lingers.
- **Remove `'unsafe-eval'` from your CSP** if you added it for this app. It is
  no longer needed for anything. See `docs/solid-rar.md`.
- `unrarModuleUrl` and `unrarWasmUrl` are no longer read.
- Reading positions saved by earlier versions are not found once: the storage
  key now includes the user.

### Solid RAR4 is read by unarr instead of UnRAR
- RARLAB's UnRAR made the build non-redistributable (its licence is not
  compatible with the AGPL) and needed `'unsafe-eval'` in `script-src`, a
  policy relaxation applied to the whole OpenCloud origin for one niche
  format. Both problems are gone.
- The replacement is [unarr](https://github.com/selmf/unarr) 1.2.0 (LGPL-3.0,
  derived from The Unarchiver), RAR reader only, compiled to WebAssembly: 81 kB
  where UnRAR's was 208 kB. It is built without Embind and with
  `-sDYNAMIC_EXECUTION=0`, so it needs only `'wasm-unsafe-eval'`.
- Its source is in `native/unarr/` and `npm run build:unarr` rebuilds it in a
  container, reproducibly: the committed files match a fresh build byte for
  byte.
- It runs in its own worker. UnRAR ran on the main thread, so a large solid
  archive froze the tab while it unpacked. A worker that goes silent for 30
  seconds is terminated.
- It is bounded, which the UnRAR path was not: entries listed, size kept per
  entry, and total expansion all have limits, and only page images and
  `ComicInfo.xml` are kept.
- `verify:formats` used to assert that `rar4-solid.cbr` *fails* through
  libarchive. It now requires all six pages, through the same extraction
  module the worker runs.

### Fixed
- **A decoder worker leaked when the reader was closed during an open.** The
  open could finish after teardown and install an adapter nothing was left to
  close.
- **Large CBZ files could fail to open across origins.** zip.js insists on an
  `Accept-Ranges` response header that a cross-origin DAV endpoint often does
  not expose to scripts, even though the reader's own probe had already proved
  range requests work.
- **A dropped connection was reported as a corrupt file**, with no retry
  offered. It is now a network error with "Try again".
- **The download link pointed at the previous comic** after the open file
  changed in place.
- **Page-turn click zones scrolled away with the page.** On a tall page in
  fit-width, a click at the edge after scrolling toggled the toolbar instead
  of turning the page.
- Double-page flags from ComicInfo were applied to the wrong pages when an
  earlier page was marked deleted.
- Finishing a comic in two-page view left a bookmark on the last spread.
- A root-relative `assetBaseUrl` broke every comic, CBZ included.
- Right-to-left set by one comic's metadata carried into the next.
- Callbacks from a closed comic could mark pages of the next one as failed, or
  hide its "unpacking" banner.
- A decoder timeout was described as WebAssembly being blocked. The two now
  have separate messages, and the CSP hint no longer mentions `worker-src`,
  which is not needed.
- Previous/next tooltips named the wrong arrow key in right-to-left mode.
- Fresh installs failed their own typecheck and one unit test, because there
  was no lockfile and newer dependency versions had moved.

### Security
- libarchive's bulk extraction now refuses archives that declare more than
  four times their own size, and keeps only page images under the per-page
  limit.
- Zip entry counts are capped while the directory is read, not after.
- Reading positions in local storage are stored per user, so accounts sharing
  a browser profile neither see nor inherit each other's.
- The development compose file publishes on loopback only. It runs with a
  known admin password.
- A `package-lock.json` is committed and the docs build with `npm ci`. The
  vendored libarchive files are recorded as libarchive.js 2.0.2 with hashes.

### Changed
- Licence is AGPL-3.0-or-later (was AGPL-3.0), with a `LICENSE` file in the
  source and in the built folder.
- `ArchiveAdapter` now declares `droppedEntryCount` and `unsupportedEntries()`,
  replacing property probing and casts in the orchestration layer.
- `supportsRandomAccess` is removed: it was read once, before it could change,
  so the wider cache window it was meant to trigger never applied.
- Read-ahead is clamped to the cache radius; pages prefetched beyond it were
  evicted as soon as they loaded.
- The page strip and bookmark pruning no longer do work proportional to the
  page count on every page turn.
- `CHANGELOG.md` and `LICENSE` are copied into the build rather than kept as
  second copies under `public/`.

### Known and left
- The libarchive expansion limit goes by the sizes an archive declares, so one
  that understates them is still unpacked inside the decoder's worker.
- Authenticated downloads follow redirects. Refusing them would break
  deployments that redirect to object storage.
- A page that fails to read stays failed until the comic is reopened.

### Verified in a browser
Besides the unit tests, the typecheck, the build and the decoder verification
scripts, run from a clean install, this release was checked on OpenCloud
9.1.0 (rolling) in Firefox ESR 153.7.0, with a policy that has
`'wasm-unsafe-eval'` and no `'unsafe-eval'`:

- every file in `testfiles/formats/` opens, including `rar4-solid.cbr`
  through the unarr worker;
- a CBZ larger than 8 MB streams by range request;
- clicking the page edges turns the page after scrolling in fit-width,
  fit-height and original size.

### Tests
184 unit tests (was 151), including the real unarr module over the RAR
fixtures and `openComic` end to end over a zip built in the test.


## 1.1.2 — 2026-09-18

Documentation only (development notes that are not part of this
repository); no code change. The app payload is identical to 1.1.1 apart
from the version string.

### Verified, not fixed
- The reading area's apparent height collapse was not real. Measured at both
  0° and 90°: `window.innerHeight` was 635, and the chain loses only the
  shell's own padding and borders. The earlier "528px in a ~1200px window" was
  my inference from screenshots taken at a different window size.


## 1.1.1 — 2026-09-18

Full scan, following the `left-1/2` finding.

### Changed
- **All load-bearing layout moved to inline styles.** An audit of every
  utility class this app uses against the OpenCloud source it ships with found
  15 that the host may not compile, several of them load-bearing:
  `max-w-none` (without it the host's `img { max-width: 100% }` caps
  fit-height and original at the pane width), `overflow-x-auto` (fit-height's
  scroll axis and the strip's), `min-h-full min-w-full` on the row, and the
  warning banner's background — an invisible warning being the worst failure a
  warning can have.

  Rather than guess which exist, nothing behavioural now depends on any class:
  the viewport chain, rotated wrapper, page-turn zones, strip scroll and
  highlight, and banner colours are all inline. Four decorative classes remain
  unverified; their absence changes appearance only.

  This also decouples layout from the OpenCloud version: it no longer depends
  on which classes a given release compiles for its own components.
- The harness now uses the same inline styles. It loads Tailwind from a CDN
  that compiles on demand, so a class-based harness could pass while the app
  failed — which is precisely how the original bug hid. Style tables are
  verified value-by-value against the component.

### Checked and clean
- No dead exports. No archive-derived input reaches any style or transform.
  0 production vulnerabilities. 151 tests.


## 1.1.0 — 2026-09-18

### Changed
- **Retargeted to OpenCloud 8.** Development dependencies moved from
  `@opencloud-eu/*` 7.x to 8.0.0, matching the OpenCloud 8.0.1 this is
  deployed on. No source change was needed: typecheck, all 151 tests and the
  build pass unmodified.

  This matters less at runtime than it looks — Module Federation means the
  host shell supplies web-pkg, so a 7.x-built app was already executing
  against the host's 8.0.0. What the retarget buys is being *told* about a
  breaking change at build time instead of meeting it in the browser.

  Differences that could have mattered, checked rather than assumed:
  `AppWrapperRoute` and the app-registration types are byte-identical between
  7.4.0 and 8.0.0. `AppWrapperSlotProps` gained `yjsStatus` and an
  `onRegister:onSaveCallback` emit and lost `appVersion`; this app picks none
  of them. The prop-inspection behaviour that decides whether the whole file
  is fetched before the reader runs is present in both.

### Still open
- The reading area measured 528px tall in a ~1200px window on OpenCloud 8.0.1.
  That is independent of this retarget and unexplained.


## 1.0.12 — 2026-09-18

### Fixed
- **Rotated pages sat hard against the left edge. Root cause found.**
  `left-1/2` does not exist in the CSS the browser actually has, so it
  resolved to `left: 0`. `top-1/2` does exist, which is why the vertical
  placement looked right and the horizontal did not.

  The reason: this app ships no utility CSS of its own, and there is no
  Tailwind compiler in the build. Classes work only because OpenCloud's shell
  serves its own compiled Tailwind — so a class exists only if OpenCloud uses
  it somewhere. Unavailable classes fail silently.

  Confirmed arithmetically against the reported DOM: with `left: 0` the
  predicted visual box is 432..960, exactly what was measured.

  The rotated wrapper and image are now positioned with inline styles that
  depend on no classes at all.
- **Page-turn zones were at the same risk** and have been inlined too. Their
  geometry comes from `w-1/4`, `bottom-4` and `right-4`; a zone whose
  positioning does nothing either vanishes or covers the whole reader and
  swallows every click.

### Documented
- README now explains the constraint and includes a console snippet for
  checking whether a given class is actually available.

### Note on the four earlier attempts
1.0.7 through 1.0.11 each fixed something real — a wrong container
measurement, the geometry model, the pane's centring idiom, a percentage
translate — but none was this. Every one was found by reasoning about the
boxes, which all measured correctly; the failure was a class that was never
applied. The DOM dump that included computed `left` and `top` is what
identified it, and asking for that sooner would have saved four releases.


## 1.0.11 — 2026-09-18

### Fixed
- **A sideways page sat left of centre.** Measured in the running app, the
  image's centre landed on its wrapper's left edge — displaced by half the
  image's height. The wrapper itself was centred correctly; only the image
  inside it was not, which is why several passes aimed at the sizing and the
  pane's centring changed nothing.

  Centring now uses negative pixel margins instead of
  `translate(-50%, -50%)` in a transform list that also rotates. Margins are
  applied during layout, before any transform, so they cannot resolve against
  the wrong axis.

  Note: the mechanism behind the original displacement is not understood —
  the spec says that transform list should have worked. The fix is justified
  by being unambiguous, not by a confirmed diagnosis.

### Also
- The harness's centring check now measures each page against its own pane,
  and vertically as well as horizontally. The previous check compared the
  first image to the whole viewport, which could pass while a page was in fact
  off-centre within its pane.


## 1.0.10 — 2026-09-18

### Fixed
- **A rotated page sat against the left edge instead of centred.** The pane
  holding each page still centred with `justify-center`. That is identical to
  an auto margin until the child is larger than the pane, at which point it
  overflows equally on both sides and the start side becomes unreachable — so
  the page reads as pushed to one edge with its far side cut off.

  The row above the pane had already been changed to `m-auto` for exactly this
  reason. The pane was missed, and every fix since has been aimed at the
  geometry rather than at the centring. Panes now centre with `m-auto`, as do
  the loading and failed-page placeholders.


## 1.0.9 — 2026-09-18

Review of 1.0.8.

### Fixed
- **A half-turn page opened at its end.** At 180° the image is rotated in
  place with no wrapper, so its layout top is its visual bottom, and the scroll
  reset to the origin put a fit-width page's last lines on screen first. The
  half turn now scrolls to the far corner after layout. 90° and 270° were
  already right: their wrapper's top is the visual top.
- Source README still claimed 122 tests; it is 151.

### Checked and left
- Style bindings take only computed pixel sizes and the typed rotation value;
  nothing derived from archive content reaches a style or transform.
- Natural-size map is keyed by blob URL and pruned to the visible spread on
  every insert. A load event for a URL that just left the screen can leave
  one extra entry until the next insert; bounded, harmless.
- Overflow axes agree with the geometry: sideways fit-width overflows
  vertically and the viewport scrolls vertically; fit-height the reverse.


## 1.0.8 — 2026-09-18

### Fixed
- **Rotating to 90°/270° clipped the left edge and left-justified the page.**
  The rotated size was computed as a fresh fit against a measured container,
  so any moment the measurement was stale or zero produced a box wider than
  the reading area — and a scroll container makes the left overflow
  unreachable.

  Rotation now keeps the size the page already had and only changes its
  orientation, which is what happens when you turn a physical magazine. The
  rotated box can therefore never exceed the upright one, so the clipping
  failure mode is gone by construction rather than by getting a measurement
  right on every render.

### Changed
- Fit modes now split deliberately. **fit-page** preserves the upright size,
  clamped only so the whole page still fits. **fit-width**, **fit-height** and
  **original** follow the on-screen orientation, so "fit width" fits the width
  you are actually looking at. `original` is unaffected by rotation.


## 1.0.7 — 2026-09-18

Review of 1.0.6. Three defects, all in code added that day.

### Fixed
- **Resume broke on in-place navigation.** The per-comic reset from 1.0.5
  moved `currentPage` to 0, the progress watcher fired, and `saveProgress`
  treats page 0 as "finished" and deletes the entry — an instant before
  `load()` tried to read it. Position writes are now suppressed from the
  start of `load()` until the saved position has been applied.
- **Rotated pages were fitted against the wrong box.** `App.vue` measured its
  own root, which includes the toolbar, page strip and banners, so the height
  passed to the fit calculation was too large and a sideways fit-page was
  clipped by `overflow-hidden`. `ReaderViewport` now measures itself and
  reports its size upward; nothing else measures.
- **Natural page sizes could go stale.** They were cleared on a page-count
  change, which two comics of equal length never trigger, and a guard then
  prevented the correct size from overwriting the stale one. Sizes are now
  keyed by blob URL, which no two comics share, and pruned to the visible
  spread on every insert.

### Tidied
- `rotatedFit` was computed three times per page per render; once now.
- `rotation` prop on the toolbar typed as `Rotation` rather than `number`.


## 1.0.6 — 2026-09-18

### Added
- **Page rotation.** Toolbar button (right of zoom) and `v` cycle the whole
  comic 0° → 90° → 180° → 270° → 0°. Sticky across page turns, reset when the
  comic is closed, never persisted. Thumbnails are deliberately not rotated.
- Two-page mode is suspended at 90°/270°, where pairing landscape-displayed
  pages would be unreadable. The preference is derived rather than
  overwritten, so it returns untouched at 0°/180°; the button still toggles it
  while rotated and the tooltip explains that it applies when upright.

### Fixed
- `toggleSpreadMode` decided from the *effective* two-page value, which is
  always false while rotated — so the button could only ever switch two-page
  on, never off. It now reasons about the upright value. Found by its own
  regression test during implementation.

### Notes
- Rotation is display-only: no effect on the cache, on blob URLs, or on the
  downloaded file. Toggling repeatedly allocates nothing.
- `docs/fit-rotation-harness.html` verifies the geometry in a browser and is
  checked against the component's own class tables.

## 1.0.5 — 2026-09-18

### Fixed
- **Reader state leaked between comics.** `useReaderState` is created once per
  mount and reused when the route's resource changes in place — which happens
  on browser back/forward between two comics. Nothing reset it, so:
  - `measuredWidePages` carried one comic's landscape pages into the next,
    forcing unrelated pages onto rows of their own.
  - `currentPage` survived into a shorter comic, leaving the viewport on
    spread 0 while the toolbar read "41 / 20" and the slider sat past its max.

  `resetForNewComic()` now clears both from `load()`. View preferences (fit
  mode, spread mode, reading direction) are deliberately kept: they belong to
  the reader, not the comic.
- `useReaderState` had no tests at all; it now has 16.


## 1.0.4 — 2026-09-17

Audit round. Three small code fixes, and documentation brought back in line
with the CSP finding from 1.0.3.

### Fixed
- Two-page `auto` mode measured the window, not the reader. With OpenCloud's
  sidebar open the reading area can be far narrower than the window, so
  two-page mode engaged with no room for it. Now measures the reader element
  via ResizeObserver, which also reacts to the sidebar opening and closing.
- Page-strip auto-scroll looked up thumbnails by position in a `v-for` ref
  array, whose order Vue does not guarantee. Now looks up by attribute.
- A zip directory read that fails on a range source reported "corrupt". The
  same URL answered the probe moments earlier, so it is far more likely a
  dropped connection or expired token; it now reports as a network error.

### Documentation
- README, INSTALL.txt and the bundle README had all been updated for the
  bundled UnRAR but still said solid RAR worked "with no configuration". It
  needs 'unsafe-eval' in script-src; every doc now says so, with the
  trade-off, and the HAProxy snippet carries both directives.
- The source README's solid-RAR section still described UnRAR as "not
  bundled" — the heading had been updated in 1.0.2, the body had not.


## 1.0.3 — 2026-09-17

### Fixed
- Solid RAR still failed in the browser. The Emscripten runtime inside UnRAR
  calls `new Function()` once, in an Embind helper that names error
  constructors, which a CSP without 'unsafe-eval' rejects — so the back end
  never started. `scripts/patch-unrar.mjs` replaces that helper with an
  Object.defineProperty equivalent and runs as part of `npm run build`. That
  removes one eval but not the requirement: Embind also generates its invoker
  functions from source strings, which is structural. Solid RAR therefore
  needs 'unsafe-eval' in script-src; everything else does not. See
  docs/enabling-solid-rar.md for the trade-off.
- Every silent failure path now logs a `[comic-reader]` warning. The quiet
  degradation was correct for users but made a misconfiguration and a genuine
  bug indistinguishable, which cost a debugging session.
- Test files tidied. Three problems, none of them reader bugs:
  - The CC0 rar-test-files were shipped in `testfiles/` as if they were sample
    comics. Their images are 2x2 pixels, so they open correctly and look
    broken. They have been replaced entirely by generated equivalents under
    `tests/fixtures/rar/`, removing the last third-party test data along with
    its licence files.
  - `zip-*-UNSUPPORTED.cbz` were named before the libarchive fallback existed.
    All three now open, so the names said the opposite of the truth. Renamed
    to `zip-bzip2.cbz`, `zip-lzma.cbz`, `zip-ppmd.cbz`.
  - `verify:formats` asserted those three should FAIL, so it would have gone
    green if the fallback ever broke. It now decodes them the way the reader
    does and requires success.

## 1.0.2 — 2026-09-16

Final. Every supported container and compression method has a test file, is
decoded through the back end the reader actually uses, and has been exercised
against a live OpenCloud 7.5.0 instance.

### Format support
- Zip: bzip2, LZMA and PPMd now open. zip.js and libarchive turned out to be
  complementary, so archives zip.js cannot decode are handed to libarchive.
- Solid RAR: UnRAR bundled in `vendor/unrar/` and used automatically. This
  makes the build **non-redistributable** (see THIRD-PARTY-NOTICES.txt).
- RAR4 compressed and RAR5 solid verified with real 6-page comics.

### Fixes since 1.0.1
- Fit-height and fit-width did nothing; overflow start was unscrollable.
- Toolbar controls had no tooltips.
- Solid RAR4 yielded "No pages found"; now reported by name.
- Zip fallback closed the working reader before its replacement existed.
- UnRAR results mapped by position; a skipped entry mislabelled every later page.
- UnRAR path had no decompression-bomb guard.
- `maxEntryBytes` was static across ZipAdapter instances.
- Failed module/wasm loads were cached for the session.
- Click zones overlapped scrollbars.
- Dead fields `streamed`, `usedZipFallback`, `clearProgress` removed.

### Testing
- 122 unit tests; orchestration and reading-progress layers newly covered.
- All fixtures regenerate from `npm run fixtures` with no external tools.
- 17-archive compression matrix, `npm run verify:formats`.
- 47 RAR4 archives from libarchive's own corpus audited against the solid
  detector: exactly one true positive, zero false positives.

### Not built, by decision
Translations, touch/mobile, next/previous comic, sidebar panel, bookmark
navigation, aria-live announcements, e2e tests.

## 1.0.1 — 2026-09-16
- WASM CSP probe fixed (probes `instantiate`, not `Module`).
- Worker call timeouts; build stamp in manifest; ComicInfo title wired.

## 1.0.0 — 2026-09-16
Initial build.
