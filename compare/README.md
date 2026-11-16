# Comparison matrix: canvas_ity vs Chromium canvas

Renders one fixed set of drawing scripts (paths, strokes, gradients,
text, transforms, clipping) through both **canvas_ity** and **Chromium's
HTML canvas**, compares the results pixel by pixel, and produces a
reviewable report with per-primitive statistics and a categorized list
of known differences.  It does not change any implementation output —
it only observes both renderers.

## One-command run

```sh
compare/run.sh
```

Optional tolerance overrides are passed through to the analyzer, e.g.
`compare/run.sh --exceed 24 --ratio 0.01` (defaults: a pixel exceeds
tolerance when any RGBA channel differs by more than 16; a case becomes
a known difference when more than 0.1% of its pixels exceed).

Requirements: `node`, `python3` with Pillow, a C++ compiler (`CXX` to
override auto-detection), and a Chromium/Chrome binary (`CHROME` to
override; a Playwright `chrome-headless-shell` under
`~/.cache/ms-playwright` is found automatically, and missing nss/nspr
runtime libraries are fetched into `out/env/` without root).

## How it works

```
cases.js              fixed drawing scripts (single source of truth,
                      standard Canvas 2D API, 4 cases x 6 categories)
record_ops.js         replays cases.js against a recording mock context
                      -> out/ops/<case>.ops (implementation-neutral op
                      stream) + out/manifest.json
render_canvasity.cpp  replays each op stream through canvas_ity
                      -> out/canvasity/<case>.rgba (raw RGBA8)
make_page.js          embeds the same op streams in a headless-Chromium
                      page that replays them on a real canvas
                      -> out/chromium_dump.html (PNG data URLs)
analyze.py            per-pixel comparison -> out/report.md,
                      out/report.json, out/diff/<case>.png
extract_font.js       extracts the test suite's FontA TTF from
                      test/test.cpp so both renderers use the identical
                      font (registered as "CompareFont")
```

Both renderers execute **the same generated op stream**, so any
difference in the output comes from the renderer, not from the scripts.
Text cases use the same TTF on both sides; remaining text differences
are rasterization/hinting differences.

## Output

Everything lands in `compare/out/` (git-ignored):

- `report.md` — the comparison matrix: per-case diff-pixel ratio, max
  and mean channel delta, over-tolerance ratio, status
  (`MATCH` / `WITHIN_TOLERANCE` / `KNOWN_DIFF`), plus the categorized
  known-differences list with diff-region bounds
- `report.json` — the same data, machine-readable
- `canvasity/*.png`, `chromium/*.png` — both renders for eyeballing
- `diff/*.png` — per-case diff visualization (red = over tolerance,
  gray = amplified small delta)

## Reading the results

Two systematic difference classes are documented canvas_ity design
choices (see the header of `src/canvas_ity.hpp`) and dominate the
known-differences list:

1. **Color space** — canvas_ity interpolates gradient stops and blends
   translucent geometry gamma-corrected in linear light; Chromium's
   canvas interpolates and blends in sRGB.  Expect large-area,
   moderate-delta differences in gradient and alpha-blending cases.
2. **Rasterization** — canvas_ity uses trapezoidal area antialiasing
   with ordered dithering; Skia uses its own antialiasing.  Expect
   edge-localized differences on paths, strokes, clips, and glyph
   outlines.

The classification attached to each known difference is a heuristic
review aid, not a proof; the diff images are the ground truth.
