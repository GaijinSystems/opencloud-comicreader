# Comic Reader for OpenCloud Web

Opens `.cbz`, `.cbr`, `.cb7` and `.c7z` comic archives directly in the OpenCloud
file manager. Click a comic and it opens in a reader: no download, no desktop
app, no unpacking.

- Page-by-page reading with keyboard, click zones and the page slider
- Rotation for pages meant to be read sideways, in 90° steps
- Fit page / fit width / fit height / original size
- Two-page spreads, with the cover on its own and landscape pages unpaired
- Right-to-left (manga) mode, set automatically from `ComicInfo.xml`
- Remembers where you left off, per file
- Password-protected comics in every format (CBZ, CBR, CB7/C7Z), after
  asking for the password
- Works on public links as well as signed-in sessions

## Compatibility

**Requires OpenCloud 6.0.0 or newer.** Version 1.2.2 was tested on OpenCloud
6.0.0, 8.1.0 and 9.1.0 (rolling) and 7.2.5 (stable): on each, CBZ, CBR and
CB7 comics, password-protected ones included, opened from the file list and
showed their pages. Older versions were not tested.

The app is built against `@opencloud-eu/web-pkg` **8.2.2** (the version
`package-lock.json` pins).

Note that the app bundles none of those packages — Module Federation means the
running OpenCloud shell supplies them. So the version here governs the types
the app is checked against, not what it executes. An app built against 7.x ran
correctly on an 8.0.1 host, which is evidence the surfaces it uses are stable
across that boundary, but building against the version you deploy on is the
only way to be told about a break rather than discover it.

What actually changed between web-pkg 7.4.0 and 8.0.0 for an app like this:

- `AppWrapperRoute` — identical.
- `ApplicationInformation`, `ApplicationFileExtension` and the rest of app
  registration — identical.
- `AppWrapperSlotProps` — gained `yjsStatus` and an `onRegister:onSaveCallback`
  emit for collaborative editing; **lost `appVersion`**. Only matters if you
  `Pick` one of those. This app picks `applicationConfig`, `space`, `resource`,
  `getUrlForResource` and `revokeUrl`, all unchanged.
- The behaviour this app most depends on — `AppWrapper` deciding what to fetch
  by inspecting the wrapped component's declared props — is present in both.

## Installing

1. Build the app (`npm ci --legacy-peer-deps && npm run build`; the README at
   the top of the repository has a container command that needs nothing
   installed) and copy the resulting `dist/` into the web apps directory as
   `comic-reader`. That directory defaults to `$OC_DATA_DIR/web/assets/apps/`:

   ```
   $OC_DATA_DIR/web/assets/apps/comic-reader/
   ```

   With `opencloud-compose`, put it in `config/opencloud/apps/comic-reader/`
   instead; that path is already mounted into the container.

2. Allow WebAssembly in the server's content security policy (see below). CBZ
   works without this, password-protected CBZ included (unless its pages are
   in bzip2, LZMA or PPMd); CBR and CB7 do not.

3. Restart the stack:

   ```bash
   docker compose restart
   ```

The app appears automatically and takes over the four comic extensions.

### Content security policy

RAR and 7z decoding is done by WebAssembly builds of libarchive and unarr, and
the stock policy does not permit WASM compilation. One directive value is
required, and it is the only one: nothing in the app needs `'unsafe-eval'`.

```yaml
directives:
  script-src:
    - "'self'"
    - "'unsafe-inline'"
    - "'wasm-unsafe-eval'" # <-- required for CBR/CB7/C7Z
```

The YAML quoting matters: CSP keywords must reach the browser inside single
quotes, so `"'wasm-unsafe-eval'"` is correct and a bare `wasm-unsafe-eval` is
parsed as a hostname and does nothing.

No `worker-src` is needed. The stock policy defines none, so workers fall back
to `child-src: 'self'`, and this app's workers are same-origin. Adding `blob:` to
`child-src` is optional and only lets zip.js move CBZ inflation off the main
thread.

The CSP file replaces the built-in policy rather than merging with it, so edit
the existing one. `dev/docker/opencloud/csp.yaml` is OpenCloud's stock policy
with the single required line added and marked.

Without these, the reader degrades rather than breaking: CBZ files still open
(zip.js falls back to decompressing on the main thread), and CBR/CB7 show an
error explaining that the administrator needs to allow WebAssembly.

## Configuration

Configure via `$OC_CONFIG_DIR/apps.yaml`, which survives app updates:

```yaml
comic-reader:
  config:
    registerAsDefault: true # open comics on left-click, not just "Open with"
    maxArchiveSizeMb: 1024 # cap for formats that need a full download
    rangeThresholdMb: 8 # CBZ below this is downloaded rather than streamed
    bulkExtractLimitMb: 256 # cap for unpacking a solid archive in one pass
    cacheRadius: 8 # pages kept decoded either side of the current one
    prefetchPages: 3 # pages fetched ahead of the reading position
    maxPages: 5000
    maxPageSizeMb: 64 # per-page ceiling; a decompression-bomb guard
    defaultFitMode: fit-page # fit-page | fit-width | fit-height | original
    defaultSpread: auto # single | double | auto
    enableJxl: false # JPEG XL has partial browser support
    rememberPosition: true
    assetBaseUrl: null # override if app assets are served from elsewhere (same origin; a cache in front must not strip ?v= from its key)
```

Every value is clamped to a sane range on read, so a typo degrades to the
default rather than producing a reader that allocates unbounded memory.

## Keyboard

| Key | Action |
| --- | --- |
| `→` / `←` | Next / previous page (swaps in right-to-left mode) |
| `Space` / `Shift+Space` | Next / previous page |
| `Page Up` / `Page Down` | Previous / next page |
| `Home` / `End` | First / last page |
| `f` | Cycle zoom mode |
| `d` | Toggle two-page view |
| `r` | Toggle reading direction |
| `v` | Rotate the page a quarter turn clockwise |
| `t` | Toggle the page strip |

## How it works

### Formats

| Format | Back end | Strategy |
| --- | --- | --- |
| CBZ | [zip.js](https://github.com/gildas-lormeau/zip.js) | Reads the central directory over HTTP `Range`, then pulls pages individually. A 500 MB comic shows its first page without a full download. |
| CBR | [libarchive.js](https://github.com/nika-begiashvili/libarchivejs), then [unarr](https://github.com/selmf/unarr) | Full download, then WASM decode. libarchive covers RAR5 and non-solid RAR4; solid RAR4 is handed to unarr. |
| CB7 / C7Z | libarchive.js | Same. Solid archives are detected from read latency and unpacked in one pass. |
| CB7 / C7Z with a password | [7-Zip](https://www.7-zip.org/)'s 7z reader | Full download, then one WASM pass over the whole archive, once the password has been entered. |

A password-protected CBZ is decrypted by zip.js, page by page, and still
streams. A password-protected CBR is decrypted whole first, and then read as
any other. See [Password-protected comics](#password-protected-comics).

The container is identified from its magic bytes, not its extension. Plenty of
files named `.cbr` are really zips, and those open correctly here.

### Memory

Blob URLs pin their backing data until revoked, so a naive reader holds the
whole comic in memory by the last page. The page cache keeps a window around
the reading position and revokes everything outside it, which is what keeps
the tab flat across a long book. Per-page and total-size limits guard against
decompression bombs, including archives that understate their entry sizes,
for what is kept; see `SECURITY.md` for what a decoder may still spend on
such an archive.

Archives and pages are Blobs from download to display, never ArrayBuffers.
The browser keeps a Blob's bytes outside the JavaScript heap and passes it to
a worker, or wraps it in a File, by reference:

- A download is folded into a Blob every 8 MB as it arrives, so the page never
  holds the file as one array, let alone twice.
- zip.js reads the Blob in place.
- libarchive's worker and unarr's worker each receive the Blob by reference
  and make the one working copy a decoder needs inside their own heap. That
  copy is the part this app cannot remove.
- Every back end returns a page as a Blob, and the cache gives it its image
  type with `slice()`, which shares the bytes.

The exception is libarchive: its worker hands bytes to the page as arrays. A
single read arrives as one array, which libarchive.js wraps in a File at
once; the one-pass unpack of a solid archive returns every entry as an array,
the pages are copied into Blobs, and the arrays are dropped as soon as the
pass ends.

What it costs, roughly: a CBZ, about nothing beyond the pages on screen; a
CBR or CB7, the file once in the browser's Blob store and once in the
decoder's worker; a solid archive, that plus its unpacked pages for as long as
it is open, because a solid archive can only be read front to back.

### The bulk-extraction hazard

The worker is terminated when the one-pass unpack completes. A
single-file read that was already in flight at that moment **never settles** —
it does not reject, it hangs forever, which in the reader means a page stuck
on a spinner with no error. Prefetch makes this a near-certainty rather than a
theoretical race: solid-archive detection fires on one of the first pages,
exactly when several reads overlap.

The adapter therefore drains every in-flight read before starting bulk
extraction, and closes its reader afterwards so later reads fail at once
instead of hanging. If the pass itself fails, the decoder it failed in is
dropped (its state is unknown) and a fresh one is started on the same
archive, so the pages go on being read one at a time as they were before;
the pass is not tried again. `npm run verify:libarchive` checks that a read issued
after the reader is closed is rejected; the in-flight case is not exercised
there.

### Utility classes are not all available

This app ships **no utility CSS of its own** — its stylesheet is ~100 bytes.
Tailwind classes work only because OpenCloud's shell serves its own compiled
Tailwind, so **a class exists only if OpenCloud itself uses it somewhere**.
There is no compiler in this build to generate the rest.

The failure is silent: an unavailable class simply does nothing. `left-1/2`
is absent while `top-1/2` is present, which put rotated pages hard against the
left edge of the screen and survived four attempted fixes because every
measurement of the *boxes* looked correct.

So **all load-bearing layout is written as inline styles**, not classes: the
entire viewport chain (overflow, row, pane, image sizing), the rotated
wrapper, the page-turn zones, the strip's scroll and selection highlight, and
the warning banner's colours. Classes remain only where failure would be
visible and harmless — a missing colour or padding, never a missing scroll
axis or an invisible warning.

This also removes a version coupling: layout no longer depends on which
classes a particular OpenCloud release happens to compile for itself. An
audit against the host source OpenCloud ships found four remaining classes
this app uses that the host may not — `max-w-prose`, `md:inline`,
`tabular-nums` and one `overflow-x-auto` now inlined — all decorative. This snippet
reports what is actually available, run in the console on a page of the app:

```js
['left-1/2','top-1/2','shrink-0','tabular-nums','cursor-e-resize','w-1/4']
  .forEach(c => {
    const el = document.createElement('div')
    el.className = c; document.body.appendChild(el)
    const cs = getComputedStyle(el)
    console.log(c, cs.left, cs.top, cs.flexShrink, cs.fontVariantNumeric, cs.cursor, cs.width)
    el.remove()
  })
```

### Rotation

Some pages are scanned sideways. The toolbar's rotate button, and `v`, cycle
0° → 90° → 180° → 270° → 0°. Rotation applies to the whole comic, persists
across page turns, and resets when the comic is closed. It is never stored.

Two implementation notes, because both are easy to get wrong:

- CSS `transform: rotate()` does **not** change an element's layout box, so a
  page rotated a quarter turn still *occupies* its unrotated dimensions while
  *appearing* rotated. Every fit rule is expressed against the layout box and
  would constrain the wrong axis. `helpers/rotatedFit.ts` therefore computes
  the size explicitly, and the image is placed inside a wrapper sized to its
  *rotated* footprint so the scroll container sees a correct, plain box.
  At 0° and 180° none of this runs and the rendering path is the one that
  shipped before rotation existed — 180° preserves the aspect ratio, so the
  CSS classes stay correct.
- **Fit-page keeps the size the page already had.** A magazine does not get
  bigger when you turn it sideways, and reading it is neither easier nor
  harder; the reader behaves the same way. The scale is the one the page would
  have upright, clamped only so the rotated footprint still fits — that mode
  promises the whole page is visible, and on a narrow reading area a sideways
  page can exceed the width even at its upright scale. The clamp only shrinks.
- **The other modes follow what is on screen.** "Fit width" means the width
  you are looking at, which after a quarter turn is the page's height;
  anything else would make the button lie about what it does. `original` is
  one image pixel per screen pixel and so is unaffected by orientation.
- Two-page mode is **suspended** at 90° and 270°: two landscape-displayed
  pages side by side give four half-height columns. It is derived, not
  stored, so the reader's preference survives and returns at 0°/180°. The
  button keeps working while rotated and says so in its tooltip.

### Zip: the two back ends are complementary

zip.js implements stored, deflate and deflate64. libarchive implements stored,
deflate, bzip2, LZMA and PPMd, but not deflate64. When zip.js reports a method
it cannot decode, the archive is handed to libarchive instead, so every one of
those methods works. The fallback needs the whole file, so a streamed archive
is re-fetched in full on that path. Verified across all six zip variants in
the format matrix.

### Solid RAR4: a second decoder

libarchive declines solid RAR4 outright ("RAR solid archive support
unavailable") and returns only the first entry of a solid block.

The impact is total, not partial. On a real 6-page solid RAR4 comic
(`rar4-solid.cbr` in the format matrix) libarchive enumerates 1 of 9 members
and decodes **zero** pages. Left alone, such a comic opens as a one-page comic
or as "No pages found": a wrong answer that looks like success.

Non-solid RAR4 is unaffected (`rar4-compressed.cbr` reads 9 of 9 members and
all 6 pages), and so is RAR5, solid or not. So this is one narrow gap, and it
is closed in two steps.

**Detecting it.** `src/archive/rar4.ts` walks the container's own header chain,
reads the solid flag and counts what the archive declares. If a solid archive
does end up in libarchive and yields fewer entries than that, the entries
were dropped, and the reader says so. Two things about the detection
are deliberate, and both came from measuring rather than guessing:

- **It is gated on the solid flag.** Checked against all 47 usable RAR4
  archives in libarchive's own test corpus: exactly one triggers, and it is
  the one that genuinely loses a file.
- **Symlinks are excluded from the count.** libarchive does not surface them
  through this API, so counting them reported a shortfall on entirely intact
  archives. Every non-solid mismatch in the corpus was exactly this.

**Reading it.** A solid RAR4 goes to [unarr](https://github.com/selmf/unarr),
an LGPL-3.0 decoder derived from The Unarchiver, which reads it in full. unarr
does not read RAR5, which is why it sits beside libarchive and does not
replace it. How it is wired:

- **Chosen up front.** `openComic` walks the headers before starting any
  decoder (a few small reads, a 64 KB window at a time, never the whole file)
  and sends a solid RAR4 straight to unarr. libarchive is not started for it,
  so the archive is not loaded twice. Everything else goes to libarchive,
  with unarr as the fallback if libarchive rejects a non-solid RAR4.
- **Its own worker.** `src/archive/unarrAdapter.ts` starts
  `vendor/unarr/unarr-worker.mjs`, hands it the archive Blob by reference, and
  gets every page back as a Blob in one message. A solid archive can only be
  read front to back, so one sequential pass is also the fastest way to read
  it.
- **Cannot hang the reader.** The worker reports progress as it goes. One
  that goes silent for 30 seconds is terminated, and so is one that has not
  finished within 60 seconds plus a second per megabyte of archive, however
  steadily it reports: an archive controls how fast it decodes.
- **Bounded.** The pass stops listing after four times the page limit, keeps
  nothing larger than the per-page limit, stops decoding once the archive has
  expanded to four times its own size, and stops keeping pages at the ceiling
  libarchive's one-pass unpack works under. Only page images and
  `ComicInfo.xml` are kept. Entries it could not read are still listed, so the
  page count stays honest and they show as unreadable pages.
- **Never worse than before.** If unarr cannot help (the worker fails to
  start, decoding stalls, the listing comes back empty), the reader falls back
  to libarchive and warns that entries are missing, as it did before unarr
  existed.
- **Encrypted archives are decrypted first.** unarr cannot decrypt, and
  would list such an archive's entries and return them all unreadable. A
  RAR4 archive with any password-protected entry is recognised from its own
  headers, before either decoder is started, and the reader asks for the
  password. What unarr is then given is the archive decrypted; see
  [Password-protected comics](#password-protected-comics).
- **No extra CSP.** The module is built without Embind and with
  `-sDYNAMIC_EXECUTION=0`, so it needs only the `'wasm-unsafe-eval'` that
  libarchive already requires.

The WebAssembly module is built from `native/unarr/` (the unarr sources used,
the C interface and the build script) by `npm run build:unarr`, reproducibly,
in a container. It is not committed. The extraction loop, `vendor/unarr/unarr-extract.mjs`, is a plain
module that the worker, the unit tests and `verify:formats` all import, so
what the tests exercise under Node is the file the browser runs.

Multi-volume RAR archives are not supported by either decoder.

Versions up to 1.1.2 used RARLAB's UnRAR here. Its licence made the combined
build non-redistributable, and its Embind build needed `'unsafe-eval'`. A
pure-JS alternative (`unrar-js`) was also evaluated and fails on exactly the
solid case this exists for.

### Password-protected comics

Every format opens with its password.

| Container | How |
| --- | --- |
| CBZ (zip), ZipCrypto or AES | zip.js decrypts each page as it is read. |
| CBZ in bzip2, LZMA or PPMd | libarchive decodes those methods. It undoes ZipCrypto itself; AES entries are decrypted for it first. |
| CB7 / C7Z (7z), file names readable or encrypted | 7-Zip's 7z reader, compiled to WebAssembly. |
| CBR (RAR4 and RAR5), file names readable or encrypted, solid or not | Decrypted first, then read by libarchive or unarr as any other RAR. That covers RAR's AES (RAR 3.0 and later) and the cipher before it (RAR 2.x). |

Not supported: RAR encryption from before RAR 2.0 (archives from before
1996; 7-Zip has no implementation of it), and archives split into volumes
(the reader opens one file). Each is refused with a message that says so.

How it works:

- **The prompt.** A protected comic opens to a password field in place of
  the pages (`ReaderPassword.vue`). A wrong password brings the field back
  with a message. The archive is not downloaded again for the second
  attempt.
- **Where the password goes.** It is used in the browser tab and nowhere
  else: it is not sent to the server, not written to storage and not kept
  with the reading position, so it is asked for again each time the comic is
  opened. For a CBZ it is held by the zip reader for as long as the comic is
  open, since each page read needs it. For a CB7 or CBR it is handed to a
  worker, which is terminated when its pass ends. (The browser's own
  password manager is outside the reader's control. The field is marked so
  that it is not filled with the saved account password, but a browser may
  still offer to save what is typed, or to generate a password. Decline
  both: it is not the password of the OpenCloud account.)
- **CBZ.** The password is settled before anything is shown. zip.js first
  asks up to three entries whether they accept it. Zip's own check is short
  (one byte per entry for ZipCrypto, two for AES), so that alone proves the
  password only when three ZipCrypto entries, or two AES ones, accept it.
  With fewer (a short comic, or an entry that turned the password away) one
  of the entries that accepted it is decoded and its checksum compared,
  which a wrong password does not survive. (Empty entries are left out of
  all of this: they accept any password.) A password most of the entries
  refuse is wrong; one bad entry among good ones is outvoted, and shows as
  an unreadable page. In the rare case that nothing could be checked or
  decoded at open, the first encrypted page read decides, and a failure
  there sends the reader back to the prompt.
- **CBZ in bzip2, LZMA or PPMd.** zip.js does not decode those methods, and
  a zip without a password is handed to libarchive for them. With a password
  the same happens. libarchive undoes the old zip encryption (ZipCrypto)
  itself; it does not compare an entry's checksum, so until the password is
  proved the reader compares it, and an encrypted page that fails to read
  sends the reader back to the prompt unless another page vouches for the
  password. libarchive cannot undo AES (it is built without a cryptography
  library), so AES entries are decrypted first, each one's authentication
  code checked, and libarchive is given the zip without them encrypted. (A
  zip read by range is downloaded whole for libarchive; that download is
  kept for a second password attempt.)
- **CB7.** libarchive recognises 7z encryption and stops there, so once there
  is a password the archive goes to a second decoder: 7-Zip's own 7z reader,
  built from `native/sevenzip/` and shipped in `vendor/sevenzip/`. It runs on
  the unarr back end's machinery: its own worker, one pass over the whole
  archive, the same limits and the same two time limits, and only page images
  and `ComicInfo.xml` kept. Unlike unarr it does not copy the archive into
  its memory: it reads it from the downloaded file a part at a time, so the
  archive is held once, not twice.
- **A wrong password and a damaged file look alike in 7z.** The format has no
  password check: a wrong one either fails to open the encrypted headers or
  decodes to noise. Both are reported as a wrong password, and the message
  says a damaged file can look the same. Every block is tried before the
  password is called wrong, so damage, however much of it, does not cost a
  comic whose password is right as long as one block still decodes; the
  price is that a wrong guess takes a pass over the archive, as the right
  password does. Once encrypted headers have opened, the
  password is known to be right, and later damage shows as unreadable
  pages. A 7z written without checksums (7-Zip never writes one) gives the
  decoder nothing to check by; for that case the pages that came out are
  looked at, and unless at least half of them begin like images the
  password is reported wrong.
- **A 7z that is only partly encrypted** is treated as encrypted: without the
  password the reader asks for it and does not show the half it could read.
- **CBR.** Neither libarchive nor unarr decrypts RAR. The same module that
  holds 7-Zip's 7z reader holds 7-Zip's decryption routines for RAR, and
  `vendor/sevenzip/decrypt-rar.mjs` uses them to walk the archive, decrypt
  every encrypted header and every entry's packed data, and write out the
  same archive without the encryption. Nothing is decompressed in that
  step; the result goes to libarchive or unarr as any RAR would. The
  decryption is 7-Zip's (`CPP/7zip/Crypto`, plain LGPL). No RAR
  *decompression* code of 7-Zip's is compiled: that is the part under its
  unRAR licence restriction, and the reason this app does not use UnRAR.
- **Checking a RAR password.** RAR5 records a check value, so a wrong
  password is refused at once. (A check value that is itself damaged is
  not used, by RAR or by 7-Zip; such an archive is then judged like a
  RAR4.) RAR4 records none, and nor does the cipher of RAR 2.x. With
  encrypted headers their checksum settles it (two headers, or one that
  also reads field by field as a file's: the checksum alone is 16 bits). A
  stored entry of four bytes or more whose data matches its checksum
  settles it too; one that does not is damage or a wrong password, and
  settles nothing. Otherwise the archive is decrypted regardless and the
  answer comes from decoding: if encrypted entries were decoded and none
  came out whole, the password was wrong. (An entry that never was
  encrypted, a cover say, decodes under any password and is not counted;
  nor is one that a size limit kept from being decoded at all.) A decrypted RAR4
  always goes to unarr, which decodes every entry in one pass, so looking
  at every page costs nothing more; a wrong guess costs what opening with
  the right password does.
- **RAR 2.x.** Archives from 1996 to 2002 were encrypted with a cipher of
  RAR's own. 7-Zip implements it, and it is decrypted the same way. No
  current archiver writes it, so the test archive is written by
  `scripts/rar_writer.py` and checked against RARLAB's unrar
  (`scripts/check-rar2-fixture.sh`); its entries are stored, and a
  compressed one has not been tested. The cipher takes the password as the
  bytes its writer typed, in a DOS code page the archive does not name: the
  reader sends UTF-8, which is right for a password in ASCII and a guess
  for any other.
- **Padding.** RAR pads each encrypted entry to the cipher's block size.
  For a stored entry the size says where the data ends, and the padding is
  cut. For a compressed RAR5 entry the decrypter follows the entry's chain
  of compressed blocks (each says its own length and whether it is the
  last) to the end of the data and cuts there, still without decompressing:
  libarchive's solid decoder does not get past padding. Where the chain
  does not hold, nothing is cut.
- **Solid RAR4, decrypted.** A compressed RAR4 entry has no such chain,
  and decrypting leaves the padding in. unarr reads a little ahead and, in a
  solid archive, would carry that padding into the next entry; a small
  addition to this app's own glue (`native/unarr/glue.c`, not unarr's
  sources) has it start each entry clean, as RAR's own unpacker does.
- **Memory.** Decrypting a RAR, or the AES entries of a zip, produces the
  archive a second time, as a Blob the browser may keep on disk. It is
  gathered into that Blob as it is written, 32 MB at a time, so the worker
  never holds it whole; entries that were not encrypted are not read at
  all, only referred to. Both exist only while the comic is being opened:
  the downloaded original is let go once it is, and what remains is what
  any comic leaves, the archive its decoder reads from (or, with unarr,
  only the decoded pages).
- **Decrypting a zip.** The AES entries are tried one after another. The
  scheme's two verification bytes come first and cost next to nothing, so
  a wrong password is found out quickly: it is called wrong when no entry
  has decrypted and a thousand have refused it outright (or all of them,
  in a smaller archive). An entry that does not decrypt while others do
  (damaged, or under a password of its own) is left as it is and shows as
  a page that cannot be read. Entries that accept the password and then
  all fail their authentication codes are damaged, and reported as that. zip64
  archives (over 4 GB, or with more than 65,535 entries) are read and
  written as such. 7-Zip's routine stops at a password of 99 bytes; the
  scheme does not, and a longer one is handed over as its SHA-1, which the
  key derivation (PBKDF2 over HMAC-SHA-1) would make of it anyway. A zip
  whose directory names the same entry more than once is refused, so that
  it cannot be made to grow without end.
- **Checksums after decrypting a zip.** The second version of zip's AES
  scheme stores no checksum of an entry's data and relies on its
  authentication code, which is checked while decrypting. Where a zip has
  such entries, libarchive is told not to compare checksums for it
  (`@zip-unchecked`, see `native/libarchive/README.md`); otherwise it
  compares them as usual.
- **Browser support.** The 7-Zip module uses WebAssembly exception handling,
  which Chrome 95, Firefox 100 and Safari 15.2 and later have, and runs in a
  module worker, which Firefox has from 114. So a protected CB7 or CBR (and
  an AES zip in bzip2, LZMA or PPMd) needs Chrome 95, Firefox 114 or
  Safari 15.2. In an older browser those fail to open; nothing else is
  affected.
- **No extra CSP.** Like the others, the module is built with
  `-sDYNAMIC_EXECUTION=0` and without Embind, so it needs only
  `'wasm-unsafe-eval'`.

### Why there is no custom worker for zip and libarchive

An earlier design had one worker hosting both back ends. It was dropped:
zip.js already runs its own inflate worker pool and libarchive.js spawns its
own worker internally, so a third layer would have meant nested workers and a
module-federation worker-URL problem for no benefit.

unarr is the exception because it brings no worker of its own. Its worker is
a plain module in `public/`, loaded by URL exactly as the libarchive worker
is, which sidesteps the bundling problem.

### Note on `AppWrapper`

`AppWrapper` inspects the wrapped component's declared props to decide what to
fetch: declaring `currentContent` or `url` makes it GET the entire archive
before the reader runs. `App.vue` therefore declares neither and resolves its
own download URL. This is load-bearing, not tidiness.

## Development

```bash
npm run build:native  # the three WebAssembly decoders; needs podman or docker
npm ci --legacy-peer-deps  # exactly what package-lock.json pins
npm run fixtures      # generate the test archives
npm run build         # or build:w to rebuild on save
docker compose up -d  # OpenCloud at https://localhost:9200 (admin / admin)
npm run test:unit
npm run check:types
```

### Testing

```bash
npm run test:unit          # includes real CBZ decoding, the real unarr and 7-Zip modules,
                           # and the password prompt end to end for zip, 7z and RAR
npm run verify:libarchive  # drives the real WASM decoder over CBR/CB7/C7Z
npm run fixtures:formats   # build the compression matrix (needs 7zip + rar)
npm run verify:formats     # decode every page of every format variant
npm run build:native       # build the three decoders (needs podman or docker)
```

`fixtures:formats` needs `apt-get install 7zip` (free) and `apt-get install
rar` (multiverse, proprietary trialware). It is deliberately separate from
`npm run fixtures`, which stays buildable from free software alone.

The test archives in `tests/fixtures/` are committed, so the tests run without
any archiver installed, and each is built by a script that spells out its
awkward cases: junk entries, nested chapters, non-sequential numbering, a
landscape double-page and a `ComicInfo.xml` with a deleted page.

Most come from `npm run fixtures`, which needs only Python. Its RAR
(`sample.cbr`) is written by `scripts/rar_writer.py`, a minimal RAR4 writer
for stored members, so contributors do not need the proprietary `rar` tool.
The exception is `tests/fixtures/rar/`: four small compressed and solid RAR
archives that only `rar` can produce (`scripts/make-rar-fixtures.sh`). They
cannot be regenerated without it, which is why they in particular are kept.
`tests/fixtures/rar-encrypted/` holds eight small password-protected RAR
archives (password `comic`), made with `rar` by
`scripts/make-rar-encrypted-fixtures.sh` and committed for the same reason.
`tests/fixtures/sevenzip/` holds small password-protected 7z archives
(password `comic`): four made with the free `7zip` package by
`scripts/make-sevenzip-fixtures.sh`, and four without checksums, which
7-Zip will not write, built by hand by
`scripts/make-sevenzip-nocrc-fixture.mjs`. One
trap worth knowing if you extend it: with a Unix host OS byte, libarchive
reads the `ATTR` field as a `st_mode`, so the DOS archive bit `0x20` is not a
regular file and every entry is silently skipped — the archive opens cleanly
and simply lists nothing. The writer declares a Windows host OS, which is also
what essentially every real `.cbr` uses.

The layout cannot be unit tested either: it only means something in a browser.
`docs/fit-rotation-harness.html` is a stand-alone page that lays pages out
exactly as `ReaderViewport.vue` does (a test keeps the two in step), with the
page-turn zones and the unreadable-page placeholder, and checks the result
itself. Open it and use the controls, or run every combination unattended:

```bash
CHROME=/usr/bin/chromium sh scripts/check-harness.sh   # 576 cases
```

The libarchive back end cannot run under happy-dom, since it needs a real
worker and the WASM build. `verify:libarchive` covers it by driving the same
library under Node, where it uses `worker_threads` and exposes an identical
API, with the worker bundled from this app's own libarchive build
(`native/libarchive/`), so what it exercises is the module that ships. That asserts the shapes and lifecycle the adapter depends
on against real CBR, CB7 and C7Z archives.

## Licence

Copyright (C) 2026 GaijinSystems.

Comic Reader is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See `LICENSE` for the full text.

Bundled third-party software and its licences are listed in
`public/THIRD-PARTY-NOTICES.txt`. unarr is LGPL-3.0; its source is in
`native/unarr/`.
