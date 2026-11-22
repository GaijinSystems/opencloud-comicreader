# Security

## Where this runs

**OpenCloud Comic Reader runs entirely in the browser, inside OpenCloud Web.** It has no server
part of its own. OpenCloud loads it into its own page, so it runs with the same origin and the
same session as the rest of OpenCloud: whatever the signed-in user (or the holder of a public
link) may read, the reader may read.

Two things follow from that:

- **It trusts the OpenCloud server and its administrator.** The app's files, its configuration
  and the Content Security Policy all come from the server. Someone who can change those can
  change what the reader does.
- **It does not trust the comics.** An archive may come from anyone: another user's share, a
  public link, a download. Opening one must not be able to do more than show its pages.

## What the design protects

**The page, from what is inside an archive.**

- Only raster images are ever shown as pages (JPEG, PNG, GIF, WebP, AVIF, BMP, and JPEG XL if
  enabled). SVG and HTML are never treated as pages. A page's type is taken from its file
  extension against a fixed list and it is displayed only through an `<img>` element, so
  nothing in an archive is run as script.
- File names and `ComicInfo.xml` metadata are only ever inserted as text. They do not become
  HTML, styles, URLs, storage keys or object property names.
- `ComicInfo.xml` is parsed as XML by the browser and read as text, with a 1 MB limit.

**The tab, from archives built to exhaust it.** These limits apply to every format:

- a file that must be downloaded whole is refused above `maxArchiveSizeMb` (1 GiB by default);
- a page larger than `maxPageSizeMb` (64 MB) is never kept or shown. libarchive refuses a
  single page read by the size the entry declares, and does not unpack in one pass an archive
  in which any entry declares more; zip.js stops decoding at the limit; unarr and the
  7-Zip reader decode such an entry and discard it. The limit is applied again to what was actually decoded;
- an archive may hold at most `maxPages` pages (5,000) and four times that many entries. For
  zip and for solid RAR4 the listing stops there; libarchive lists the whole archive inside
  its worker first, and the result is refused if it is over; the 7-Zip reader also reads the
  whole listing inside its worker, and passes on no more than the limit;
- pages are kept in memory only around the reading position and released behind it.

**The decoders.** Zip is read by JavaScript (zip.js). RAR and 7z are read by libarchive and,
for older solid RAR archives, by unarr; libarchive also takes over a zip that uses a
compression method zip.js lacks. A password-protected 7z is read by 7-Zip's own 7z reader,
and 7-Zip's decryption routines, in the same module, decrypt a password-protected RAR (and
the AES entries of a zip libarchive is to read) before the other decoders see it.
All three are C or C++ libraries compiled to WebAssembly, and each runs in its own worker:

- libarchive is built here to read RAR, 7z and zip and nothing else. As published it accepts
  many more formats (tar, cpio, ISO images) and picks one by looking at the file, so a comic
  could have been a disguised archive of another kind; those readers are not enabled. A
  `.cbr` or `.cb7` whose first bytes are not a RAR, 7z or zip signature is refused before
  it is downloaded in full, where the server lets the reader look at them first;
- a fault in a decoder is confined to its WebAssembly memory. It cannot reach the page, the
  session or other tabs. What a decoder returns (names, sizes, bytes) is still treated as
  untrusted;
- a decoder that stops answering is abandoned after a timeout, and the unarr and 7-Zip
  workers have an overall time limit as well, so a comic cannot hold the reader on a spinner
  forever;
- unarr and the 7-Zip reader stop once an archive has expanded to four times its own size,
  and keep only page images and `ComicInfo.xml`. The 7-Zip reader is not given the archive
  whole: it asks for the parts it reads, and never gets more than it asked for;
- all three modules are built without any use of `eval` or `new Function`. The build fails if
  either word appears in a module's loader, or if the worker bundled around libarchive
  calls either directly. The app
  therefore needs only `'wasm-unsafe-eval'` in the Content Security Policy, which allows
  WebAssembly to be compiled and nothing else.

**The session.** The access token is attached only to requests for OpenCloud's own origin and
the origin of its API server. A download link that points anywhere else is fetched without it.
Tokens and download links are not written to storage or shown in error messages.

**A comic's password.** A password-protected comic is unlocked in the browser tab. The
password is typed into the reader, handed to the decoder, and goes no further: it is not sent
to the server, not written to local storage or anywhere else, not put in a URL, and not
logged. It is asked for again each time the comic is opened. For a CBZ it stays in memory
while the comic is open, because each page read needs it; for a CB7 or CBR it goes to a
worker, which is terminated when the archive has been read or decrypted. Decrypted pages,
and a RAR or zip that was decrypted whole before being read, are held like any other pages
and archives: in the tab's memory, or wherever the browser keeps Blobs, until the comic is
closed. A wrong password is reported as wrong and nothing else is revealed.

**Other accounts on the same browser.** Reading positions are kept in the browser's local
storage, under a key that includes the user, and hold only a file id, a page number and a time.

**What you install.** Nothing on the main branch is a compiled binary (the `gh-pages` branch
holds the built demo site, which is not what you install, and each release holds the built
app). The three decoders are
built from source when you build the app: unarr from the sources in `native/unarr/`, and
libarchive and 7-Zip's 7z reader from release tarballs that must match recorded SHA-256
hashes before they are used. The compiler image is pinned by digest and runs without network
access. All three builds are reproducible: the hashes they must produce are recorded in `native/outputs.sha256`, and
the app's build stops if a decoder does not match them (unless told to go on, with
`DECODERS_UNVERIFIED=1`, for a build made with another compiler) or was built from other
sources than the ones in the tree. JavaScript dependencies are pinned by `package-lock.json`, and the Node
image the README uses for the JavaScript build is named by digest (Node 24 on Alpine).

A release's package is built the same way, by `.github/workflows/release.yml` on GitHub's
runners, from the tagged commit: the decoders must match the recorded hashes, and the tests
must pass, before anything is published. The `.sha256` file published with each archive
shows that a download is complete and unchanged; it does not show who built it. If you would rather rely
on the source alone, build the app yourself. A build of the tagged source should match the
release file for file, apart from the date in `manifest.json`, as `SHA256SUMS` inside the
package lets you check.

## What it does not protect

- **A comic can still crash or slow down its own tab.** The limits above bound memory and
  time; they do not make a hostile archive free. Three gaps are known:
  - libarchive's one-pass unpacking of a solid archive is refused by the sizes the archive
    *declares*. The worker reads each entry into a buffer of the size it declares and no
    more, so the pass allocates what was checked; an archive whose sizes are wrong yields
    truncated, zero-padded or failed entries, and can still cost decoding time up to the
    pass's time limit. What comes back is checked again by its real size.
  - A decoded image can be far larger in pixels than in bytes. The reader relies on the
    browser's own limits for that.
  - A solid archive has to be unpacked in full and held while it is open, which costs roughly
    the comic's unpacked size in memory.
- **The decoders have not been audited by this project.** libarchive, unarr and 7-Zip are used as
  published, at the versions named in `THIRD-PARTY-NOTICES.txt`, apart from the
  marked changes to libarchive.js's C wrapper and one patch to libarchive's two RAR
  readers, so that the checksum of a stored entry is compared (`native/libarchive/patches/`;
  `native/libarchive/README.md` describes both). The WebAssembly boundary is what contains a
  flaw in them, not a review of their code.
- **A compromised OpenCloud page.** The reader shares its page with OpenCloud and every other
  app installed there. Script injected into that page can do everything the user can,
  including to the reader. The reader adds nothing to defend against that, and nothing that
  makes it easier, provided `'unsafe-eval'` is not in the policy (versions before 1.2.0 asked
  for it; this one does not).
- **Redirects on downloads.** If the server answers a download with a redirect to another
  host, the browser follows it. Browsers drop the `Authorization` header when they do, but
  any other header the session sends goes along.
- **The strength of an archive's own encryption.** The reader unlocks password-protected
  comics; how well they were protected is the archive's business. The old zip scheme
  (ZipCrypto) in particular is weak, and the reader opens it all the same.
- **A password while a comic is open.** It is in the tab's memory (see above), where script
  injected into the OpenCloud page could reach it, as it could reach the pages themselves.
- **A shared browser profile.** Reading positions stay in local storage after logout. The next
  person to use the same profile cannot open your files, but can see that an entry exists.
- **The administrator's settings.** `assetBaseUrl` tells the reader where to load its own
  code from. Pointing it at a server you do not control gives that server the ability to run
  script in your OpenCloud.

## Reporting a problem

Please report security problems privately, through **Report a vulnerability** on the
repository's Security tab on GitHub. If that isn't available, open an issue that says only
that you have a security report, without the details, and you will be contacted.

Include the version and build (`manifest.json` in the installed `comic-reader` folder has
both), the browser, what you did, and what happened. A file that reproduces the problem helps
a great deal. Only the latest version gets fixes. This is a small project maintained in spare
time; reports are welcome, and there is no bounty.
