#!/usr/bin/env bash
# One-command comparison matrix: canvas_ity vs Chromium canvas.
#
#   compare/run.sh [extra args for analyze.py, e.g. --exceed 24 --ratio 0.01]
#
# Pipeline:
#   1. record    cases.js        -> out/ops/*.ops + out/manifest.json
#   2. font      test/test.cpp   -> out/font.ttf / out/font.b64
#   3. build     render_canvasity.cpp (cached)
#   4. render    canvas_ity      -> out/canvasity/<case>.rgba
#   5. render    chromium        -> out/chromium_dump.html
#   6. analyze                   -> out/report.md / report.json / diff pngs
#
# Environment overrides: CXX, CHROME, OUT_DIR.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
OUT="${OUT_DIR:-$HERE/out}"
mkdir -p "$OUT"

# --- toolchain discovery ---------------------------------------------------

find_cxx() {
  if [ -n "${CXX:-}" ] && command -v "$CXX" >/dev/null 2>&1; then
    echo "$CXX"; return
  fi
  for c in g++ "$HOME/bin/g++" /tmp/tc15/usr/bin/g++-15 clang++; do
    if command -v "$c" >/dev/null 2>&1; then echo "$c"; return; fi
  done
  echo "error: no C++ compiler found (set CXX)" >&2; exit 1
}

find_chrome() {
  if [ -n "${CHROME:-}" ] && [ -x "$CHROME" ]; then echo "$CHROME"; return; fi
  local c
  for c in "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell; do
    [ -x "$c" ] && echo "$c" && return
  done
  for c in chromium chromium-browser google-chrome; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return; fi
  done
  echo "error: no chromium found (set CHROME)" >&2; exit 1
}

CXX_BIN="$(find_cxx)"
CHROME_BIN="$(find_chrome)"

# --- chromium runtime libraries (nss/nspr), no root required ---------------

LIBDIR="$OUT/env/libs"
if ldd "$CHROME_BIN" 2>/dev/null | grep -q "not found"; then
  if [ ! -d "$LIBDIR" ]; then
    echo "== fetching chromium runtime libs (nss/nspr) =="
    DEBS="$OUT/env/debs"
    mkdir -p "$DEBS" "$LIBDIR"
    ( cd "$DEBS" && apt-get download libnss3 libnspr4 >/dev/null )
    for deb in "$DEBS"/*.deb; do dpkg -x "$deb" "$LIBDIR"; done
  fi
  export LD_LIBRARY_PATH="$LIBDIR/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
if ldd "$CHROME_BIN" 2>/dev/null | grep -q "not found"; then
  echo "error: chromium still has unresolved libraries:" >&2
  ldd "$CHROME_BIN" | grep "not found" >&2
  exit 1
fi

# --- 1+2: record op streams and extract the shared font --------------------

echo "== recording op streams =="
node "$HERE/record_ops.js" "$OUT"
node "$HERE/extract_font.js" "$REPO" "$OUT/font.ttf"
node "$HERE/extract_font.js" "$REPO" "$OUT/font.b64" --base64

# --- 3: build the canvas_ity replay renderer (cached) ----------------------

BIN="$OUT/render_canvasity"
if [ ! -x "$BIN" ] || [ "$HERE/render_canvasity.cpp" -nt "$BIN" ] \
   || [ "$REPO/src/canvas_ity.hpp" -nt "$BIN" ]; then
  echo "== building render_canvasity =="
  "$CXX_BIN" -O2 -std=c++11 -o "$BIN" "$HERE/render_canvasity.cpp"
fi

# --- 4: render every case with canvas_ity ----------------------------------

echo "== rendering with canvas_ity =="
mkdir -p "$OUT/canvasity"
node -e 'const m=require(process.argv[1]);for(const c of m)console.log(c.name)' \
  "$OUT/manifest.json" | while read -r name; do
  "$BIN" "$OUT/font.ttf" "$OUT/ops/$name.ops" "$OUT/canvasity/$name.rgba"
done

# --- 5: render every case with chromium ------------------------------------

echo "== rendering with chromium =="
node "$HERE/make_page.js" "$OUT"
"$CHROME_BIN" --headless --disable-gpu --no-sandbox --disable-dev-shm-usage \
  --force-device-scale-factor=1 --virtual-time-budget=10000 \
  --dump-dom "file://$OUT/chromium_page.html" > "$OUT/chromium_dump.html" \
  2> "$OUT/chromium_stderr.log" || {
    echo "error: chromium run failed, see $OUT/chromium_stderr.log" >&2
    exit 1; }

# --- 6: compare and report --------------------------------------------------

{
  echo "canvas_ity=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "chromium=$("$CHROME_BIN" --version 2>/dev/null || echo unknown)"
} > "$OUT/versions.txt"

echo "== analyzing =="
python3 "$HERE/analyze.py" "$OUT" "$@"
