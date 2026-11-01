#!/usr/bin/env node
// Light theme DERIVED from the dark theme (owner 10-31: "hue shift the majority of our colors to light from the dark theme").
// Reads the dark token values in dark-tokens.json, maps each in OKLCH by its role (hue kept), and prints the light values.
//   node tools/theme/derive-light.mjs           print the light palette (JSON)
//   node tools/theme/derive-light.mjs --write   write the values into the light token blocks named per token
//   node tools/theme/derive-light.mjs --check   exit 1 when a light block differs from the derivation
//
// Rules (L = OKLCH lightness 0..1, C = chroma, H = hue, kept unless stated):
//   surface    a soft light grey, never near-white (owner 10-31: "too bright, can we go with a lighter grey?"):
//              L' = 0.815 + 0.3 L, clamped 0.80..0.93, so the dark order is kept: page 0.815, panels/cards ~0.86,
//              raised controls ~0.89, the skills band 0.93; C' = 0.5 C (tinted neutrals, not pastels).
//              A gradient pair (pairTop) gives its top stop the lighter of the two, so panels stay lit from above.
//              'dl' nudges one surface's L (the hover tint sits 0.015 above its mapped L so it reads on the panels).
//              A translucent surface keeps its alpha (contrast is measured composited over its 'over' token).
//   line       L' = 0.80 - 0.3 L, clamped 0.68..0.74; C' = 0.6 C.
//   drop       a soft mid-grey shadow: L' = 0.62 - 0.3 L; C' = 0.5 C.
//   highlight  the top bevel stays light: L' = 0.96; C' = 0.3 C.
//   tint       a seat tint (recorder corners, TD/CAS fills): muted mid-light, L' = 0.72, C' = 0.3 C (not a pastel wash).
//   bevel      compound shadow: white highlight alphas x3.2 (cap 0.6), black alphas x0.45.
//   shade      black overlay alpha x0.8 (badge lines, drops).
//   ink        L' = 1.13 - L, clamped 0.18..0.62; C' = C; then L steps down until it clears 'min' on every 'on' colour.
//   accent     starts at the dark value; L steps down (C clipped to the sRGB gamut) until it clears 'min' on every 'on' colour.
//   fixed      unchanged (white on fills, badge outlines, Discord etc. never appear here).
//   calc       a helper colour computed from light tokens (not written), for 'on' lists.
// 'key' gives a second derivation of the same CSS name its own id (e.g. the recorder's coach LED, re-derived against the seat tints).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

// ---- colour math (sRGB <-> OKLab, Ottosson) --------------------------------------------------------------------------
const toLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGam = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
export function rgbToOklch([r, g, b]) {
  const [R, G, B] = [r, g, b].map((v) => toLin(v / 255));
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb), (Math.atan2(bb, a) * 180) / Math.PI];
}
function oklchToLinear([L, C, H]) {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = (lin) => lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
/** OKLCH -> sRGB 0..255, chroma reduced until it fits the gamut (hue and lightness kept). */
export function oklchToRgb([L, C, H]) {
  let c = C;
  while (c > 0 && !inGamut(oklchToLinear([L, c, H]))) c = Math.max(0, c - 0.002);
  return oklchToLinear([L, c, H]).map((v) => Math.round(Math.min(1, Math.max(0, toGam(Math.min(1, Math.max(0, v))))) * 255));
}

// ---- parsing / formatting ----------------------------------------------------------------------------------------------
export function parseColour(str) {
  const s = str.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return { rgb: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)), a: 1 };
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return { rgb: [...m[1]].map((h) => parseInt(h + h, 16)), a: 1 };
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)$/i.exec(s);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : m[5] ? +m[4] / 100 : +m[4] };
  throw new Error(`not a colour: ${str}`);
}
const hex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
const fmt = (rgb, a) => (a >= 1 ? hex(rgb) : `rgb(${rgb.join(" ")} / ${+a.toFixed(2)})`);
const mix = (p, q, w) => p.map((v, i) => Math.round(v * w + q[i] * (1 - w)));

// ---- WCAG contrast -----------------------------------------------------------------------------------------------------
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => toLin(v / 255)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (p, q) => { const x = lum(p), y = lum(q); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// ---- the derivation ----------------------------------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const surfaceL = (L) => clamp(0.815 + 0.3 * L, 0.8, 0.93);

export function derive(spec) {
  const out = new Map(); // name -> { value, rgb (opaque, for contrast) }
  const groups = spec.groups ?? {};
  const resolveRgb = (ref) => {
    if (ref.startsWith("#") || ref.startsWith("rgb")) return parseColour(ref).rgb;
    const hit = out.get(ref);
    if (!hit) throw new Error(`'${ref}' is not derived yet`);
    return hit.rgb;
  };
  const onList = (t) => (t.on ?? []).flatMap((r) => (r.startsWith("@") ? groups[r] : [r])).map(resolveRgb);
  const darkOf = (t) => {
    if (typeof t.dark === "object") { const [p, w, q] = t.dark.mix; return { rgb: mix(parseColour(p).rgb, parseColour(q).rgb, w), a: 1 }; }
    return parseColour(t.dark);
  };
  const clears = (rgb, bgs, min) => bgs.every((bg) => contrast(rgb, bg) >= min);
  const stepDown = (lch, bgs, min) => {
    let [L, C, H] = lch;
    let rgb = oklchToRgb([L, C, H]);
    while (!clears(rgb, bgs, min) && L > 0.05) { L -= 0.005; rgb = oklchToRgb([L, C, H]); }
    return rgb;
  };

  const pending = new Map();
  for (const t of spec.tokens) {
    let value, rgb;
    if (t.role === "fixed") { value = t.dark; rgb = /^#|^rgb/.test(t.dark) ? parseColour(t.dark).rgb : [0, 0, 0]; }
    else if (t.role === "calc") { const [p, w, q] = t.light.mix; rgb = mix(resolveRgb(p), resolveRgb(q), w); value = hex(rgb); }
    else if (t.role === "bevel") {
      value = t.dark.replace(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/g, (_, r, g, b, a) => {
        const white = +r > 128;
        const na = white ? Math.min(0.6, +a * 3.2) : +a * 0.45;
        return `rgb(${r} ${g} ${b} / ${+na.toFixed(2)})`;
      });
      rgb = [0, 0, 0];
    } else if (t.role === "shade") { const c = parseColour(t.dark); value = `rgb(${c.rgb.join(" ")} / ${Math.round(c.a * 80)}%)`; rgb = c.rgb; }
    else {
      const d = darkOf(t);
      const [L, C, H] = rgbToOklch(d.rgb);
      let lch;
      if (t.role === "surface") lch = [surfaceL(L) + (t.dl ?? 0), C * 0.5, H];
      else if (t.role === "line") lch = [clamp(0.8 - 0.3 * L, 0.68, 0.74), C * 0.6, H];
      else if (t.role === "drop") lch = [0.62 - 0.3 * L, C * 0.5, H];
      else if (t.role === "highlight") lch = [0.96, C * 0.3, H];
      else if (t.role === "tint") lch = [0.72, C * 0.3, H];
      else if (t.role === "ink") lch = [clamp(1.13 - L, 0.18, 0.62), C, H];
      else if (t.role === "accent") lch = [L, C, H];
      else throw new Error(`unknown role ${t.role}`);
      if (t.role === "ink" || t.role === "accent") rgb = stepDown(lch, onList(t), t.min ?? 4.5);
      else rgb = oklchToRgb(lch);
      if (t.pairTop) pending.set(t.pairTop, { top: t.name, lch, a: d.a, over: t.over });
      const pair = pending.get(t.name);
      if (pair && t.role === "surface" && pair.lch[0] < lch[0]) {
        // the top stop takes the lighter value of the pair
        const top = out.get(pair.top);
        const myRgb = rgb;
        rgb = oklchToRgb(pair.lch);
        top.value = fmt(myRgb, pair.a);
        top.rgb = mix(myRgb, resolveRgb(pair.over), pair.a);
      }
      value = fmt(rgb, d.a);
      if (d.a < 1) rgb = mix(rgb, resolveRgb(t.over), d.a);
    }
    out.set(t.key ?? t.name, { name: t.name, value, rgb, blocks: t.blocks ?? [] }); // key: a second derivation of one CSS name (a scoped override)
  }
  return out;
}

// ---- block I/O ---------------------------------------------------------------------------------------------------------
function blockRange(css, selector) {
  let start = css.indexOf(selector);
  if (start < 0 && selector.includes("\n")) start = css.indexOf(selector.replace(/\n/g, "\r\n")); // CRLF checkouts
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  const end = css.indexOf("}", open);
  return [open + 1, end];
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function main() {
  const spec = JSON.parse(readFileSync(resolve(HERE, "dark-tokens.json"), "utf8"));
  const out = derive(spec);
  const mode = process.argv[2];
  if (!mode) {
    console.log(JSON.stringify(Object.fromEntries([...out].filter(([, v]) => v.blocks.length).map(([k, v]) => [k, v.value])), null, 2));
    return;
  }
  const files = new Map();
  const problems = [];
  for (const { name, value, blocks } of out.values()) {
    for (const b of blocks) {
      const def = spec.blocks[b];
      const path = resolve(ROOT, def.file);
      if (!files.has(path)) files.set(path, readFileSync(path, "utf8"));
      let css = files.get(path);
      const range = blockRange(css, def.selector);
      if (!range) { problems.push(`${def.file}: no block '${def.selector.trim()}'`); continue; }
      const body = css.slice(range[0], range[1]);
      const re = new RegExp(`(${esc(name)}:\\s*)([^;]+)(;)`);
      const m = re.exec(body);
      if (!m) { problems.push(`${def.file} [${b}]: ${name} missing`); continue; }
      if (m[2].trim() !== value) {
        if (mode === "--check") problems.push(`${def.file} [${b}]: ${name} is ${m[2].trim()}, derived ${value}`);
        else { css = css.slice(0, range[0]) + body.replace(re, `$1${value}$3`) + css.slice(range[1]); files.set(path, css); }
      }
    }
  }
  if (mode === "--write") for (const [path, css] of files) writeFileSync(path, css);
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log(mode === "--check" ? "light blocks match the derivation" : "light blocks written");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
