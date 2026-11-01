// Contrast audit for both theme presets (owner 10-31: the light theme is derived from the dark one by
// tools/theme/derive-light.mjs). Parses the dark and light token blocks straight from the stylesheets, resolves var() /
// color-mix() / translucent values, and asserts the key text-on-surface pairs: WCAG 4.5:1 for body-size text, 3:1 for
// heading-sized band text and focus rings.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no block ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1] ?? ""] = (m[2] ?? "").trim();
  return out;
}

const theme = read("public/theme.css");
const home = read("spa/src/home/home.css");
const builder = read("spa/src/teams/builder.css");
const teams = read("spa/src/teams/teams.css");
const tabletop = read("spa/src/tabletop/tabletop.css");

const DARK: Record<string, string> = {
  ...block(theme, "/* Fixed semantics"),
  ...block(theme, ':root[data-theme="brand-red"] {'),
  ...block(home, ":root {"),
  ...block(builder, ".tb-page {"),
  ...block(teams, ".tm-page {"),
  ...block(tabletop, ".tt-pcard {"),
};
const LIGHT: Record<string, string> = {
  ...DARK,
  ...block(theme, ':root[data-theme="light"] {'),
  ...block(home, ':root[data-theme="light"] {'),
  ...block(builder, ':root[data-theme="light"] .tb-page {'),
  ...block(teams, ':root[data-theme="light"] .tm-page {'),
  ...block(tabletop, ':root[data-theme="light"] .tt-pcard {'),
};
const DARK_REC: Record<string, string> = { ...DARK, ...block(tabletop, ".tt-rec {") };
const LIGHT_REC: Record<string, string> = { ...LIGHT, ...block(tabletop, ".tt-rec {"), ...block(tabletop, ':root[data-theme="light"] .tt-rec { --seat') };

type RGBA = [number, number, number, number];
type RGB = [number, number, number];
const at = (m: RegExpExecArray, i: number): string => m[i] ?? "";
function resolve(tokens: Record<string, string>, value: string, depth = 0): RGBA {
  if (depth > 12) throw new Error(`cycle at ${value}`);
  const v = value.trim();
  let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  if (m) return [parseInt(at(m, 1), 16), parseInt(at(m, 2), 16), parseInt(at(m, 3), 16), 1];
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)$/i.exec(v);
  if (m) return [+at(m, 1), +at(m, 2), +at(m, 3), m[4] === undefined ? 1 : m[5] ? +m[4] / 100 : +m[4]];
  m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(v);
  if (m) { const own = tokens[at(m, 1)]; return resolve(tokens, own ?? at(m, 2), depth + 1); }
  m = /^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*(.+?)(?:\s+(\d+)%)?\)$/.exec(v);
  if (m) {
    const a = resolve(tokens, at(m, 1), depth + 1), b: RGBA = at(m, 3) === "transparent" ? [0, 0, 0, 0] : resolve(tokens, at(m, 3), depth + 1);
    const w = +at(m, 2) / 100, k = (x: number, y: number): number => x * w + y * (1 - w);
    return [k(a[0], b[0]), k(a[1], b[1]), k(a[2], b[2]), k(a[3], b[3])];
  }
  throw new Error(`cannot resolve ${v}`);
}
/** An opaque colour: translucent tokens are composited over --ui-surface (where the panels sit). */
function solid(tokens: Record<string, string>, name: string): RGB {
  const c = resolve(tokens, name.startsWith("--") ? `var(${name})` : name);
  if (c[3] >= 1) return [c[0], c[1], c[2]];
  const u = resolve(tokens, "var(--ui-surface)"), k = (x: number, y: number): number => x * c[3] + y * (1 - c[3]);
  return [k(c[0], u[0]), k(c[1], u[1]), k(c[2], u[2])];
}
const lin = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: RGB): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (f: RGB, g: RGB): number => { const x = lum(f), y = lum(g); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const SURFACES = ["--ui-secondary", "--ui-surface", "--ui-surface-2", "--sf-panel-top", "--sf-panel-bottom"];
const CHIP = ["--ui-surface-2", "--tb-skillbar"];
// [label, ink, backgrounds, minimum]
const PAIRS: Array<[string, string, string[], number]> = [
  ["body text", "--ui-text", SURFACES, 4.5],
  ["muted text", "--ui-muted", SURFACES, 4.5],
  ["heading red on panel", "--ui-heading", SURFACES, 4.5],
  ["gold (nav/page title) on panel", "--sf-gold", SURFACES, 4.5],
  ["gold (team sheet) on panel", "--ui-gold", SURFACES, 4.5],
  ["seat blue on panel", "--sf-seat-home", SURFACES, 4.5],
  ["seat red on panel", "--sf-seat-away", SURFACES, 4.5],
  ["link (--ui-accent) on surface", "--ui-accent", ["--ui-secondary", "--ui-surface"], 4.5],
  ["chip: general", "--ui-skill-general", CHIP, 4.5],
  ["chip: agility", "--ui-skill-agility", CHIP, 4.5],
  ["chip: strength", "--ui-skill-strength", CHIP, 4.5],
  ["chip: passing", "--ui-skill-passing", CHIP, 4.5],
  ["chip: mutation", "--ui-skill-mutation", CHIP, 4.5],
  ["chip: trait (also extraordinary, which has no ink of its own)", "--ui-skill-trait", CHIP, 4.5],
  ["skills band muted", "--tb-skillbar-muted", ["--tb-skillbar"], 4.5],
  ["coach LED on panel", "--ui-coach-led", SURFACES, 4.5],
  ["heading red, band size", "--ui-heading", SURFACES, 3],
  ["focus ring", "--ui-focus", SURFACES, 3],
  ["on-danger ink on a danger fill", "--ui-on-danger", ["--ui-danger"], 4.5],
  ["red X badge ink on heading red", "--tb-badge-ink", ["--ui-heading"], 4.5],
];
// The recorder / game page scoreboard: its coach names sit on the seat-tint gradients (--tt-home / --tt-away -> --tt-panel),
// so both ends of each gradient are audited, with the recorder's own token scope.
const PAIRS_REC: Array<[string, string, string[], number]> = [
  ["recorder coach name on the home tint (both ends)", "--ui-coach-led", ["--tt-home", "--tt-panel"], 4.5],
  ["recorder coach name on the away tint (both ends)", "--ui-coach-led", ["--tt-away", "--tt-panel"], 4.5],
];
// Dark-preset pairs that are below the bar today. The dark preset is not changed by this audit; listed so the gap is visible
// and the test fails if a new one appears (or if one of these is fixed, so the list stays honest).
const DARK_KNOWN_LOW = new Set([
  "muted text", "heading red on panel", "link (--ui-accent) on surface",
  "chip: general", "chip: strength", "chip: mutation", "chip: trait (also extraordinary, which has no ink of its own)", // on the lighter dark skills band
  "on-danger ink on a danger fill", "red X badge ink on heading red", // white on the bright dark-theme reds
]);

export function auditTable(): Array<{ label: string; theme: string; worst: number; on: string; min: number }> {
  const rows: Array<{ label: string; theme: string; worst: number; on: string; min: number }> = [];
  const sets = [["dark", DARK, PAIRS], ["light", LIGHT, PAIRS], ["dark", DARK_REC, PAIRS_REC], ["light", LIGHT_REC, PAIRS_REC]] as const;
  for (const [themeName, tokens, pairs] of sets) {
    for (const [label, ink, bgs, min] of pairs) {
      let worst = Infinity, on = "";
      for (const bg of bgs) { const r = ratio(solid(tokens, ink), solid(tokens, bg)); if (r < worst) { worst = r; on = bg; } }
      rows.push({ label, theme: themeName, worst: Math.round(worst * 100) / 100, on, min });
    }
  }
  return rows;
}

describe("theme contrast audit", () => {
  const rows = auditTable();
  if (process.env.THEME_AUDIT) console.table(rows);

  it("light preset: every audited pair clears its bar", () => {
    const low = rows.filter((r) => r.theme === "light" && r.worst < r.min);
    expect(low).toEqual([]);
  });

  it("dark preset: every audited pair clears its bar, apart from the listed known gaps", () => {
    const low = rows.filter((r) => r.theme === "dark" && r.worst < r.min).map((r) => r.label);
    expect(new Set(low)).toEqual(DARK_KNOWN_LOW);
  });

  it("the light palette is the derivation's output (tools/theme/derive-light.mjs --check)", () => {
    const out = execFileSync(process.execPath, [fileURLToPath(new URL("../tools/theme/derive-light.mjs", import.meta.url)), "--check"], { encoding: "utf8" });
    expect(out).toContain("light blocks match the derivation");
  });

  it("the light preset is named light everywhere (no FUMBBL preset left)", () => {
    for (const css of [theme, home, builder, teams, tabletop, read("spa/src/shared/result-card.css"), read("public/team-builder.css"), read("public/tournament-rules.css"), read("public/team-view.css"), read("public/rules-page.css")]) {
      expect(css).not.toContain('data-theme="fumbbl"');
      expect(css).not.toContain('data-tt-theme="snes"');
    }
    expect(read("spa/src/theme.ts")).toContain('light: "light"');
    expect(read("public/theme.js")).toContain('var PRESETS = ["brand-red", "light"];');
  });
});
