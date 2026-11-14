# Solid RAR support

Solid RAR archives open with no configuration. This note explains how, and
what changed in 1.2.0.

## What happens

| Archive | Decoder |
| --- | --- |
| RAR5, solid or not | libarchive |
| RAR4, not solid | libarchive |
| RAR4, solid | unarr |

libarchive cannot read solid RAR4: it lists the first entry of a solid block
and stops, so a six-page comic yields no pages. The reader notices, by
counting the entries the container itself declares, and hands the archive to
[unarr](https://github.com/selmf/unarr), which reads it in full.

Check it with `testfiles/formats/rar4-solid.cbr`: six pages.

## What it needs

Nothing beyond what CBR already needs: `'wasm-unsafe-eval'` in `script-src`.
The unarr module is in `vendor/unarr/` inside the app folder and is loaded
only when it is needed: for a solid RAR4, or for a RAR4 that libarchive
rejects.

## Upgrading from 1.1.2 or earlier

Those versions used RARLAB's UnRAR for solid RAR4, which needed `'unsafe-eval'`
in `script-src`. If you added it for Comic Reader, remove it:

- HAProxy: delete the second `http-response replace-header` rule and the
  `csp_has_eval` acl that came with the old snippet.
- `csp.yaml`: delete the `"'unsafe-eval'"` line under `script-src`.

Also remove any `unrarModuleUrl` / `unrarWasmUrl` settings from `apps.yaml`;
they are no longer read. Replace the app folder rather than copying over it,
so the old `vendor/unrar/` does not linger.

## Limits

- Multi-volume RAR archives are not supported. (Password-protected RAR
  archives were not either when this was written; since 1.2.2 they are
  decrypted first and then read as described here.)
- A solid archive is decoded in one pass and held while it is open, so it
  costs roughly the comic's unpacked size, on top of the archive itself.
- Decoding stops if the archive expands to more than four times its own size,
  lists more than four times the page limit, or takes longer than 60 seconds
  plus a second per megabyte. Pages past that point show as unreadable, and a
  banner says how many entries were never reached.
- In a solid archive a damaged page takes every later page with it, because
  each depends on the one before. In a non-solid archive it costs only itself.

## Licence

unarr is LGPL-3.0, which is compatible with Comic Reader's AGPL-3.0-or-later,
so the build is freely redistributable. Its source and the script that builds
the WebAssembly module from it are in `native/unarr/` in the source package;
see `vendor/unarr/NOTICE.txt`.
