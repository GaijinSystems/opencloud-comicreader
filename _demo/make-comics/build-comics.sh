#!/bin/sh
# Rebuilds the demo's comics in demo/comics/ from nothing but code: the pages
# are drawn by make_pages.py (shapes only; no real comic, character or art),
# rendered to JPEG in headless Chromium, and packed one per format, plus a
# password-protected copy (password "comic"). The results are committed, so
# this only needs running to change them.
#
# Needs podman (or docker), and network access for the containers to fetch
# playwright-core and 7-Zip. Nothing is installed on the host.
#
#   sh _demo/make-comics/build-comics.sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$(command -v podman || command -v docker)"
COMICS="$HERE/../comics"

python3 "$HERE/make_pages.py" 12

# Any image with Node and a Chromium under /ms-playwright will do.
"$ENGINE" run --rm --entrypoint sh -v "$HERE:/make" "${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.57.0-noble}" -euc '
  cd /tmp && npm init -y >/dev/null && npm install --no-audit --no-fund playwright-core@1.57.0 >/dev/null
  cp /make/render.mjs /tmp/render.mjs
  CHROME=$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome | head -1) node /tmp/render.mjs /make'

python3 "$HERE/pack.py"

"$ENGINE" run --rm -v "$HERE:/make" -v "$COMICS:/comics" -e DEBIAN_FRONTEND=noninteractive docker.io/library/debian:trixie sh -euc '
  apt-get update -qq >/dev/null && apt-get install -y -qq 7zip >/dev/null
  cd /make/staging/orbit-post
  rm -f "/comics/Orbit Postal Service #003.cb7" "/comics/Orbit Postal Service #003 (locked).cb7"
  7z a -t7z -mx=5 "/comics/Orbit Postal Service #003.cb7" . >/dev/null
  # Encrypted names too (-mhe), so that the reader has to ask before it can list it.
  7z a -t7z -mx=5 -mhe=on -pcomic "/comics/Orbit Postal Service #003 (locked).cb7" . >/dev/null'

ls -l "$COMICS"
