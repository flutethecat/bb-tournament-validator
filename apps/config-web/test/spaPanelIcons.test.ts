import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Content-panel band icons (owner 10-30): CSS-only wiring in home.css, PNGs in public/icons/panel.
const css = readFileSync(new URL("../spa/src/home/home.css", import.meta.url), "utf8");
const section = css.slice(css.indexOf("/* ---- Panel band icons"));
const PUBLIC = new URL("../public/", import.meta.url);

describe("panel band icons", () => {
  it("every referenced icon exists on disk", () => {
    const urls = [...section.matchAll(/url\((\/icons\/[a-z]+\/[a-z-]+\.png)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThanOrEqual(14);
    for (const u of new Set(urls)) expect(existsSync(fileURLToPath(new URL(u.slice(1), PUBLIC))), u).toBe(true);
  });

  it("base ::before rule: 22 px pixelated box beside the band title, no content of its own", () => {
    const base = section.match(/\.hm-band h2::before, #ac-conn-h::before \{([^}]*)\}/);
    expect(base).not.toBeNull();
    expect(base![1]).toMatch(/display: inline-block; width: 22px; height: 22px;/);
    expect(base![1]).toMatch(/margin: -4px 8px -4px 0; vertical-align: middle;/);
    expect(base![1]).toMatch(/background-size: contain; image-rendering: pixelated;/);
    // no `content` in the base: headings without a per-panel rule generate no (broken) box
    expect(base![1]).not.toMatch(/content:/);
    // and the base never resets background-image (a shorthand would beat the per-panel id rules on the flex bands)
    expect(section).not.toMatch(/background: no-repeat/);
  });

  it("keys the coach page panels by their heading ids", () => {
    for (const [id, icon] of [
      ["hm-new-h", "news"], ["nf-h", "notifications"], ["hm-deadlines-h", "deadlines"], ["rc-recent-h", "games"],
      ["hm-friends-h", "friends"], ["hm-messages-h", "messages"], ["hm-teams-h", "teams"], ["hm-account-h", "account"],
      ["ac-identity-h", "identity"], ["ac-calendar-h", "calendar"], ["ac-conn-h", "connections"], ["ac-sched-h", "schedule"],
    ]) {
      const rule = section.split("\n").find((l) => l.includes(`#${id}`) && l.includes("background-image"));
      expect(rule, id).toContain(`/icons/panel/${icon}.png`);
    }
  });
});
