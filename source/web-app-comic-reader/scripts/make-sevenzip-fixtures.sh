#!/bin/sh
# Regenerates tests/fixtures/sevenzip: the pages of tests/fixtures/sample.cb7,
# repacked as password-protected 7z archives for the 7-Zip decoder's tests.
# The password is "comic".
#
# Needs the 7z command of the free 7zip package (Debian/Ubuntu: apt-get
# install 7zip). The outputs are committed, so running the unit tests does
# not need it.
#
#   sh scripts/make-sevenzip-fixtures.sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/fixtures/sevenzip"
SEVENZIP="${SEVENZIP:-7z}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$OUT" "$WORK/members"
"$SEVENZIP" x -y -o"$WORK/members" "$ROOT/tests/fixtures/sample.cb7" >/dev/null
cd "$WORK/members"

pack() {
  name="$1"
  shift
  rm -f "$OUT/$name"
  "$SEVENZIP" a -t7z -bd "$@" "$OUT/$name" . >/dev/null
}

# File names readable, contents encrypted. Solid, as 7z is by default.
pack encrypted.cb7 -pcomic
# Names encrypted too: nothing can be listed without the password.
pack encrypted-headers.cb7 -pcomic -mhe=on
# One archive in two parts: everything but the .png pages without a
# password, then the .png pages with one.
pack mixed.cb7 -ms=off -x'!*.png'
"$SEVENZIP" a -t7z -bd -ms=off -pcomic "$OUT/mixed.cb7" '*.png' -r >/dev/null

# Forty encrypted pages, each a block of its own (not solid), for checking
# that a wrong password is given up on without decoding them all.
mkdir "$WORK/many"
for index in $(seq -w 1 40); do
  cp "$WORK/members/Chapter 1/page1.png" "$WORK/many/p$index.png"
done
cd "$WORK/many"
pack many-blocks.cb7 -ms=off -mx=0 -pcomic

