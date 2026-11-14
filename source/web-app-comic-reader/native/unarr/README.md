# unarr, compiled to WebAssembly

The reader's second RAR back end. libarchive cannot read solid RAR4 archives;
[unarr](https://github.com/selmf/unarr) can, and this directory is everything
needed to build the module shipped in `public/vendor/unarr/`.

| Path | What it is |
| --- | --- |
| `upstream/` | unarr at commit `df462f20a449ced3dd840ae7197d86d28ac5cfe3` (version 1.2.0 plus the development commits after it), unmodified. Only `common/`, `rar/` and `lzmasdk/` are kept, since only the RAR reader is compiled. LGPL-3.0; see `upstream/COPYING` and `upstream/AUTHORS`. |
| `upstream.sha256` | SHA-256 of every file under `upstream/`. `sha256sum -c upstream.sha256` here, or against a checkout of that commit, shows the sources are what they claim to be. |
| `glue.c` | The C interface exported to JavaScript: open, next entry, name, size, read, close. Plain exported functions, no Embind. One of them, `cr_entry_finish`, reaches into the decoder: for a solid archive that was encrypted and has been decrypted by the app (`public/vendor/sevenzip/decrypt-rar.mjs`), it makes unarr start each entry with an empty read-ahead, as RAR's own unpacker does. Without it the cipher's padding at the end of one entry is decoded as the start of the next. |
| `build.sh` | The compile command. Runs inside the Emscripten container, and first checks `upstream/` against `upstream.sha256`. |
| `build-inputs.txt` | The files the output depends on, including the pinned compiler in `scripts/lib/emsdk.sh`. Their hashes make up the build stamp, written to `BUILD-STAMP` (not committed). |

## Building

    sh scripts/build-unarr.sh    # from source/web-app-comic-reader

It needs podman or docker and nothing else. The outputs
(`public/vendor/unarr/unarr-rar.mjs` and `unarr-rar.wasm`) are not committed,
so run it once after cloning, and again after changing `glue.c` or updating
`upstream/`: `npm run build` refuses a module whose stamp no longer matches
the tree. The build is reproducible: the script pins the Emscripten 7.0.0
image by digest, runs it without network access, and lets it write only to a
scratch directory; the two outputs are then copied into place. It yields the
hashes recorded in `../outputs.sha256`, which `npm run build` checks the
built files against. If they change, update that file, and the copies in
`public/vendor/unarr/NOTICE.txt` and `public/THIRD-PARTY-NOTICES.txt`.

## Two things the build guarantees

- **No dynamic code evaluation.** It is compiled with `-sDYNAMIC_EXECUTION=0`
  and without Embind, and `build.sh` fails if the generated loader contains
  the words `eval` or `Function` at all. The module therefore needs `'wasm-unsafe-eval'`
  in the page's CSP, which libarchive already requires, and nothing more.
- **Only the RAR reader.** zip, tar and 7z are left out; other back ends cover
  those.

## Updating unarr

Replace `upstream/` with the same subset of a newer checkout, regenerate
`upstream.sha256` (`find upstream -type f | LC_ALL=C sort | xargs sha256sum`),
rebuild, then run
`npm run test:unit` (which drives the real module over the RAR fixtures) and
`npm run verify:formats`.
