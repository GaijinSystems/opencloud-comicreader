#!/bin/sh
# Checks that the version is the same everywhere a release needs it, and
# prints that version's section of CHANGELOG.md: the release notes.
#
#   sh scripts/release-notes.sh             # check, and print the notes
#   sh scripts/release-notes.sh > /dev/null # only check
#
# The version is set in package.json and package-lock.json, on the first line
# of public/INSTALL.txt (ending in " v1.2.3"), and as a CHANGELOG.md section
# whose heading is "## 1.2.3", optionally followed by a space and a date.
# Run it before tagging a release: .github/workflows/release.yml runs it on
# every push, and takes the release notes from it.
set -eu
cd "$(dirname "$0")/.."

fail() {
  echo "release-notes: $*" >&2
  exit 1
}

# The first "version" at the top level (two spaces in) of each file. In
# package-lock.json the root package's own entry, further in, says the same.
top_version() {
  sed -n 's/^  "version": "\([^"]*\)",*$/\1/p' "$1" | head -n 1
}

version=$(top_version package.json)
[ -n "$version" ] || fail "no version in package.json"
[ "$(top_version package-lock.json)" = "$version" ] ||
  fail "package-lock.json is not at version $version (npm version $version --no-git-tag-version)"
case "$(head -n 1 public/INSTALL.txt)" in
  *" v$version") ;;
  *) fail "the first line of public/INSTALL.txt does not end in v$version" ;;
esac

notes=$(awk -v v="## $version" '
  index($0, v) == 1 && (length($0) == length(v) || substr($0, length(v) + 1, 1) == " ") {on = 1; found = 1; next}
  /^## / {on = 0}
  on
  END {exit !found}' CHANGELOG.md) || fail "CHANGELOG.md has no '## $version' section"
printf '%s\n' "$notes" | grep -q '[^[:space:]]' || fail "the '## $version' section of CHANGELOG.md is empty"
printf '%s\n' "$notes"
