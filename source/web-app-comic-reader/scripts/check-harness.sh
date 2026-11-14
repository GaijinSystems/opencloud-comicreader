#!/bin/sh
# Runs docs/fit-rotation-harness.html in a headless Chromium over every fit
# mode, rotation, page layout, scroll position and three window sizes, and
# reports any case where the page's own checks fail: a page that overflows or
# sits off-centre, click zones that are not over the visible area or that add
# scroll, an edge click that misses its zone, a retry button under a zone.
#
# This is the nearest thing to a browser test of the reader's layout that
# does not need an OpenCloud instance. tests/unit/harness.spec.ts keeps the
# harness in step with the component; this checks what a browser makes of it.
#
#   CHROME=/path/to/chromium sh scripts/check-harness.sh
#   SHOW=1 CHROME=... sh scripts/check-harness.sh     # print every case
#
# Any Chromium-based browser with --headless and --dump-dom will do. The
# harness runs all 192 cases for a window size in one page load (?all=1), so
# this starts the browser three times.
set -u
: "${CHROME:?set CHROME to a Chromium binary, e.g. CHROME=/usr/bin/chromium}"
PAGE="file://$(cd "$(dirname "$0")/../docs" && pwd)/fit-rotation-harness.html"
EXPECTED=192

total=0
bad=0
for size in 1280,800 700,900 520,420; do
  # One JSON object per line, so plain grep can count and pick out failures.
  cases=$("$CHROME" --headless --no-sandbox --disable-gpu --window-size="$size" \
      --virtual-time-budget=60000 --dump-dom "$PAGE?all=1" 2>/dev/null |
    grep -o '<pre id="result"[^>]*>[^<]*' | sed -e 's/^[^>]*>//' -e 's/&quot;/"/g' -e 's/^\[//' -e 's/\]$//' |
    # A newline between objects; written with tr because `\n` in a sed
    # replacement is GNU only.
    sed 's/},{/}|{/g' | tr '|' '\n')
  count=$(printf '%s\n' "$cases" | grep -c '"mode"')
  failing=$(printf '%s\n' "$cases" | grep '"ok":false')
  if [ "$count" -ne "$EXPECTED" ]; then
    bad=$((bad + 1))
    echo "INCOMPLETE  $size  expected $EXPECTED cases, got $count"
  fi
  if [ -n "$failing" ]; then
    bad=$((bad + $(printf '%s\n' "$failing" | grep -c .)))
    printf '%s\n' "$failing" | sed "s/^/FAIL  $size  /"
  fi
  [ -n "${SHOW:-}" ] && printf '%s\n' "$cases" | sed "s/^/      $size  /"
  total=$((total + count))
done

echo "cases=$total failing=$bad"
[ "$bad" -eq 0 ] && [ "$total" -eq $((EXPECTED * 3)) ]
