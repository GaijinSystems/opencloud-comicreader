#!/usr/bin/env python3
"""
Builds a readable test comic in every format the reader supports.

Each page says what it is, so a glance at the screen tells you whether page
order, spread pairing and reading direction are behaving. The page set is
chosen to exercise the parts most likely to break rather than to be minimal:

  1  cover              portrait, sorts first
  2  portrait
  3  WIDE landscape     must take a row of its own in two-page mode and
                        re-phase every spread after it
  4  portrait
  5  portrait           filename numbered 10 to catch lexical sorting
                        ("page10" must come after "page4", not after "page1")
  6  final page

Plus a ComicInfo.xml (series, number, a bookmark, page 3 flagged DoublePage)
and two junk members that must never appear as pages.

Formats and their compression, which is the point of having four files:
  .cbz   zip, deflate
  .cb7   7z, LZMA2
  .c7z   7z, LZMA2      (same container, different extension)
  .cbr   RAR4, STORED   <- see the caveat printed at the end
"""

import io
import os
import struct
import sys
import zipfile

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import py7zr
from rar_writer import write_rar

OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "testcomics"))

PORTRAIT = (800, 1200)
LANDSCAPE = (1600, 1200)

FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]

PALETTE = [
    (198, 40, 40),
    (21, 101, 192),
    (46, 125, 50),
    (245, 124, 0),
    (106, 27, 154),
    (0, 131, 143),
]


def font(size):
    for path in FONT_PATHS:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def centered(draw, box, lines, fill):
    """Draws lines centred both horizontally and vertically inside box."""
    width, height = box
    rendered = []
    for text, size in lines:
        f = font(size)
        left, top, right, bottom = draw.textbbox((0, 0), text, font=f)
        rendered.append((text, f, right - left, bottom - top, top))

    gap = 28
    total = sum(item[3] for item in rendered) + gap * (len(rendered) - 1)
    y = (height - total) // 2

    for text, f, w, h, top in rendered:
        # textbbox's top offset has to be subtracted, or ascender space pushes
        # the text visibly below centre.
        draw.text(((width - w) // 2, y - top), text, font=f, fill=fill)
        y += h + gap


def page(number, total, size, label, colour):
    image = Image.new("RGB", size, (250, 250, 248))
    draw = ImageDraw.Draw(image)

    # Border, so fit-to-page vs fit-to-width is obvious at a glance.
    draw.rectangle([(6, 6), (size[0] - 7, size[1] - 7)], outline=colour, width=6)

    centered(
        draw,
        size,
        [
            ("Test Page", 96 if size == PORTRAIT else 120),
            (f"{number} of {total}", 64),
            (label, 40),
            (f"{size[0]} x {size[1]}", 30),
        ],
        colour,
    )

    # Corner markers make it obvious which page is on which side in a spread.
    corner = font(34)
    draw.text((28, 24), f"#{number}", font=corner, fill=colour)
    right_text = f"#{number}"
    left, top, right, bottom = draw.textbbox((0, 0), right_text, font=corner)
    draw.text((size[0] - (right - left) - 28, 24), right_text, font=corner, fill=colour)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


COMIC_INFO = """<?xml version="1.0"?>
<ComicInfo>
  <Series>Comic Reader Test</Series>
  <Number>1</Number>
  <Title>Format and layout check</Title>
  <Writer>Generated</Writer>
  <PageCount>6</PageCount>
  <Pages>
    <Page Image="0" Type="FrontCover" />
    <Page Image="2" DoublePage="true" Bookmark="The wide page" />
  </Pages>
</ComicInfo>
"""


def members():
    total = 6
    specs = [
        ("pages/page01.png", 1, PORTRAIT, "cover"),
        ("pages/page02.png", 2, PORTRAIT, "portrait"),
        ("pages/page03.png", 3, LANDSCAPE, "WIDE - should sit alone"),
        ("pages/page04.png", 4, PORTRAIT, "portrait"),
        ("pages/page10.png", 5, PORTRAIT, "named 10, sorts 5th"),
        ("pages/page11.png", 6, PORTRAIT, "final page"),
    ]
    result = {}
    for index, (name, number, size, label) in enumerate(specs):
        result[name] = page(number, total, size, label, PALETTE[index % len(PALETTE)])

    result["ComicInfo.xml"] = COMIC_INFO.encode("utf-8")
    # Junk that must be filtered out. If either shows up as a page, the
    # filtering in pageSort.ts has regressed.
    result["__MACOSX/pages/._page01.png"] = b"resource fork, not a page"
    result["readme.txt"] = b"not a page either"
    return result


def main():
    os.makedirs(OUT, exist_ok=True)
    data = members()

    with zipfile.ZipFile(os.path.join(OUT, "test-comic.cbz"), "w", zipfile.ZIP_DEFLATED) as archive:
        for name, blob in data.items():
            archive.writestr(name, blob)

    for extension in ("cb7", "c7z"):
        with py7zr.SevenZipFile(os.path.join(OUT, f"test-comic.{extension}"), "w") as archive:
            for name, blob in data.items():
                archive.writef(io.BytesIO(blob), name)

    write_rar(os.path.join(OUT, "test-comic.cbr"), data)

    print(f"Written to {OUT}\n")
    for name in sorted(os.listdir(OUT)):
        size = os.path.getsize(os.path.join(OUT, name))
        print(f"  {name:22s} {size / 1024:7.1f} KB")

    print(
        "\nNote on the .cbr: it is a valid RAR4 archive but its members are\n"
        "STORED, not compressed. Building a compressed RAR needs the\n"
        "proprietary rar tool. So this file exercises the RAR container\n"
        "parsing and the libarchive worker, but not RAR's decompressor, and\n"
        "it is not a substitute for testing a real-world RAR5 comic."
    )


if __name__ == "__main__":
    main()
