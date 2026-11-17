OpenCloud Comic Reader — test files
===================================

Four archives, identical contents, one per supported format. Upload them to
OpenCloud and click each one.

  test-comic.cbz    zip, deflate
  test-comic.cb7    7z, LZMA2
  test-comic.c7z    7z, LZMA2  (same container, different extension)
  test-comic.cbr    RAR4, STORED  -- see the caveat below

Each has 6 numbered pages plus a ComicInfo.xml and two junk members.


WHAT TO LOOK FOR
----------------
Pages are labelled "Test Page N of 6", so the screen tells you whether the
reader is behaving:

1. Order. Pages must read 1,2,3,4,5,6. The fifth page is named page10.png on
   purpose: if it appears second, the natural sort has regressed to lexical.

2. The wide page. Page 3 is 1600x1200 landscape, and ComicInfo also flags it
   DoublePage. In two-page mode (press 'd') it must occupy a row by itself,
   never paired. Everything after it should re-pair cleanly.

3. Junk filtering. Exactly 6 pages, never 7 or 8. The archives contain
   __MACOSX/pages/._page01.png and readme.txt, which must not appear.

4. Metadata. The title bar should show "Comic Reader Test #1", read from
   ComicInfo.xml, not the file name.

5. Reading direction. Press 'r' for right-to-left: within a two-page row the
   page numbers should swap sides, but the sequence of rows must not reverse.

6. Rotation. Page 3 is the wide one. Press 'v' (or the rotate button, right
   of zoom) to cycle 0 -> 90 -> 180 -> 270. At 90 and 270 two-page view is
   suspended, and the two-page button's tooltip says why; it returns at 0 and
   180. Rotation survives page turns and resets when you close the comic.

Keys: arrows / space page turn, 'f' zoom mode, 'd' two-page, 'r' direction,
'v' rotate, 't' page strip, Home/End first/last.


IF CBZ WORKS BUT THE OTHERS DO NOT
----------------------------------
That is the CSP. The RAR and 7z decoders are WebAssembly builds and need
'wasm-unsafe-eval' in script-src; the zip path does not. See INSTALL.txt
in the app folder. Retest in a private window: a policy change does not
reach a tab that is already open.


CAVEAT ON THE .cbr
------------------
test-comic.cbr is a valid RAR4 archive, but its members are STORED rather
than compressed, because it is built without the proprietary rar tool. So it
exercises the RAR container parsing and the libarchive worker, but not RAR's
decompressor.

The files in formats/ cover what it does not: RAR4 and RAR5, each stored,
compressed and solid, plus password-protected variants of every container
(see formats/README.txt). A real-world .cbr is still worth more than any of
them.
