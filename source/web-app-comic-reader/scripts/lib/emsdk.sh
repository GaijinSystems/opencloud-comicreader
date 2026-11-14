# Shared by scripts/build-unarr.sh, scripts/build-libarchive.sh and
# scripts/build-sevenzip.sh; sourced, not run. One place for the compiler the
# decoders are built with, and for how its container is started.
#
# Expects ROOT to be the app directory (source/web-app-comic-reader).

# emscripten/emsdk 7.0.0, the amd64 image, pinned by digest so the same
# compiler is used every time and the output can be compared, byte for byte,
# with the hashes in native/outputs.sha256. On another architecture it runs
# under emulation if the host supports that; otherwise set EMSDK_IMAGE, and
# expect to verify the output yourself (DECODERS_UNVERIFIED=1 for the build).
EMSDK_IMAGE="${EMSDK_IMAGE:-docker.io/emscripten/emsdk@sha256:3803e37bf748ddee14d31cf712fcab09ca367fca83bbefeb78ce4c1f284e6f3f}"

if command -v podman >/dev/null 2>&1; then
  EMSDK_RUNNER=podman
elif command -v docker >/dev/null 2>&1; then
  EMSDK_RUNNER=docker
else
  echo "podman or docker is required" >&2
  exit 1
fi

# sha256sum where there is one, shasum (macOS) where there is not.
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

# build_stamp <native dir>
#
# Prints one hash over everything the build's output depends on: the files
# named in <native dir>/build-inputs.txt, which include this file and so the
# pinned compiler. The build scripts record it in <native dir>/BUILD-STAMP
# once the outputs are in place; scripts/prepare-decoders.mjs computes the
# same value and refuses outputs whose stamp does not match, so a module
# built from other inputs than the ones in the tree cannot ship unnoticed.
build_stamp() {
  [ -r "$1/build-inputs.txt" ] && [ -s "$1/build-inputs.txt" ] || return 1
  # shellcheck disable=SC2046  # one path per line, none with spaces
  sums="$(cd "$ROOT" && checksum $(cat "$1/build-inputs.txt"))" || return 1
  printf '%s\n' "$sums" | checksum | cut -d' ' -f1
}

# emsdk_build <native dir> <destination dir> <output file>...
#
# Runs <native dir>/build.sh in the container, installs the named outputs
# and records the build stamp.
#
# - No network: everything the build needs is mounted in.
# - The container writes into an empty scratch directory, never into the
#   destination. The destination may hold hand-written files that ship as
#   they are, and the build has no business being able to touch them.
# - SELinux labelling is switched off for this one container rather than
#   relabelling the source tree, so the mounts work on an enforcing host.
# - Both or neither: nothing is installed unless every output was produced,
#   as a regular file. The stamp is removed first and written last, so an
#   interrupted build never leaves old and new outputs under a valid stamp.
emsdk_build() {
  native="$1"
  destination="$2"
  shift 2

  stamp="$(build_stamp "$native")" || { echo "could not hash the build inputs of $native" >&2; exit 1; }
  rm -f "$native/BUILD-STAMP"

  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT
  "$EMSDK_RUNNER" run --rm --network=none \
    --security-opt label=disable --security-opt no-new-privileges \
    -v "$native:/src:ro" \
    -v "$scratch:/out" \
    "$EMSDK_IMAGE" sh /src/build.sh

  for name in "$@"; do
    if [ ! -f "$scratch/$name" ] || [ -L "$scratch/$name" ] || [ ! -s "$scratch/$name" ]; then
      echo "the build did not produce $name" >&2
      exit 1
    fi
  done
  mkdir -p "$destination"
  for name in "$@"; do
    cp "$scratch/$name" "$destination/$name"
    chmod 644 "$destination/$name"
  done
  echo "$stamp" > "$native/BUILD-STAMP"
}
