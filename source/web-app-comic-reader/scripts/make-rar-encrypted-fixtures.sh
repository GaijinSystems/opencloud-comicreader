#!/bin/sh
# Regenerates tests/fixtures/rar-encrypted/*.cbr: small password-protected RAR
# archives (password "comic") for the tests of the decryption that makes them
# readable (public/vendor/sevenzip/decrypt-rar.mjs).
#
# Needs two versions of rar, like scripts/make-rar-fixtures.sh: a current one
# for RAR5 (RAR5) and one older than 7.x for RAR4 (RAR4), since version 7
# dropped the -ma4 switch. See that script for where to get the older one.
#
#   RAR4=/opt/rar55/usr/bin/rar RAR5=rar sh scripts/make-rar-encrypted-fixtures.sh
#
# The outputs are committed, because rar is proprietary and running the unit
# tests should not require it.
set -e
RAR4="${RAR4:?set RAR4 to a rar older than 7.x}"
RAR5="${RAR5:-rar}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/rar-encrypted"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT" "$TMP/sub"
python3 - "$TMP" <<'PY'
import struct, sys, zlib
def png(w, h, rgb):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
d = sys.argv[1]
open(d + '/a.png', 'wb').write(png(8, 12, (200, 30, 30)))
open(d + '/b.png', 'wb').write(png(8, 12, (30, 200, 30)))
open(d + '/sub/c.png', 'wb').write(png(8, 12, (30, 30, 200)))
# Compressible, so that the compressed variants really compress something.
open(d + '/notes.txt', 'wb').write(b'a line of notes, repeated\n' * 40)
PY
rm -f "$OUT"/*.cbr
pack() {
  rar="$1"; name="$2"; shift 2
  ( cd "$TMP" && "$rar" a -r "$@" "$OUT/$name" notes.txt a.png b.png sub >/dev/null )
}
# Each container four ways: compressed, stored, solid, and with the headers
# (the file names) encrypted as well.
pack "$RAR4" rar4.cbr          -ma4 -m3 -s- -pcomic
pack "$RAR4" rar4-stored.cbr   -ma4 -m0 -s- -pcomic
pack "$RAR4" rar4-solid.cbr    -ma4 -m5 -s  -pcomic
pack "$RAR4" rar4-headers.cbr  -ma4 -m3 -s- -hpcomic
pack "$RAR5" rar5.cbr          -ma5 -m3 -s- -pcomic
pack "$RAR5" rar5-stored.cbr   -ma5 -m0 -s- -pcomic
pack "$RAR5" rar5-solid.cbr    -ma5 -m5 -s  -pcomic
pack "$RAR5" rar5-headers.cbr  -ma5 -m3 -s- -hpcomic
ls -l "$OUT"
