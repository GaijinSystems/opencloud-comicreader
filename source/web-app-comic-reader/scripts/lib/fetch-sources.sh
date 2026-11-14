# Shared by scripts/build-libarchive.sh and scripts/build-sevenzip.sh;
# sourced, not run, after scripts/lib/emsdk.sh (for `checksum`).
#
# Expects ROOT to be the app directory (source/web-app-comic-reader).

# fetch_sources <native dir>
#
# Downloads each address in <native dir>/sources.txt into <native dir>/.cache,
# unless it is already there, and then requires every file named in
# <native dir>/sources.sha256 to have the hash recorded for it. Nothing that
# fails that check is ever handed to a build, and the build checks again.
#
# HTTPS only, redirects included. A download is written under a temporary
# name first, so an interrupted one is not mistaken for a complete file.
fetch_sources() {
  cache="$1/.cache"
  mkdir -p "$cache"
  # `|| [ -n "$url" ]`: a last line without a newline still counts.
  while read -r url || [ -n "$url" ]; do
    [ -n "$url" ] || continue
    name="${url##*/}"
    # Nothing is fetched that is not pinned: it could never be checked.
    cut -d' ' -f3- "$1/sources.sha256" | grep -qxF -- "$name" || {
      echo "$name is named in ${1#"$ROOT"/}/sources.txt but has no hash in sources.sha256" >&2
      exit 1
    }
    if [ ! -s "$cache/$name" ]; then
      echo "downloading $name"
      curl -fsSL --proto '=https' --proto-redir '=https' -o "$cache/$name.part" "$url"
      mv "$cache/$name.part" "$cache/$name"
    fi
  done < "$1/sources.txt"
  # Refuse anything that is not exactly what was pinned.
  (cd "$cache" && checksum -c "$1/sources.sha256") || {
    echo "Delete the file(s) reported above from ${1#"$ROOT"/}/.cache and run this again." >&2
    exit 1
  }
}
