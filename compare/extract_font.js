// Extracts the test suite's FontA TTF (font_a_base64 in test/test.cpp) and
// writes it as a binary .ttf so that both renderers can use the identical
// font: canvas_ity parses the TTF itself, Chromium gets it via @font-face.
//
// Usage: node extract_font.js <repo_root> <out_file.ttf> [--base64]

"use strict";

const fs = require("fs");
const path = require("path");

function main() {
  const [, , repoRoot, outFile, flag] = process.argv;
  if (!repoRoot || !outFile) {
    console.error("usage: node extract_font.js <repo_root> <out.ttf> [--base64]");
    process.exit(2);
  }
  const src = fs.readFileSync(path.join(repoRoot, "test", "test.cpp"), "utf8");
  const m = src.match(/font_a_base64\[\]\s*=\s*((?:\s*"[A-Za-z0-9+/=]*")+)\s*;/);
  if (!m) throw new Error("font_a_base64 not found in test.cpp");
  const base64 = m[1].replace(/["\s]/g, "");
  const bytes = Buffer.from(base64, "base64");
  if (flag === "--base64") {
    fs.writeFileSync(outFile, base64);
  } else {
    fs.writeFileSync(outFile, bytes);
  }
  console.log(`font extracted (${bytes.length} bytes) -> ${outFile}`);
}

main();
