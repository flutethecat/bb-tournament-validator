import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackageFiles } from "../src/data";
import { packagesApi } from "../src/packagesApi";
import { bootRules, readPublic, runPage, type RouteHandler } from "./tournamentRulesHarness";

const html = readPublic("tournament-rules.html");
const css = readPublic("tournament-rules.css");

function cssClasses(source: string): Set<string> {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/url\([^)]*\)/g, "");
  return new Set([...stripped.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]!));
}

describe("Tournament Creator — page shell", () => {
  it("uses the Tournament Team Builder console header, theme tokens and theme toggle", () => {
    expect(html).toContain('class="console-shell"');
    expect(html).toContain('class="brand-lockup"');
    expect(html).toContain('class="console-tabs"');
    expect(html).toContain('<script src="./theme.js" defer></script>');
    expect(html).toContain('href="./theme.css"');
    expect(html).toContain('href="./tournament-rules.css"');
    expect(html).not.toContain("team-builder.css");
    // The active tab is this page; the coach-facing Tournament Builder stays public; organiser links are gated.
    expect(html).toMatch(/<a class="active" href="\/tournament-rules.html" aria-current="page">Tournament Creator<\/a>/);
    expect(html).toContain("<title>Super FUMBBL — Tournament Creator</title>");
    expect(html).toContain("<span>T</span>ournament <span>C</span>reator</h1>");
    expect(html).not.toMatch(/Rules Construction/);
    expect(html).toMatch(/<a href="\/tournament-team-builder.html">Tournament Builder<\/a>/);
    for (const href of ["/tournaments.html", "/users.html", "/team-builder.html"]) {
      expect(html).toMatch(new RegExp(`<a href="${href}" data-admin-only hidden>`));
    }
    expect(html).toMatch(/id="fork-admin-link"[^>]*data-admin-only hidden/);
  });

  it("styles headings in Nuffle and colours from the theme tokens (both presets)", () => {
    expect(css).toMatch(/\.view-title,[\s\S]*?\.section-title,[\s\S]*?\{ font-family: var\(--font-heading/);
    expect(css).toContain("--carmine: var(--ui-primary");
    expect(css).toContain("--panel: color-mix(in srgb, var(--ui-surface-2");
    expect(css).toContain(':root[data-theme="light"]');
    for (const selector of [".console-shell", ".console-tabs a.active", ".session-button", ".create-button", ".package-card", ".rules-tabs button.active", ".rules-tab-panel"]) {
      expect(css).toContain(`${selector} {`);
    }
  });
});

describe("Tournament Creator — booted page", () => {
  it("reveals the organiser nav links only for an admin / organiser session", async () => {
    const admin = await bootRules({ authenticated: true, admin: true, coach: "Jay" });
    expect(admin.adminLinks.every((link) => link.hidden === false)).toBe(true);
    expect(admin.elements["#fork-admin-link"]!.href).toBe("http://127.0.0.1:22227/panel.html");

    const organizer = await bootRules({ authenticated: true, organizer: true, coach: "TO" });
    expect(organizer.adminLinks.every((link) => link.hidden === false)).toBe(true);

    const coach = await bootRules({ authenticated: true, coach: "Coach" });
    expect(coach.adminLinks.every((link) => link.hidden === true)).toBe(true);

    const anonymous = await bootRules({ authenticated: false });
    expect(anonymous.adminLinks.every((link) => link.hidden === true)).toBe(true);
  });

  it("keeps the organiser login toolbar: signed out shows the form, signed in shows Log out", async () => {
    const anonymous = await bootRules({ authenticated: false });
    const toolbar = anonymous.elements["#toolbar"]!.innerHTML;
    expect(toolbar).toContain('id="login-user"');
    expect(toolbar).toContain('id="login-password"');
    expect(toolbar).toContain('class="session-button" data-action="login"');
    expect(anonymous.elements["#right-rail"]!.innerHTML).toMatch(/class="create-button" data-action="save" disabled/);

    const admin = await bootRules({ authenticated: true, admin: true, coach: "Jay" });
    expect(admin.elements["#toolbar"]!.innerHTML).toContain('data-action="logout"');
    expect(admin.elements["#right-rail"]!.innerHTML).toMatch(/class="create-button" data-action="save">/);
  });

  it("lists saved packages as name-only card buttons", async () => {
    const page = await bootRules({ authenticated: true, admin: true });
    page.core.state.packageNames = ["Eurobowl 2026", "Small Gods"];
    page.core.state.selectedPackage = "Small Gods";
    page.core.render();
    const shelf = page.elements["#package-shelf"]!.innerHTML;
    expect(shelf).toContain('<button type="button" class="package-card" data-action="open-package" data-name="Eurobowl 2026" aria-pressed="false"><strong>Eurobowl 2026</strong></button>');
    expect(shelf).toContain('class="package-card selected" data-action="open-package" data-name="Small Gods"');
    expect(shelf).toContain('data-action="select-preset"');
    expect(shelf).toContain('data-action="new-package"');
  });

  it("splits the editor into notebook tabs: Package · Races & Tiers · Skills · Stars · Inducements · Special · Summary", async () => {
    const page = await bootRules({ authenticated: true, admin: true });
    const editor = page.elements["#editor"]!;
    const labels = [...editor.innerHTML.matchAll(/role="tab"[^>]*><b>\d<\/b><span>([^<]+)<\/span>/g)].map((match) => match[1]);
    expect(labels).toEqual(["Package", "Races &amp; Tiers", "Skills", "Stars", "Inducements", "Special", "Summary"]);
    expect(editor.innerHTML).toContain('class="active" data-action="tab:package" aria-selected="true"');
    const sections: Record<string, string[]> = {
      package: ["Package Details", "Gold / Team-Value Cap"],
      races: ["Eligible Races", "Tournament System", "Team Rules"],
      skills: ["Skill Allotment", "Stat Increases", "Banned Skills"],
      stars: ["Star Players", "Star Packs"],
      inducements: ["Inducements"],
      special: ["Special Rules", "Sideline Staff"],
      summary: ["Ruleset Table Preview", "Package Summary", "Package JSON"],
    };
    for (const [tab, titles] of Object.entries(sections)) {
      page.core.handleEditorAction(`tab:${tab}`, { dataset: {} });
      const text = editor.innerHTML.replace(/<span>(.)<\/span>/g, "$1");
      expect(editor.innerHTML).toContain(`data-tab="${tab}"`);
      for (const heading of titles) expect(text).toContain(heading.replace("&", "&amp;"));
    }
  });

  it("the Summary tab previews the ruleset table from the server resolution (tier gold, per-roster gold, packs)", async () => {
    const files = new PackageFiles(mkdtempSync(join(tmpdir(), "bbtv-preview-")));
    const route: RouteHandler = (path, init) => packagesApi(files, init.method ?? "GET", path, new URLSearchParams(), init.body ? JSON.parse(init.body) : undefined) ?? { status: 404, body: {} };
    const page = await bootRules({ authenticated: true, admin: true }, { "/api/packages/preview": route });
    page.core.loadPackageIntoEditor({
      name: "Preview",
      skillAllotment: { skillPointBudget: 0 },
      tiers: [{ tier: 1, label: "Tier 1", rosters: ["Orc", "High Elf"], gold: 1225000, rosterGold: { "High Elf": 1260000 }, starPlayersAllowed: false, bannedStars: [], skillPackages: [{ gold: 1150000, skillPointBudget: 0, maxSkills: 6, maxSecondary: 1 }] }],
    }, []);
    page.core.handleEditorAction("tab:summary", { dataset: {} });
    expect(page.elements["#editor"]!.innerHTML).toContain("Resolving the package");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const editor = page.elements["#editor"]!.innerHTML.replace(/\s+</g, "<");
    expect(editor).toContain("<th>Tier 1</th><td>Orc 1225k, High Elf 1260k</td><td>1150k / 6 skills (up to 1 secondary)</td>");
    // With packs active the validator gives star access to the packs (this pack allows them).
    expect(editor).toContain("<td>max any</td></tr>");
  });
});

// admin.html / admin.js / admin.css retired (admin console v2, owner 11-04): the console lives at /app/admin; see spaAdminConsole.test.ts.
