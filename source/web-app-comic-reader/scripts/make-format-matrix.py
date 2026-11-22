#!/usr/bin/env python3
"""
Builds the format matrix that the hand-rolled fixtures could not cover.

scripts/rar_writer.py emits RAR4 with STORED members, which exercises the
container parsing but never runs RAR's decompressor. Likewise py7zr defaults
leave BCJ2 and solid-block behaviour untested. Those are exactly the paths
real comics use, so this script drives the actual archivers instead.

Requires (Debian/Ubuntu):
    apt-get install 7zip       # universe, genuinely free software
    apt-get install rar        # multiverse, PROPRIETARY RARLAB trialware

The rar dependency is the reason this is a separate script rather than part
of `npm run fixtures`: the unit-test fixtures must stay buildable from free
software alone. These outputs are for manual verification.
"""

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

OUT = os.path.abspath(os.path.join(HERE, "..", "testcomics", "formats"))

# Reuse the same six labelled pages the readable test comic uses, so the
# on-screen check is identical across every format.
from importlib.machinery import SourceFileLoader

from rar_writer import write_rar  # noqa: E402

maker = SourceFileLoader("maketc", os.path.join(HERE, "make-test-comics.py")).load_module()


def staged(tmp):
    """Writes the comic members to a directory for the archivers to consume."""
    for name, blob in maker.members().items():
        path = os.path.join(tmp, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(blob)


def run(cmd, cwd):
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if result.returncode not in (0, 1):  # rar returns 1 for warnings
        raise SystemExit(f"{' '.join(cmd)}\n{result.stdout}\n{result.stderr}")


# (filename, description, argv). Paths are filled in per-run.
# RAR 7.x removed the -ma switch and writes RAR5 only. RAR4 variants therefore
# need an older rar, which Ubuntu still ships in an earlier release pocket:
#
#   echo "deb http://archive.ubuntu.com/ubuntu jammy multiverse" \
#       > /etc/apt/sources.list.d/jammy-mv.list
#   apt-get update && apt-get download rar=2:5.5.0-1.1
#   dpkg -x rar_*.deb /opt/rar55
#   RAR4_BIN=/opt/rar55/usr/bin/rar python3 scripts/make-format-matrix.py
#
# Without RAR4_BIN the RAR4 variants are skipped and the rest still build.

# Every password-protected variant uses this password. The reader asks for
# it and opens each of them.
PASSWORD = "comic"

RAR4_VARIANTS = [
    ("rar4-store.cbr", "RAR4, stored", ["-ma4", "-m0", "-s-"]),
    ("rar4-compressed.cbr", "RAR4, normal compression, non-solid", ["-ma4", "-m3", "-s-"]),
    ("rar4-solid.cbr", "RAR4, SOLID - read by unarr, not libarchive", ["-ma4", "-m5", "-s"]),
    ("rar4-encrypted.cbr", "RAR4, password protected", ["-ma4", "-m3", "-s-", f"-p{PASSWORD}"]),
    (
        "rar4-solid-encrypted.cbr",
        "RAR4, SOLID and password protected",
        ["-ma4", "-m5", "-s", f"-p{PASSWORD}"],
    ),
    (
        "rar4-encrypted-headers.cbr",
        "RAR4, password protected, file names encrypted too",
        ["-ma4", "-m3", "-s-", f"-hp{PASSWORD}"],
    ),
]

RAR_VARIANTS = [
    ("rar5-store.cbr", "RAR5, stored (no compression)", ["-m0", "-s-"]),
    ("rar5-compressed.cbr", "RAR5, normal compression, non-solid", ["-m3", "-s-"]),
    ("rar5-solid.cbr", "RAR5, best compression, solid block", ["-m5", "-s"]),
    ("rar5-encrypted.cbr", "RAR5, password protected", ["-m3", "-s-", f"-p{PASSWORD}"]),
    (
        "rar5-encrypted-headers.cbr",
        "RAR5, password protected, file names encrypted too",
        ["-m3", "-s-", f"-hp{PASSWORD}"],
    ),
]

# Written here, by scripts/rar_writer.py, with no archiver: no current rar
# encrypts the way RAR 2.x did.
RAR2_VARIANT = (
    "rar2-encrypted.cbr",
    "RAR 2.x encryption (from before AES), stored - made by rar_writer.py",
)

# Zip is the format most comics actually use, and the only one handled by
# zip.js rather than libarchive, so its methods need their own coverage.
# zip.js implements store, deflate and deflate64. The rest are included to
# exercise the libarchive fallback, which the reader uses when zip.js reports
# a method it cannot decode. All of them open.
ZIP_VARIANTS = [
    ("zip-store.cbz", "Stored, no compression", ["-mm=Copy"]),
    ("zip-deflate.cbz", "Deflate (what almost every CBZ uses)", ["-mm=Deflate"]),
    ("zip-deflate64.cbz", "Deflate64", ["-mm=Deflate64"]),
    ("zip-bzip2.cbz", "BZip2 - needs the libarchive fallback", ["-mm=BZip2"]),
    ("zip-lzma.cbz", "LZMA - needs the libarchive fallback", ["-mm=LZMA"]),
    ("zip-ppmd.cbz", "PPMd - needs the libarchive fallback", ["-mm=PPMd"]),
    (
        "zip-encrypted-zipcrypto.cbz",
        "Password protected, ZipCrypto (the old zip scheme)",
        ["-mm=Deflate", "-mem=ZipCrypto", f"-p{PASSWORD}"],
    ),
    (
        "zip-encrypted-aes256.cbz",
        "Password protected, AES-256",
        ["-mm=Deflate", "-mem=AES256", f"-p{PASSWORD}"],
    ),
    (
        "zip-encrypted-zipcrypto-bzip2.cbz",
        "Password protected, ZipCrypto, BZip2 - libarchive, with the password",
        ["-mm=BZip2", "-mem=ZipCrypto", f"-p{PASSWORD}"],
    ),
    (
        "zip-encrypted-aes256-bzip2.cbz",
        "Password protected, AES-256, BZip2 - decrypted, then libarchive",
        ["-mm=BZip2", "-mem=AES256", f"-p{PASSWORD}"],
    ),
]

SEVENZIP_VARIANTS = [
    ("7z-lzma2-solid.cb7", "LZMA2, solid (the 7z default)", ["-m0=LZMA2", "-ms=on"]),
    ("7z-lzma2-nonsolid.cb7", "LZMA2, non-solid", ["-m0=LZMA2", "-ms=off"]),
    ("7z-bcj2.cb7", "BCJ2 filter chain", ["-m0=BCJ2", "-m1=LZMA:d=21", "-ms=on"]),
    ("7z-lzma1.c7z", "LZMA1, solid", ["-m0=LZMA", "-ms=on"]),
    ("7z-ppmd.c7z", "PPMd", ["-m0=PPMd", "-ms=on"]),
    ("7z-encrypted.cb7", "Password protected, file names readable", [f"-p{PASSWORD}"]),
    (
        "7z-encrypted-headers.cb7",
        "Password protected, file names encrypted too",
        [f"-p{PASSWORD}", "-mhe=on"],
    ),
]


README = """Compression format matrix
=========================

Same six labelled pages as ../test-comic.*, packed with every compression
method the reader is likely to meet, plus password-protected variants of each
container. Generated by scripts/make-format-matrix.py; this file is rewritten
on every run.

Verify with:  npm run verify:formats -- <this folder>

Each file is checked through the back end the reader actually uses for it:
zip.js for .cbz (then libarchive for methods zip.js lacks), the libarchive
WASM build for .cbr/.cb7/.c7z, unarr for the solid RAR4 that libarchive
cannot read, 7-Zip's 7z reader for the password-protected 7z files, and
7-Zip's decryption for the password-protected RAR files and AES zips.

{listing}

WHAT TO LOOK FOR
----------------
Everything in ../README.txt applies to each file. Three extra things:

1. The solid archives (rar5-solid, and the 7z ones marked solid). Reaching
   page N in a solid archive means decompressing everything before it. The
   reader detects the latency and switches to unpacking the whole archive in
   one pass, showing "Unpacking the rest of this comic...". Jumping straight
   to the last page with the slider is the harshest test.

   rar4-solid.cbr takes a different route: libarchive cannot read it, so the
   reader hands it to a second decoder, unarr. It should open like any other
   file, all six pages. A "Solid RAR archive" error, or a banner saying items
   could not be read, means that hand-over has failed; the browser console
   will say why.

2. 7z-bcj2.cb7. BCJ2 is a branch-filter chain and was the variant most likely
   to be missing from the WASM build. It decodes, so it should simply work.

3. zip-bzip2.cbz, zip-lzma.cbz and zip-ppmd.cbz. zip.js cannot decode these,
   so the reader hands them to libarchive instead. They should open normally,
   all six pages. An "Unsupported compression" screen means the fallback has
   regressed. These need WebAssembly, so they also fail if the CSP lacks
   'wasm-unsafe-eval'.


PASSWORD-PROTECTED FILES
------------------------
The files with "encrypted" in their name are protected with the password
"comic". Every one of them, in every format, must do the same thing: open to
a screen with a password field and a download button, and then

  - with "comic", open, all six pages;
  - with anything else, bring the field back with "That password did not
    open this comic", after which "comic" works. The file is not downloaded
    again between attempts.

None may show "No pages found", a book of unreadable pages, or a spinner
that never ends.

They differ in how the reader finds out, and in what reads them:

  zip-encrypted-aes256, zip-encrypted-zipcrypto
                               zip.js sees the flag on each entry, and
                               decrypts.
  zip-encrypted-zipcrypto-bzip2
                               its pages are in a method zip.js cannot
                               decode, so the reader hands it to libarchive
                               with the password, which undoes the old zip
                               encryption itself.
  zip-encrypted-aes256-bzip2   the same, but libarchive cannot undo AES: the
                               entries are decrypted first, and libarchive
                               is given the zip without them encrypted.
  rar4-encrypted, rar4-solid-encrypted
                               the reader sees the flag in the archive's own
                               headers, before starting a decoder. With the
                               password the archive is decrypted, and then
                               read by the second RAR decoder. RAR4 keeps
                               nothing to check a password by, so a wrong
                               one is found out when no page decodes.
  rar2-encrypted               the same, in the cipher RAR used before AES
                               (RAR 2.x, 1996 to 2002). Its pages are
                               stored, and their checksums say at once
                               whether the password was right.
  rar5-encrypted, and the rar *-headers files
                               the decoder reports it when the file is
                               opened. With the password the archive is
                               decrypted (headers too), and then read as any
                               other. A wrong password is refused at once.
  7z-encrypted.cb7             the awkward one. Its file names are readable,
                               the decoder's check at open says "not
                               encrypted", and the truth only comes out when
                               something is read. The reader catches that on
                               the first read and asks for the password then.
  7z-encrypted-headers.cb7     the decoder reports it when the file is
                               opened. Both 7z files are then read by 7-Zip's
                               own 7z reader.

In the *-headers files the file names are encrypted as well, so the archive
cannot even be listed without the password.


RAR4
----
RAR 7.x removed the -ma switch and writes RAR5 only, so the rar4-* files are
built with an older rar named by RAR4_BIN (see scripts/make-format-matrix.py).
They are skipped, and absent from the listing above, when it is not set.


PROVENANCE
----------
    apt-get install 7zip    universe, free software (LGPL)
    apt-get install rar     multiverse, PROPRIETARY RARLAB trialware

The rar dependency is why this is separate from `npm run fixtures`: the unit
test fixtures stay buildable from free software alone.
"""


def main():
    if not shutil.which("7z"):
        raise SystemExit("7z not found:  apt-get install 7zip")
    have_rar = bool(shutil.which("rar"))

    os.makedirs(OUT, exist_ok=True)
    # Everything already there is rebuilt, so that a variant removed from the
    # tables above does not linger. KEEP_FILES=a.cbr,b.cbr spares the named
    # files, for ones this machine cannot rebuild (the RAR4 set needs an old
    # rar; see RAR4_BIN above).
    keep = set(os.environ.get("KEEP_FILES", "").split(","))
    for stale in os.listdir(OUT):
        if stale not in keep:
            os.remove(os.path.join(OUT, stale))

    with tempfile.TemporaryDirectory() as tmp:
        staged(tmp)
        contents = ["pages", "ComicInfo.xml", "readme.txt", "__MACOSX"]

        for name, _, flags in ZIP_VARIANTS:
            run(["7z", "a", "-tzip", *flags, os.path.join(OUT, name), *contents], cwd=tmp)

        for name, _, flags in SEVENZIP_VARIANTS:
            run(["7z", "a", "-t7z", *flags, os.path.join(OUT, name), *contents], cwd=tmp)

        if have_rar:
            for name, _, flags in RAR_VARIANTS:
                run(["rar", "a", "-r", *flags, os.path.join(OUT, name), *contents], cwd=tmp)
        else:
            print("rar not installed, skipping RAR5 variants (apt-get install rar)\n")

        # Independent of the rar on PATH: RAR4_BIN names its own binary.
        rar4 = os.environ.get("RAR4_BIN")
        if rar4 and os.path.exists(rar4):
            for name, _, flags in RAR4_VARIANTS:
                run([rar4, "a", "-r", *flags, os.path.join(OUT, name), *contents], cwd=tmp)
        else:
            print("RAR4_BIN not set, skipping RAR4 variants (see comments above)\n")

    write_rar(os.path.join(OUT, RAR2_VARIANT[0]), maker.members(), PASSWORD)

    descriptions = {
        n: d for n, d, _ in ZIP_VARIANTS + SEVENZIP_VARIANTS + RAR_VARIANTS + RAR4_VARIANTS
    }
    descriptions[RAR2_VARIANT[0]] = RAR2_VARIANT[1]
    lines = []
    for name in sorted(os.listdir(OUT)):
        size = os.path.getsize(os.path.join(OUT, name))
        lines.append(f"  {name:30s} {size / 1024:7.1f} KB   {descriptions.get(name, '')}")

    # Written last so it survives the directory being cleared each run.
    with open(os.path.join(OUT, "README.txt"), "w") as handle:
        handle.write(README.format(listing="\n".join(lines)))

    print(f"Written to {OUT}\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
