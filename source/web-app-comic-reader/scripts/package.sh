#!/bin/sh
# Packages a build of the app for release, in two formats holding the same
# files: opencloud-comicreader-<version>.zip, the format OpenCloud's app store
# downloads, and opencloud-comicreader-<version>.tar.gz. Each holds one folder
# named comic-reader (the app's id in OpenCloud, which the folder must be
# named after) with a SHA256SUMS listing every other file in it, and each has
# its <file>.sha256 beside it.
#
#   sh scripts/package.sh <built app folder> <output folder>
#
# The built app folder is what `npm run build` puts in dist/. It is copied,
# not changed. The same build gives the same bytes: the files are stored in a
# fixed order, with modes set to 644 and 755 and all dated by
# SOURCE_DATE_EPOCH (by default, the time of the last commit); the tarball
# records fixed owners and gzip no name or time; the zip, which keeps local
# times, is made in UTC and without owners or extra timestamps.
# Needs GNU tar, zip (Info-ZIP) and GNU touch.
set -eu
[ $# -eq 2 ] || { echo "usage: sh scripts/package.sh <built app folder> <output folder>" >&2; exit 1; }
build=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
cd "$(dirname "$0")/.."

[ -s "$build/manifest.json" ] || { echo "package: no manifest.json in $build" >&2; exit 1; }
version=$(sed -n 's/^  "version": "\([^"]*\)",*$/\1/p' "$build/manifest.json" | head -n 1)
[ -n "$version" ] || { echo "package: no version in $build/manifest.json" >&2; exit 1; }
epoch=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}
base="opencloud-comicreader-$version"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R "$build" "$work/comic-reader"
rm -f "$work/comic-reader/SHA256SUMS"
(cd "$work/comic-reader" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "$work/SHA256SUMS")
mv "$work/SHA256SUMS" "$work/comic-reader/"
# whatever modes the build had: nothing in the app is meant to be executable
find "$work/comic-reader" -type d -exec chmod 755 {} +
find "$work/comic-reader" -type f -exec chmod 644 {} +
# the zip takes each file's own time, so every one is given the same
find "$work/comic-reader" -exec touch -h -d "@$epoch" {} +

# tar runs gzip itself, so that a failure of either stops the script
tar -C "$work" --sort=name --owner=0 --group=0 --numeric-owner \
  --mtime="@$epoch" -I 'gzip -9n' -cf "$out/$base.tar.gz" comic-reader

# folders and files in a fixed order, read from a list; -X leaves out owners
# and the extra Unix timestamps, TZ=UTC fixes the local time zip records
rm -f "$out/$base.zip"
(cd "$work" && find comic-reader -print | LC_ALL=C sort |
  TZ=UTC zip -q -X -9 -@ "$out/$base.zip")

for f in "$base.zip" "$base.tar.gz"; do
  (cd "$out" && sha256sum "$f" > "$f.sha256")
  echo "$out/$f"
done
