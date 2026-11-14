RAR parser fixtures
===================

Small archives for src/archive/rar4.ts. NOT comics — the images are 8x12
pixels and there is nothing to look at. Do not put these in testfiles/.

  rar4-plain.cbr   RAR4, compressed, non-solid. Contains a SYMLINK, which
                   libarchive does not surface; the header count must exclude
                   it or the reader warns about an intact archive.
  rar4-solid.cbr   RAR4, SOLID. libarchive enumerates 1 of 4 entries. This is
                   the detector's only true-positive case.
  rar5-plain.cbr   RAR5. inspectRar4 must return null: different container.
  rar5-solid.cbr   RAR5 solid. libarchive handles it correctly, so nothing to
                   detect.

Regenerate with scripts/make-rar-fixtures.sh, which needs an older rar (7.x
dropped -ma4). They are committed because that binary is proprietary and not
something running the unit tests should require.

These replaced four CC0 files from ssokolow/rar-test-files plus one from
libarchive's corpus. Those worked, but carried third-party licences for test
data we can generate ourselves, and their 2x2-pixel contents caused real
confusion when they were mistakenly shipped as sample comics.
