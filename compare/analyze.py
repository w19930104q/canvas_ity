#!/usr/bin/env python3
"""Per-pixel comparator and report generator for the comparison matrix.

Reads the paired renders produced by run.sh:
  <out>/manifest.json          case list (name, category, description, w, h)
  <out>/canvasity/<name>.rgba  raw RGBA8 from the canvas_ity replay
  <out>/chromium_dump.html     --dump-dom output with PNG data URLs

Writes:
  <out>/chromium/<name>.png    decoded Chromium renders
  <out>/canvasity/<name>.png   canvas_ity renders as PNG (for review)
  <out>/diff/<name>.png        visual diff (red = over tolerance)
  <out>/report.json            machine-readable statistics
  <out>/report.md              the reviewable comparison matrix report

A pixel "exceeds tolerance" when any RGBA channel differs by more than
--exceed (default 16).  A case is a KNOWN_DIFF when the fraction of
exceeding pixels is greater than --ratio (default 0.001 = 0.1%).
"""

import argparse
import base64
import io
import json
import os
import re
import sys

from PIL import Image

STATUS_MATCH = "MATCH"
STATUS_OK = "WITHIN_TOLERANCE"
STATUS_DIFF = "KNOWN_DIFF"

# Human-readable labels for the heuristic classification of known
# differences.  These describe the *likely source* of the divergence and
# are meant as review aids, not proofs.  Two systematic causes are
# documented design choices of canvas_ity (see src/canvas_ity.hpp):
# gamma-correct (linear-light) interpolation/blending and trapezoidal
# area antialiasing with ordered dithering, where Chromium's canvas
# interpolates and blends in sRGB with its own AA.
CLASSIFICATIONS = {
    "text": "font-rasterization (glyph scan conversion / hinting)",
    "paths": "fill-rasterization (edge coverage / antialiasing)",
    "strokes": "stroke-geometry (caps/joins/dashes) or edge antialiasing",
    "gradients": "gradient color space (canvas_ity interpolates stops in "
                 "linear light; Chromium interpolates in sRGB)",
    "transforms": "transform-rounding (matrix precision) or edge "
                  "antialiasing",
    "clipping": "clip-rasterization (clip edge coverage)",
}


def load_chromium_results(dump_path):
    with open(dump_path, "r", encoding="utf-8") as f:
        html = f.read()
    if "REPLAY-ERROR" in html:
        raise RuntimeError("chromium page reported an error, see dump")
    m = re.search(r'<pre id="results">(.*?)</pre>', html, re.DOTALL)
    if not m:
        raise RuntimeError("no results block found in chromium dump")
    return json.loads(m.group(1))


def data_url_to_image(data_url):
    prefix = "data:image/png;base64,"
    if not data_url.startswith(prefix):
        raise RuntimeError("unexpected data url prefix")
    return Image.open(io.BytesIO(base64.b64decode(data_url[len(prefix):])))


def compare(name, a_img, b_img, exceed):
    """Return per-case statistics for two RGBA images (a=canvas_ity)."""
    if a_img.size != b_img.size:
        raise RuntimeError(f"{name}: size mismatch {a_img.size} vs {b_img.size}")
    w, h = a_img.size
    a = a_img.tobytes()
    b = b_img.tobytes()
    n_px = w * h
    n_diff = 0
    n_exceed = 0
    max_delta = 0
    sum_delta = 0
    min_x, min_y, max_x, max_y = w, h, -1, -1
    diff_img = Image.new("RGB", (w, h))
    diff_px = diff_img.load()
    for y in range(h):
        row = y * w * 4
        for x in range(w):
            i = row + x * 4
            d0 = abs(a[i] - b[i])
            d1 = abs(a[i + 1] - b[i + 1])
            d2 = abs(a[i + 2] - b[i + 2])
            d3 = abs(a[i + 3] - b[i + 3])
            d = max(d0, d1, d2, d3)
            sum_delta += d0 + d1 + d2 + d3
            if d:
                n_diff += 1
                if d > max_delta:
                    max_delta = d
                if d > exceed:
                    n_exceed += 1
                    if x < min_x: min_x = x
                    if x > max_x: max_x = x
                    if y < min_y: min_y = y
                    if y > max_y: max_y = y
                    diff_px[x, y] = (255, 0, 0)
                else:
                    g = min(255, d * 8)
                    diff_px[x, y] = (g, g, g)
    bbox = None
    if n_exceed:
        bbox = [min_x, min_y, max_x, max_y]
    return {
        "pixels": n_px,
        "diff_pixels": n_diff,
        "diff_ratio": n_diff / n_px,
        "exceed_pixels": n_exceed,
        "exceed_ratio": n_exceed / n_px,
        "max_channel_delta": max_delta,
        "mean_channel_delta": sum_delta / (n_px * 4),
        "exceed_bbox": bbox,
    }, diff_img


def classify(case, stats):
    if case["category"] == "text":
        return CLASSIFICATIONS["text"]
    if case["category"] == "gradients":
        return CLASSIFICATIONS["gradients"]
    if stats["max_channel_delta"] <= 64:
        # Large area, moderate deltas: consistent with canvas_ity's
        # gamma-correct (linear-light) alpha compositing vs Chromium's
        # sRGB blending, rather than a geometry difference.
        return ("blend color space (canvas_ity composites in linear "
                "light; Chromium composites in sRGB)")
    return CLASSIFICATIONS.get(case["category"], "unclassified")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir")
    ap.add_argument("--exceed", type=int, default=16,
                    help="per-channel delta above which a pixel exceeds "
                         "tolerance (default 16)")
    ap.add_argument("--ratio", type=float, default=0.001,
                    help="fraction of exceeding pixels above which a case "
                         "is a known difference (default 0.001)")
    args = ap.parse_args()
    out = args.out_dir

    with open(os.path.join(out, "manifest.json")) as f:
        manifest = json.load(f)
    chromium = load_chromium_results(os.path.join(out, "chromium_dump.html"))

    versions = {}
    vpath = os.path.join(out, "versions.txt")
    if os.path.exists(vpath):
        with open(vpath) as f:
            for line in f:
                if "=" in line:
                    k, v = line.rstrip("\n").split("=", 1)
                    versions[k] = v

    for sub in ("chromium", "canvasity", "diff"):
        os.makedirs(os.path.join(out, sub), exist_ok=True)

    results = []
    for case in manifest:
        name = case["name"]
        w, h = case["width"], case["height"]
        raw_path = os.path.join(out, "canvasity", name + ".rgba")
        with open(raw_path, "rb") as f:
            raw = f.read()
        if len(raw) != w * h * 4:
            raise RuntimeError(f"{name}: bad rgba size {len(raw)}")
        a_img = Image.frombytes("RGBA", (w, h), raw)
        b_img = data_url_to_image(chromium[name]).convert("RGBA")
        a_img.save(os.path.join(out, "canvasity", name + ".png"))
        b_img.save(os.path.join(out, "chromium", name + ".png"))
        stats, diff_img = compare(name, a_img, b_img, args.exceed)
        diff_img.save(os.path.join(out, "diff", name + ".png"))
        if stats["exceed_pixels"] == 0:
            status = STATUS_MATCH if stats["diff_pixels"] == 0 else STATUS_OK
        elif stats["exceed_ratio"] <= args.ratio:
            status = STATUS_OK
        else:
            status = STATUS_DIFF
        entry = {
            "name": name,
            "category": case["category"],
            "description": case["description"],
            "status": status,
            **stats,
        }
        if status == STATUS_DIFF:
            entry["classification"] = classify(case, stats)
            entry["diff_image"] = f"diff/{name}.png"
        results.append(entry)

    known = [r for r in results if r["status"] == STATUS_DIFF]
    report = {
        "parameters": {
            "exceed_channel_delta": args.exceed,
            "exceed_pixel_ratio": args.ratio,
        },
        "versions": versions,
        "summary": {
            "cases": len(results),
            "match": sum(1 for r in results if r["status"] == STATUS_MATCH),
            "within_tolerance": sum(
                1 for r in results if r["status"] == STATUS_OK),
            "known_differences": len(known),
        },
        "cases": results,
        "known_differences": known,
    }
    with open(os.path.join(out, "report.json"), "w") as f:
        json.dump(report, f, indent=2)

    write_markdown(out, report)
    s = report["summary"]
    print(f"cases={s['cases']} match={s['match']} "
          f"within_tolerance={s['within_tolerance']} "
          f"known_differences={s['known_differences']}")
    print("report -> " + os.path.join(out, "report.md"))


def pct(x):
    return f"{100 * x:.3f}%"


def write_markdown(out, report):
    p = report["parameters"]
    lines = []
    lines.append("# canvas_ity vs Chromium canvas — comparison matrix")
    lines.append("")
    lines.append("Same fixed drawing scripts (compare/cases.js) replayed "
                 "through both renderers from a shared op stream; compared "
                 "per pixel on unpremultiplied RGBA8.")
    lines.append("")
    lines.append(f"- canvas_ity: {report['versions'].get('canvas_ity', '?')}")
    lines.append(f"- chromium: {report['versions'].get('chromium', '?')}")
    lines.append(f"- tolerance: pixel exceeds when any channel delta > "
                 f"{p['exceed_channel_delta']}/255; case is a known "
                 f"difference when exceeding pixels > "
                 f"{pct(p['exceed_pixel_ratio'])} of the canvas")
    lines.append("")
    s = report["summary"]
    lines.append(f"**{s['cases']} cases: {s['match']} exact, "
                 f"{s['within_tolerance']} within tolerance, "
                 f"{s['known_differences']} known differences.**")
    lines.append("")
    lines.append("Systematic causes to expect (documented canvas_ity "
                 "design, src/canvas_ity.hpp): gradients and translucent "
                 "blends are computed gamma-corrected in linear light "
                 "while Chromium's canvas works in sRGB; edges use "
                 "trapezoidal area antialiasing plus ordered dithering, "
                 "which differs from Skia's antialiasing.  Classifications "
                 "below are heuristics for review, not proofs.")
    lines.append("")
    lines.append("## Matrix")
    lines.append("")
    lines.append("| case | category | diff px | max Δ | mean Δ | "
                 ">tol px | status |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in report["cases"]:
        lines.append(
            f"| {r['name']} | {r['category']} | {pct(r['diff_ratio'])} "
            f"| {r['max_channel_delta']} | {r['mean_channel_delta']:.3f} "
            f"| {pct(r['exceed_ratio'])} | {r['status']} |")
    lines.append("")
    lines.append("## Known differences")
    lines.append("")
    if not report["known_differences"]:
        lines.append("None — every case is within tolerance.")
    for r in report["known_differences"]:
        lines.append(f"### {r['name']} ({r['category']})")
        lines.append("")
        lines.append(f"- {r['description']}")
        lines.append(f"- classification: {r['classification']}")
        lines.append(f"- differing pixels: {r['diff_pixels']} "
                     f"({pct(r['diff_ratio'])}); over tolerance: "
                     f"{r['exceed_pixels']} ({pct(r['exceed_ratio'])})")
        lines.append(f"- max channel delta: {r['max_channel_delta']}/255; "
                     f"mean channel delta: {r['mean_channel_delta']:.3f}")
        if r["exceed_bbox"]:
            x0, y0, x1, y1 = r["exceed_bbox"]
            lines.append(f"- over-tolerance region: "
                         f"[{x0},{y0}]–[{x1},{y1}]")
        lines.append(f"- diff image: `{r['diff_image']}` "
                     f"(red = over tolerance, gray = amplified small delta)")
        lines.append("")
    with open(os.path.join(out, "report.md"), "w") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
