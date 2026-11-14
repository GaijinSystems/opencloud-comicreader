#!/usr/bin/env python3
"""
Builds the comic archives the unit tests read.

Fixtures are generated rather than committed as binaries so the awkward cases
stay visible and editable: junk entries, nested chapters, non-sequential
numbering, a landscape double-page, and a ComicInfo.xml with a deleted page.

RAR is emitted by `rar_writer.py`, a minimal RAR4 writer for stored members.
It exists because the proprietary `rar` tool is not something a contributor
should need in order to run the tests.
"""

import io
import os
import sys
import struct
import zlib
import zipfile

import py7zr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from rar_writer import write_rar  # noqa: E402
FIXTURES = os.path.abspath(os.path.join(HERE, "..", "tests", "fixtures"))


def png(width: int, height: int, rgb: tuple) -> bytes:
    """Smallest valid PNG of a solid colour, built without a image library."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(
        b"\x00" + bytes(rgb) * width for _ in range(height)
    )  # filter byte 0 per scanline
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


COMIC_INFO = """<?xml version="1.0"?>
<ComicInfo>
  <Series>Fixture Comic</Series>
  <Number>1</Number>
  <PageCount>4</PageCount>
  <Pages>
    <Page Image="0" Type="FrontCover" />
    <Page Image="2" DoublePage="true" Bookmark="The big reveal" />
    <Page Image="4" Type="Deleted" />
  </Pages>
</ComicInfo>
"""

# Deliberately awkward: out-of-order numbering, a nested chapter, macOS junk,
# a landscape page, a non-image member, and mixed-case extensions.
MEMBERS = {
    "Chapter 1/page1.png": png(8, 12, (200, 30, 30)),
    "Chapter 1/page2.PNG": png(8, 12, (30, 200, 30)),
    "Chapter 1/page10.png": png(24, 12, (30, 30, 200)),  # landscape: a spread
    "Chapter 2/page1.jpg": png(8, 12, (200, 200, 30)),  # mislabelled on purpose
    "Chapter 2/page2.png": png(8, 12, (200, 30, 200)),
    "ComicInfo.xml": COMIC_INFO.encode("utf-8"),
    "notes.txt": b"not a page",
    "__MACOSX/Chapter 1/._page1.png": b"resource fork junk",
    "Thumbs.db": b"junk",
}


def write_7z(path: str) -> None:
    with py7zr.SevenZipFile(path, "w") as archive:
        for name, data in MEMBERS.items():
            archive.writef(io.BytesIO(data), name)


def write_zip(path: str, method: int = zipfile.ZIP_DEFLATED) -> None:
    """
    The fixture members as a zip, deflate by default.

    With bzip2 or LZMA it uses a method zip.js cannot decode on its own. Those
    are not broken archives: the reader hands them to libarchive. They exist
    so the detection that triggers that handover stays tested.

    Python's zipfile writes bzip2 and LZMA natively, so these need no external
    tool. deflate64 cannot be produced this way; that variant lives in the
    format matrix instead and its test skips when absent.
    """
    with zipfile.ZipFile(path, "w", method) as archive:
        for name, data in MEMBERS.items():
            archive.writestr(name, data)


def write_empty_zip(path: str) -> None:
    """A comic with no images at all, for the 'no pages' error path."""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("readme.txt", b"no images here")


def main() -> None:
    os.makedirs(FIXTURES, exist_ok=True)
    write_zip(os.path.join(FIXTURES, "sample.cbz"))
    write_rar(os.path.join(FIXTURES, "sample.cbr"), MEMBERS)
    # The same members under the password "comic", encrypted the way RAR 2.x
    # did it, before AES. scripts/check-rar2-fixture.sh checks it with unrar.
    write_rar(os.path.join(FIXTURES, "rar2-encrypted.cbr"), MEMBERS, "comic")
    # One stored file of a single byte, the same way: its checksum is too
    # little to confirm a password by, which is what the test of it checks.
    write_rar(os.path.join(FIXTURES, "rar2-tiny.cbr"), {"p.png": b"\x89"}, "comic")
    write_7z(os.path.join(FIXTURES, "sample.cb7"))
    write_7z(os.path.join(FIXTURES, "sample.c7z"))
    write_empty_zip(os.path.join(FIXTURES, "no-pages.cbz"))

    methods = os.path.join(FIXTURES, "zipmethods")
    os.makedirs(methods, exist_ok=True)
    write_zip(os.path.join(methods, "bzip2.cbz"), zipfile.ZIP_BZIP2)
    write_zip(os.path.join(methods, "lzma.cbz"), zipfile.ZIP_LZMA)

    for root, _, files in os.walk(FIXTURES):
        if "vendor" in root:
            continue
        for name in sorted(files):
            rel = os.path.relpath(os.path.join(root, name), FIXTURES)
            size = os.path.getsize(os.path.join(root, name))
            print(f"{rel:32s} {size:>7d} bytes")


if __name__ == "__main__":
    main()
