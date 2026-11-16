// Generates the self-contained Chromium replay page.  The page embeds the
// CompareFont TTF (as a data URI), every case's op stream, and a small
// interpreter that replays each stream onto a real browser canvas, then
// publishes the resulting pixels as PNG data URLs inside
// <pre id="results"> for --dump-dom extraction.
//
// Usage: node make_page.js <out_dir>
//   reads  <out_dir>/manifest.json, <out_dir>/ops/*.ops, <out_dir>/font.b64
//   writes <out_dir>/chromium_page.html

"use strict";

const fs = require("fs");
const path = require("path");

function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: node make_page.js <out_dir>");
    process.exit(2);
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  const fontB64 = fs.readFileSync(
    path.join(outDir, "font.b64"), "utf8").trim();
  const casesData = {};
  for (const c of manifest) {
    casesData[c.name] = fs.readFileSync(path.join(outDir, c.ops), "utf8");
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>canvas comparison replay</title></head>
<body>
<script>
"use strict";
// --- data embedded by make_page.js ---
const FONT_B64 = ${JSON.stringify(fontB64)};
const CASES = ${JSON.stringify(casesData)};
const ORDER = ${JSON.stringify(manifest.map((c) => c.name))};

function hex8(r, g, b, a) {
  const h = (v) => v.toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b) + h(a);
}

function unhex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return new TextDecoder("utf-8").decode(bytes);
}

// Replays one op stream (see record_ops.js) onto a 2D context.
function replay(opsText, ctx) {
  const gradients = new Map();
  for (const line of opsText.split("\\n")) {
    if (!line) continue;
    const t = line.split(" ");
    const op = t[0];
    const n = (i) => parseFloat(t[i]);
    switch (op) {
      case "canvas": break;
      case "save": ctx.save(); break;
      case "restore": ctx.restore(); break;
      case "beginPath": ctx.beginPath(); break;
      case "closePath": ctx.closePath(); break;
      case "fill": ctx.fill(); break;
      case "stroke": ctx.stroke(); break;
      case "clip": ctx.clip(); break;
      case "moveTo": ctx.moveTo(n(1), n(2)); break;
      case "lineTo": ctx.lineTo(n(1), n(2)); break;
      case "quadraticCurveTo":
        ctx.quadraticCurveTo(n(1), n(2), n(3), n(4)); break;
      case "bezierCurveTo":
        ctx.bezierCurveTo(n(1), n(2), n(3), n(4), n(5), n(6)); break;
      case "arc": ctx.arc(n(1), n(2), n(3), n(4), n(5), t[6] === "1"); break;
      case "arcTo": ctx.arcTo(n(1), n(2), n(3), n(4), n(5)); break;
      case "rect": ctx.rect(n(1), n(2), n(3), n(4)); break;
      case "fillRect": ctx.fillRect(n(1), n(2), n(3), n(4)); break;
      case "strokeRect": ctx.strokeRect(n(1), n(2), n(3), n(4)); break;
      case "setTransform":
        ctx.setTransform(n(1), n(2), n(3), n(4), n(5), n(6)); break;
      case "translate": ctx.translate(n(1), n(2)); break;
      case "rotate": ctx.rotate(n(1)); break;
      case "scale": ctx.scale(n(1), n(2)); break;
      case "transform":
        ctx.transform(n(1), n(2), n(3), n(4), n(5), n(6)); break;
      case "fillColor":
        ctx.fillStyle = hex8(+t[1], +t[2], +t[3], +t[4]); break;
      case "strokeColor":
        ctx.strokeStyle = hex8(+t[1], +t[2], +t[3], +t[4]); break;
      case "linearGradient":
        gradients.set(+t[1], {
          obj: ctx.createLinearGradient(n(2), n(3), n(4), n(5)) });
        break;
      case "radialGradient":
        gradients.set(+t[1], {
          obj: ctx.createRadialGradient(
            n(2), n(3), n(4), n(5), n(6), n(7)) });
        break;
      case "colorStop":
        gradients.get(+t[1]).obj.addColorStop(
          n(2), hex8(+t[3], +t[4], +t[5], +t[6]));
        break;
      case "fillGradient":
        ctx.fillStyle = gradients.get(+t[1]).obj; break;
      case "strokeGradient":
        ctx.strokeStyle = gradients.get(+t[1]).obj; break;
      case "lineWidth": ctx.lineWidth = n(1); break;
      case "lineCap": ctx.lineCap = t[1]; break;
      case "lineJoin": ctx.lineJoin = t[1]; break;
      case "miterLimit": ctx.miterLimit = n(1); break;
      case "lineDashOffset": ctx.lineDashOffset = n(1); break;
      case "setLineDash": {
        const count = +t[1];
        ctx.setLineDash(t.slice(2, 2 + count).map(parseFloat));
        break;
      }
      case "globalAlpha": ctx.globalAlpha = n(1); break;
      case "font": ctx.font = t[1] + "px CompareFont"; break;
      case "textAlign": ctx.textAlign = t[1]; break;
      case "textBaseline": ctx.textBaseline = t[1]; break;
      case "fillText": ctx.fillText(unhex(t[1]), n(2), n(3)); break;
      case "strokeText": ctx.strokeText(unhex(t[1]), n(2), n(3)); break;
      default: throw new Error("unknown op: " + op);
    }
  }
}

function runAll() {
  const results = {};
  for (const name of ORDER) {
    const opsText = CASES[name];
    const m = opsText.split("\\n")[0].split(" ");
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    replay(opsText, ctx);
    results[name] = canvas.toDataURL("image/png");
  }
  const pre = document.createElement("pre");
  pre.id = "results";
  pre.textContent = JSON.stringify(results);
  document.body.textContent = "";
  document.body.appendChild(pre);
}

window.addEventListener("load", () => {
  const face = new FontFace(
    "CompareFont", "url(data:font/ttf;base64," + FONT_B64 + ")");
  face.load().then((loaded) => {
    document.fonts.add(loaded);
    return document.fonts.load("16px CompareFont");
  }).then(() => {
    runAll();
  }).catch((err) => {
    document.body.textContent = "REPLAY-ERROR: " + (err && err.stack || err);
  });
});
</script>
</body>
</html>
`;
  const outFile = path.join(outDir, "chromium_page.html");
  fs.writeFileSync(outFile, html);
  console.log("chromium replay page -> " + outFile);
}

main();
