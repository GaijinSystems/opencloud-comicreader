#!/bin/sh
# Builds the live demo into the root of this branch, from the app's source on
# the main branch: the reader on a mock file list, as a static site.
#
#   sh _demo/build.sh [path to source/web-app-comic-reader on main]
#
# The path defaults to where it is when this branch is checked out as a
# worktree inside a checkout of main (`git worktree add pages gh-pages`).
# Build the decoders there first (`npm run build:native`, which needs podman
# or docker), as for the app itself. This script then needs podman (or
# docker) and, the first time, network access for the container to install
# the app's npm dependencies into a volume. Nothing is installed on the host.
#
# What it does: copies the app's source into a working copy in a volume,
# adds this branch's _demo/ to it as demo/, builds that with
# _demo/vite.demo.config.ts, and puts the result at the root of this
# branch in place of the previous build. _demo/, README.md, CNAME and
# .gitignore are kept. (GitHub Pages publishes the branch through Jekyll,
# which copies these files as they are, none having front matter, and
# leaves out _demo/, as it does any name that starts with an underscore.)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SITE="$(dirname "$HERE")"
APP="$(cd "${1:-$SITE/../source/web-app-comic-reader}" && pwd)"
ENGINE="$(command -v podman || command -v docker)"

[ -s "$APP/public/vendor/sevenzip/sevenzip.wasm" ] || {
  echo "The decoders are not built in $APP. Run npm run build:native there first." >&2
  exit 1
}

"$ENGINE" run --rm -v "$APP:/app:ro" -v "$HERE:/demo-in:ro" -v "$SITE:/site" \
  -v comicreader-demo-work:/work -v comicreader-npm-cache:/root/.npm \
  docker.io/library/node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 sh -euc '
  mkdir -p /work/app && cd /work/app
  # A fresh copy of the source each time; the installed dependencies stay.
  find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -r {} +
  cp -a /app/. .
  rm -rf node_modules/.vite
  if ! cmp -s package-lock.json node_modules/.installed-lock.json; then
    npm ci --legacy-peer-deps --no-audit --no-fund >/dev/null
    cp package-lock.json node_modules/.installed-lock.json
  fi
  mkdir demo && cp -a /demo-in/. demo/ && mv demo/vite.demo.config.ts .
  rm -rf demo/make-comics
  node scripts/prepare-decoders.mjs
  npx vite build --config vite.demo.config.ts --logLevel warn
  # Swap the previous build for this one; keep what is not built.
  find /site -mindepth 1 -maxdepth 1 ! -name _demo ! -name README.md ! -name CNAME \
    ! -name .gitignore ! -name .git -exec rm -r {} +
  cp -a demo-dist/. /site/'
echo "Built into $SITE"
