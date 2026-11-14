#!/bin/sh
# Checks tests/fixtures/rar2-encrypted.cbr against RARLAB's own unrar.
#
# That fixture is encrypted with RAR 2.x's cipher by scripts/rar_writer.py,
# since no current archiver writes it. The reader decrypts it with 7-Zip's
# implementation of the cipher. This is the third opinion: unrar must test
# the archive as sound with the password "comic", and as damaged with
# another.
#
# Needs podman or docker, and network access for the container to fetch
# unrar (proprietary freeware, from Debian's non-free section). Nothing is
# installed on the host.
#
#   sh scripts/check-rar2-fixture.sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="$(command -v podman || command -v docker)"
"$ENGINE" run --rm -v "$ROOT/tests/fixtures:/fixtures:ro" docker.io/library/debian:trixie sh -euc '
  sed -i "s/Components: main/Components: main non-free/" /etc/apt/sources.list.d/debian.sources
  apt-get update -qq >/dev/null
  apt-get install -y -qq unrar >/dev/null 2>&1
  unrar t -pcomic /fixtures/rar2-encrypted.cbr | tail -1 | grep -q "All OK"
  if unrar t -pwrong /fixtures/rar2-encrypted.cbr >/dev/null 2>&1; then
    echo "unrar accepted a wrong password" >&2
    exit 1
  fi
  echo "unrar agrees: sound with the password, damaged without it"
'
