// Recorder: runs the fixed drawing scripts in cases.js against a recording
// mock of the Canvas 2D API and emits an implementation-neutral op stream
// per case (out/ops/<name>.ops) plus a manifest (out/manifest.json).
//
// The op stream is the "same fixed script" that both renderers replay:
//   - compare/render_canvasity.cpp replays it through canvas_ity
//   - the generated Chromium page replays it through the browser canvas
//
// Op stream format: plain text, one op per line, arguments separated by
// single spaces.  Numbers are JS shortest-round-trip decimals.  Colors are
// 8-bit integer channels.  Text strings are hex-encoded UTF-8.
//
// Usage: node record_ops.js <out_dir>

"use strict";

const fs = require("fs");
const path = require("path");
const { cases } = require("./cases.js");

function fmt(x) {
  if (!Number.isFinite(x)) throw new Error("non-finite coordinate: " + x);
  return String(x);
}

function parseColor(str) {
  str = str.trim();
  let m;
  if ((m = str.match(/^#([0-9a-fA-F]{3})$/))) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
    return [r, g, b, 255];
  }
  if ((m = str.match(/^#([0-9a-fA-F]{6})$/))) {
    const v = m[1];
    return [
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
      255,
    ];
  }
  if ((m = str.match(/^#([0-9a-fA-F]{8})$/))) {
    const v = m[1];
    return [
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
      parseInt(v.slice(6, 8), 16),
    ];
  }
  if ((m = str.match(/^rgba?\(([^)]+)\)$/))) {
    const parts = m[1].split(",").map((s) => parseFloat(s));
    const [r, g, b] = parts;
    const a = parts.length > 3 ? Math.round(parts[3] * 255) : 255;
    return [r, g, b, a];
  }
  throw new Error("unsupported color: " + str);
}

class RecGradient {
  constructor(rec, id, kind, coords) {
    this.rec = rec;
    this.id = id;
    rec.ops.push(`${kind} ${id} ` + coords.map(fmt).join(" "));
  }
  addColorStop(offset, color) {
    const [r, g, b, a] = parseColor(color);
    this.rec.ops.push(
      `colorStop ${this.id} ${fmt(offset)} ${r} ${g} ${b} ${a}`);
  }
}

class RecCtx {
  constructor(ops) {
    this.ops = ops;
    this.gradients = new Map();
    this.nextGradient = 1;
    this._fillStyle = "#000000";
    this._strokeStyle = "#000000";
  }
  // --- state ---
  save() { this.ops.push("save"); }
  restore() { this.ops.push("restore"); }
  // --- paths ---
  beginPath() { this.ops.push("beginPath"); }
  closePath() { this.ops.push("closePath"); }
  moveTo(x, y) { this.ops.push(`moveTo ${fmt(x)} ${fmt(y)}`); }
  lineTo(x, y) { this.ops.push(`lineTo ${fmt(x)} ${fmt(y)}`); }
  quadraticCurveTo(cx, cy, x, y) {
    this.ops.push(`quadraticCurveTo ${fmt(cx)} ${fmt(cy)} ${fmt(x)} ${fmt(y)}`);
  }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    this.ops.push(
      `bezierCurveTo ${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ` +
      `${fmt(x)} ${fmt(y)}`);
  }
  arc(x, y, r, a0, a1, ccw = false) {
    this.ops.push(
      `arc ${fmt(x)} ${fmt(y)} ${fmt(r)} ${fmt(a0)} ${fmt(a1)} ` +
      (ccw ? "1" : "0"));
  }
  arcTo(x1, y1, x2, y2, r) {
    this.ops.push(`arcTo ${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(r)}`);
  }
  rect(x, y, w, h) {
    this.ops.push(`rect ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}`);
  }
  fill() { this.ops.push("fill"); }
  stroke() { this.ops.push("stroke"); }
  clip() { this.ops.push("clip"); }
  // --- rect conveniences ---
  fillRect(x, y, w, h) {
    this.ops.push(`fillRect ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}`);
  }
  strokeRect(x, y, w, h) {
    this.ops.push(`strokeRect ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}`);
  }
  // --- transforms ---
  setTransform(a, b, c, d, e, f) {
    this.ops.push(
      `setTransform ${[a, b, c, d, e, f].map(fmt).join(" ")}`);
  }
  translate(x, y) { this.ops.push(`translate ${fmt(x)} ${fmt(y)}`); }
  rotate(a) { this.ops.push(`rotate ${fmt(a)}`); }
  scale(x, y) { this.ops.push(`scale ${fmt(x)} ${fmt(y)}`); }
  transform(a, b, c, d, e, f) {
    this.ops.push(`transform ${[a, b, c, d, e, f].map(fmt).join(" ")}`);
  }
  // --- styles ---
  set fillStyle(v) {
    if (v instanceof RecGradient) {
      this.ops.push(`fillGradient ${v.id}`);
    } else {
      const [r, g, b, a] = parseColor(v);
      this.ops.push(`fillColor ${r} ${g} ${b} ${a}`);
    }
    this._fillStyle = v;
  }
  get fillStyle() { return this._fillStyle; }
  set strokeStyle(v) {
    if (v instanceof RecGradient) {
      this.ops.push(`strokeGradient ${v.id}`);
    } else {
      const [r, g, b, a] = parseColor(v);
      this.ops.push(`strokeColor ${r} ${g} ${b} ${a}`);
    }
    this._strokeStyle = v;
  }
  get strokeStyle() { return this._strokeStyle; }
  set lineWidth(w) { this.ops.push(`lineWidth ${fmt(w)}`); }
  set lineCap(v) { this.ops.push(`lineCap ${v}`); }
  set lineJoin(v) { this.ops.push(`lineJoin ${v}`); }
  set miterLimit(v) { this.ops.push(`miterLimit ${fmt(v)}`); }
  set lineDashOffset(v) { this.ops.push(`lineDashOffset ${fmt(v)}`); }
  setLineDash(segments) {
    this.ops.push(
      `setLineDash ${segments.length} ` + segments.map(fmt).join(" "));
  }
  set globalAlpha(a) { this.ops.push(`globalAlpha ${fmt(a)}`); }
  // --- gradients ---
  createLinearGradient(x0, y0, x1, y1) {
    const id = this.nextGradient++;
    return new RecGradient(this, id, "linearGradient", [x0, y0, x1, y1]);
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    const id = this.nextGradient++;
    return new RecGradient(this, id, "radialGradient", [x0, y0, r0, x1, y1, r1]);
  }
  // --- text ---
  set font(spec) {
    const m = String(spec).match(/^(\d+(?:\.\d+)?)px\s+(.+)$/);
    if (!m) throw new Error("unsupported font spec: " + spec);
    if (m[2].trim() !== "CompareFont")
      throw new Error("cases must use the CompareFont family: " + spec);
    this.ops.push(`font ${m[1]}`);
  }
  set textAlign(v) { this.ops.push(`textAlign ${v}`); }
  set textBaseline(v) { this.ops.push(`textBaseline ${v}`); }
  fillText(text, x, y) {
    const hex = Buffer.from(text, "utf8").toString("hex");
    this.ops.push(`fillText ${hex} ${fmt(x)} ${fmt(y)}`);
  }
  strokeText(text, x, y) {
    const hex = Buffer.from(text, "utf8").toString("hex");
    this.ops.push(`strokeText ${hex} ${fmt(x)} ${fmt(y)}`);
  }
}

function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: node record_ops.js <out_dir>");
    process.exit(2);
  }
  const opsDir = path.join(outDir, "ops");
  fs.mkdirSync(opsDir, { recursive: true });
  const manifest = [];
  for (const c of cases) {
    const ops = [`canvas ${c.width} ${c.height}`];
    const ctx = new RecCtx(ops);
    c.draw(ctx);
    if (ops.length < 2) throw new Error("case emitted no ops: " + c.name);
    const file = path.join(opsDir, c.name + ".ops");
    fs.writeFileSync(file, ops.join("\n") + "\n");
    manifest.push({
      name: c.name,
      category: c.category,
      description: c.description,
      width: c.width,
      height: c.height,
      ops: path.relative(outDir, file),
    });
  }
  fs.writeFileSync(
    path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`recorded ${manifest.length} cases -> ${opsDir}`);
}

main();
