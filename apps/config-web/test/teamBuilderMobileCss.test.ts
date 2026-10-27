import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Owner 10-27 mobile view: the phone/tablet tiers live in a delimited section at the end of team-builder.css.
// Every width query there must be screen-scoped so a print engine (Letter landscape ~1056 CSS px) never picks up
// the tablet/phone rules and changes the roster-sheet geometry.
const css = readFileSync(new URL("../public/team-builder.css", import.meta.url), "utf8");
const marker = "MOBILE + TABLET VIEW";

describe("team builder css — mobile section", () => {
  const start = css.indexOf(marker);
  const section = css.slice(start);

  it("has the delimited mobile section", () => {
    expect(start).toBeGreaterThan(0);
  });

  it("scopes every width media query in the section to screen", () => {
    const queries = [...section.matchAll(/@media\s+([^{]+)\{/g)].map((m) => (m[1] ?? "").trim());
    const widthQueries = queries.filter((q) => /width/.test(q));
    expect(widthQueries.length).toBeGreaterThanOrEqual(3);
    for (const q of widthQueries) expect(q, q).toMatch(/^screen and \(/);
    expect(section).not.toMatch(/@media\s+\(/);
  });

  it("gives the phone roster row actions 48 px hit areas", () => {
    expect(section).toMatch(/\.remove-player \{ min-width: 48px; min-height: 48px; \}/);
    expect(section).toMatch(/\.skill-add-btn \{ min-width: 48px; min-height: 48px;/);
  });

  it("resets the screen-only spacing for print", () => {
    expect(section).toMatch(/@media print \{\s*body \{ min-width: 0; padding-bottom: 0; \}/);
  });
});
