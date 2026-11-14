#!/bin/sh
# Regenerates tests/fixtures/rar/*.cbr.
#
# Needs a rar older than 7.x: version 7 removed the -ma switch and writes RAR5
# only, so it cannot produce the RAR4 cases at all. Ubuntu still ships 5.50 in
# an earlier release pocket:
#
#   echo "deb http://archive.ubuntu.com/ubuntu jammy multiverse" \
#       > /etc/apt/sources.list.d/jammy-mv.list
#   apt-get update && apt-get download rar=2:5.5.0-1.1
#   dpkg -x rar_*.deb /opt/rar55
#   RAR=/opt/rar55/usr/bin/rar sh scripts/make-rar-fixtures.sh
#
# The outputs are committed, because that binary is proprietary and running the
# unit tests should not require it.
set -e
RAR="${RAR:-rar}"
command -v "$RAR" >/dev/null 2>&1 || { echo "rar not found; set RAR=/path/to/rar (5.x or 6.x)"; exit 1; }
OUT="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/rar"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/sub"
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
open(d + '/notes.txt', 'wb').write(b'x' * 40)
PY
( cd "$TMP" && ln -sf a.png link.png )
rm -f "$OUT"/*.cbr
# -ol stores the symlink as a link rather than following it.
( cd "$TMP" && "$RAR" a -r -ol -ma4 -m3 -s- "$OUT/rar4-plain.cbr" a.png b.png sub notes.txt link.png >/dev/null )
( cd "$TMP" && "$RAR" a -r      -ma4 -m5 -s  "$OUT/rar4-solid.cbr" a.png b.png sub notes.txt >/dev/null )
( cd "$TMP" && "$RAR" a -r      -ma5 -m3 -s- "$OUT/rar5-plain.cbr" a.png b.png sub notes.txt >/dev/null )
( cd "$TMP" && "$RAR" a -r      -ma5 -m5 -s  "$OUT/rar5-solid.cbr" a.png b.png sub notes.txt >/dev/null )
ls -l "$OUT"
