#!/bin/sh
# Packages a build of the app for release: comic-reader-<version>.tar.gz,
# holding one folder named comic-reader, with a SHA256SUMS listing every
# other file in it, and comic-reader-<version>.tar.gz.sha256 beside it.
#
#   sh scripts/package.sh <built app folder> <output folder>
#
# The built app folder is what `npm run build` puts in dist/. It is copied,
# not changed. The same build gives the same bytes: the files are stored in a
# fixed order, with fixed owners, modes normalised to 644 and 755, all dated
# by SOURCE_DATE_EPOCH (by default, the time of the last commit), and gzip
# records no name or time.
# Needs GNU tar.
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
name="comic-reader-$version.tar.gz"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R "$build" "$work/comic-reader"
rm -f "$work/comic-reader/SHA256SUMS"
(cd "$work/comic-reader" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "$work/SHA256SUMS")
mv "$work/SHA256SUMS" "$work/comic-reader/"
# tar runs gzip itself, so that a failure of either stops the script
tar -C "$work" --sort=name --owner=0 --group=0 --numeric-owner \
  --mode=u+rwX,go+rX,go-w --mtime="@$epoch" -I 'gzip -9n' -cf "$out/$name" comic-reader
(cd "$out" && sha256sum "$name" > "$name.sha256")
echo "$out/$name"
