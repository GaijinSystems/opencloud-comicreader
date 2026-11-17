# Contributing

Small fixes and bug reports are welcome. For anything larger, open an issue first so we can
agree on the approach. Security problems go through [SECURITY.md](SECURITY.md), not public
issues.

The app's source is in `source/web-app-comic-reader/`; the commands below run from there.

## Building the decoders first

The three WebAssembly decoders are not in the repository. Build them once after
cloning; it needs podman or docker, and curl for the first run:

```
npm run build:native    # or: sh scripts/build-unarr.sh && sh scripts/build-libarchive.sh && sh scripts/build-sevenzip.sh
```

That compiles unarr from `native/unarr/`, and libarchive and 7-Zip's 7z
reader from pinned, hash-checked release tarballs (`native/libarchive/`,
`native/sevenzip/`), each in an Emscripten
container without network access. It takes a few minutes. The tests, the
build and the verification scripts all need the result.

## Running the checks

With Node (the checks are run with Node 24):

```
npm ci --legacy-peer-deps
npm run build              # bundles the libarchive worker, then builds dist/
npm run test:unit          # unit tests, including the real unarr and 7-Zip modules over fixtures
npm run check:types
npm run verify:libarchive  # drives the libarchive build over CBR, CB7 and C7Z
```

Or in a container, which needs nothing installed but podman (docker works the same way):

```
podman run --rm -v "$PWD":/src:ro -v comic-reader-work:/work \
       docker.io/library/node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 \
    sh -c 'cp -a /src/. /work/ && cd /work && npm ci --legacy-peer-deps &&
           npm run build && npm run test:unit && npm run check:types'
```

The source is mounted read-only; everything is written to the `comic-reader-work` volume.

`npm run verify:formats -- ../../testfiles/formats` decodes every page of every archive in the
compression matrix through the decoder the reader uses for it. For the password-protected ones
it checks that each is recognised as such, decodes in full with its password, and is refused
with a wrong one. Run it after touching anything under
`src/archive/` or `native/`.

`CHROME=/path/to/chromium sh scripts/check-harness.sh` runs the layout harness
(`docs/fit-rotation-harness.html`) in a headless browser over every fit mode, rotation, page
layout and scroll position. Run it after touching `src/components/ReaderViewport.vue`; a unit
test will tell you if the harness needs updating to match.

## Trying it in OpenCloud

`npm run build:w` rebuilds `dist/` on save (a development build: install only what
`npm run build` produces), and `docker compose up -d` starts a development
OpenCloud at https://localhost:9200 with `dist/` mounted as the app. It uses a known admin
password and is published on loopback only; do not expose it.

A change to the Content Security Policy does not reach a tab that is already open. Retest in a
private window.

## The decoders

`native/unarr/` holds unarr's sources and a small C interface;
`native/libarchive/` holds the recipe for libarchive (which sources, their
hashes, how they are compiled, and a small patch to its RAR readers); `native/sevenzip/` holds the recipe and a
small C++ interface for 7-Zip's 7z reader and decryption routines, which read
password-protected 7z and decrypt password-protected RAR.
Each has a README. All three builds are
reproducible, and `native/outputs.sha256` records the hashes they produce.
`npm run build` stops if a built module does not match that list, or was
built from other inputs than the ones now in the tree. If you meant to change
a module, update the list in the same change, and every copy of its hashes:
`public/THIRD-PARTY-NOTICES.txt`, the `NOTICE.txt` in the module's folder under
`public/vendor/` (7-Zip's and unarr's), and `native/libarchive/README.md` for
libarchive.

## Ground rules

- **No new runtime dependencies without discussion.** The app ships zip.js, libarchive.js
  (with libarchive, zlib, liblzma and bzip2 inside its module), unarr and 7-Zip's 7z reader,
  and nothing else.
- **No binaries on main.** Anything compiled is built from source by a script, in a
  container, with its inputs pinned by hash. (The `gh-pages` branch holds the live demo: a
  site built from this source, compiled files included. Releases hold the packaged app.)
- **Nothing that needs `'unsafe-eval'`.** The app must work under a Content Security Policy
  that adds only `'wasm-unsafe-eval'`.
- **Archives are untrusted.** Anything read from one is bounded (size, count, time) and
  reaches the page only as text or as a raster image. A new format or decoder comes with its
  limits and with tests for them.
- **The UI does not know which decoder it got.** Format handling stays behind the
  `ArchiveAdapter` interface in `src/archive/types.ts`.
- **Layout that matters is written as inline styles, not utility classes.** The app has no
  CSS compiler of its own; a class works only if OpenCloud happens to use it too, and a
  missing one fails silently. The README explains this at length.
- **Every change comes with tests.** A bug fix starts with a test that fails without it.
- **Style:** follow the code around you. Comments say why, not what. Documentation is in
  plain, direct English.
- **README.md describes current behaviour;** update it in the same change, and add a line to
  `CHANGELOG.md`.

## Releasing

`.github/workflows/release.yml` tests every push to main. A version tag builds, tests and
packages the app, publishes it as a GitHub release, and rebuilds the live demo from the
tagged source.

1. In one commit, set the new version in `package.json` and `package-lock.json`
   (`npm version 1.2.3 --no-git-tag-version`), on the first line of `public/INSTALL.txt`,
   in the download commands in the repository's `README.md`, and as a
   `## 1.2.3 — <date>` section of `CHANGELOG.md`, which becomes the release notes. Copy
   `CHANGELOG.md` to the repository's `docs/CHANGELOG.md`.
   `sh scripts/release-notes.sh` checks that they all agree and prints the notes; the
   workflow runs it on every push.
2. Push main and let its run pass.
3. `git tag v1.2.3 && git push origin v1.2.3`

The package is made by `sh scripts/package.sh dist <folder>`, which gives the same bytes
for the same build of the same commit. Release tags cannot be moved or deleted. If a run
fails after the release was created, fix the cause and use "Re-run failed jobs"; a fix
that needs a change on main needs a new version.

## License

By contributing you agree that your contribution is licensed under the
[GNU AGPL, version 3 or later](LICENSE), like the rest of the project.
