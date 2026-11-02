import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

// Site-wide typography (owner 11-02, design.md §4): Nuffle is retired; band header rows use SNES Italic
// (--sf-band-title-font); everything else is the Roster Builder's sans-serif stack (--font-body), with its bold face for
// titles, captions and chips (--font-heading, --sf-band-font). The wordmark keeps SNES Italic.
const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" || e.name === "assets" ? [] : files(`${dir}/${e.name}`, ext)) : ext.test(e.name) ? [`${dir}/${e.name}`] : []);
}
/** The style text of a file: a whole .css file, or the <style> blocks of a .vue file. */
const styleOf = (path: string): string => {
  const src = read(path);
  if (!path.endsWith(".vue")) return src;
  return [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
};
const theme = read("public/theme.css");
const home = read("spa/src/home/home.css");
const token = (css: string, name: string): string => new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim() ?? "";

describe("typography: tokens", () => {
  it("--font-body is the Roster Builder's sans-serif stack, and --font-heading is its bold face over the same stack", () => {
    const body = token(theme, "--font-body");
    expect(body).toBe('"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif');
    expect(token(theme, "--font-heading")).toBe(`"SF Sans Bold", ${body}`);
    // the bold alias maps installed bold faces only (no font file is shipped), for every weight
    const face = /@font-face \{[^}]*font-family: "SF Sans Bold";[^}]*\}/.exec(theme)?.[0] ?? "";
    expect(face).toMatch(/src: local\("Helvetica Neue Bold"\)[^;]*local\("Arial Bold"\)/);
    expect(face).not.toMatch(/url\(/);
    expect(face).toMatch(/font-weight: 100 900;/);
  });

  it("the Roster Builder body reads --font-body (the stack the site matches)", () => {
    expect(read("spa/src/style.css")).toMatch(/body \{[^}]*font-family: var\(--font-body, sans-serif\);/);
    expect(read("public/team-builder.css")).toMatch(/font-family: var\(--font-body\);/);
  });

  it("band rows use SNES Italic; captions and chips the bold sans; the wordmark keeps SNES", () => {
    expect(token(home, "--sf-band-title-font")).toBe('"SNES", var(--font-heading, sans-serif)');
    expect(token(home, "--sf-band-font")).toBe("var(--font-heading, sans-serif)");
    expect(token(home, "--sf-wordmark-font")).toBe('"SNES", var(--font-heading, sans-serif)');
    expect(home).toMatch(/\.hm-band h2 \{[^}]*font: \d+px\/[\d.]+ var\(--sf-band-title-font\);/);
    expect(home).toMatch(/\.sf-wordmark\.brand \{[^}]*font-family: var\(--sf-wordmark-font\);/);
  });

  it("SNES only claims the glyphs it draws, so a hyphen or middle dot in a band title falls back to the sans", () => {
    for (const path of ["spa/src/home/home.css", "public/tournament-rules.css"]) {
      const face = /@font-face \{[^}]*font-family: "SNES";[^}]*\}/.exec(read(path))?.[0] ?? "";
      expect(face, path).toMatch(/unicode-range: U\+0020-0021, U\+0027, U\+002C, U\+002E, U\+0030-0039, U\+003F, U\+0041-005A, U\+0061-007A;/);
    }
  });
});

describe("typography: Nuffle is retired", () => {
  // Allow-list: none. "Prayers to Nuffle" is game copy in .ts/.vue templates, never in a stylesheet.
  const ALLOWED: string[] = [];
  it("no stylesheet (SPA, Lobby, public pages) names the Nuffle family or loads its file", () => {
    const sheets = [...files("spa/src", /\.(css|vue)$/), ...files("lobby/src", /\.(css|vue)$/), ...files("public", /\.css$/)];
    expect(sheets.length).toBeGreaterThan(20);
    const offenders = sheets.filter((p) => !ALLOWED.includes(p) && /nuffle/i.test(stripComments(styleOf(p))));
    expect(offenders).toEqual([]);
    expect(theme).not.toMatch(/Nuffle\.otf/);
  });

  it("no stylesheet asks for a display face the site does not ship (the old Silkscreen fallback drew Nuffle)", () => {
    const sheets = [...files("spa/src", /\.(css|vue)$/), ...files("public", /\.css$/)];
    expect(sheets.filter((p) => /silkscreen/i.test(stripComments(styleOf(p))))).toEqual([]);
  });
});

// ---- UI scale (owner 11-02: "this should be roughly default sizes")
describe("UI scale", () => {
  const home = read("spa/src/home/home.css");
  it("one token scales the whole UI by CSS zoom: 1.25 desktop, 1.15 small desktop, 1.1 tablet, 1 phone", () => {
    expect(home).toMatch(/html \{ --sf-zoom: 1; \}/);
    expect(home).toMatch(/@media screen and \(min-width: 768px\) \{ html \{ --sf-zoom: 1\.1; \} \}/);
    expect(home).toMatch(/@media screen and \(min-width: 1600px\) and \(min-height: 860px\) \{ html:not\(\[data-sf-zoom-off\]\) \{ --sf-zoom: 1\.25; \} \}/);
    expect(home).toMatch(/@media screen and \(min-width: 1367px\) and \(min-height: 700px\) \{\s*html \{ --sf-zoom: 1\.15; \}/);
    expect(home).toMatch(/body \{ zoom: var\(--sf-zoom\); \}/);
  });
  it("every viewport height in the SPA divides by the zoom (viewport units are zoomed with the page); the recorder undoes the zoom", () => {
    // (vw inside a font-size clamp may stay: it only grows the type with the rest of the page)
    const offenders: string[] = [];
    for (const file of files("spa/src", /\.(css|vue)$/)) {
      if (file.endsWith("tabletop/tabletop.css")) continue; // the recorder runs at zoom 1 (below)
      const css = stripComments(styleOf(file));
      for (const m of css.matchAll(/\d+d?vh\b[^;]*/g)) if (!/\/ var\(--sf-zoom, 1\)/.test(m[0])) offenders.push(`${file}: ${m[0].slice(0, 60)}`);
    }
    expect(offenders).toEqual([]);
    expect(read("spa/src/tabletop/tabletop.css")).toContain(".tt-rec:not(.tt-rec--final):not(.cp-host) { zoom: calc(1 / var(--sf-zoom, 1)); }");
  });
});
