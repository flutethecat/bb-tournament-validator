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
