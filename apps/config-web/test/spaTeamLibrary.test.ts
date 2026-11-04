import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyBody, editTeamQuery, entryCoachLine, entryHistoryLine, libraryGroups, librarySub, libraryTv, myLiveApplication, needsPlayedPrompt, pendingFor, playedPrompt,
  type LibraryItem, type TakeoverPanelView,
} from "../spa/src/leagues/takeover";
import { entryHistoryLine as serverLine } from "../src/leagues/teamLibrary";
import { clearedPlayedOn, fixtureRowEdit, zonedInput, zonedToIso } from "../spa/src/leagues/league";
import type { LeagueFixture } from "../spa/src/leagues/types";

// Team library lane, SPA side: the swap dialog's library groups and greyed rows, the entry history line (same words as
// the server), the takeover panel's helpers (my live application, pending applications, the played-games prompt that
// opens the approve-and-edit modal), the apply body (share step for non-members only), and the placement rule: the
// takeover panel lives on the league overview only, never in Browse leagues (round answer Q8).

const SPA = fileURLToPath(new URL("../spa/src/", import.meta.url));
const read = (p: string) => readFileSync(join(SPA, p), "utf8");
const walk = (dir: string): string[] => readdirSync(join(SPA, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

describe("library helpers", () => {
  const items: LibraryItem[] = [
    { ref: "league:a/s/t", kind: "league", name: "Old", race: "Human", tv: 1_200_000, source: "A Season 1", ok: false, reason: "Built for BB2020; this season plays BB2025." },
    { ref: "save:1", kind: "save", name: "New", race: "Orc", tv: 650_000, ok: true },
    { ref: "save:x", kind: "save", name: "Lib", race: "Dwarf", tv: 1_050, ok: true },
  ];
  it("groups in the dialog's order and keeps the reason on greyed rows", () => {
    expect(libraryGroups(items).map((g) => g.kind)).toEqual(["save", "league"]); // saved teams and league teams only (owner 11-03)
    expect(libraryGroups(items).map((g) => g.label)).toEqual(["Saved teams", "League teams"]);
    expect(libraryGroups(items)[1]!.items[0]!.reason).toContain("BB2020");
    expect(libraryGroups([items[1]!]).map((g) => g.kind)).toEqual(["save"]);
  });
  it("shows gold and fork-library thousands alike", () => {
    expect(libraryTv(650_000)).toBe("650k");
    expect(libraryTv(1_050)).toBe("1,050k");
    expect(libraryTv(null)).toBe("");
    expect(librarySub(items[0]!)).toBe("Human · 1,200k · A Season 1");
    // a private team (never shared by the coach) carries no details at all
    expect(librarySub({ race: "", tv: null, private: true })).toBe("Not shared: the coach approves the swap");
    expect(librarySub({ race: "", tv: null, private: true, ok: false })).toBe("");
  });
});

describe("entry history", () => {
  const spans = [
    { name: "Team A", coach: "Ann", fromGame: 1, toGame: 5 },
    { name: "Team B", coach: "Ann", fromGame: 6, toGame: 6 },
    { name: "Team B", coach: "Dan", fromGame: 7 },
  ];
  it("reads like the spec and matches the server", () => {
    expect(entryHistoryLine(spans)).toBe("Team A (games 1-5), Team B (game 6), Team B (games 7-)");
    expect(entryHistoryLine(spans)).toBe(serverLine(spans));
    expect(entryHistoryLine([{ name: "X", fromGame: 1, toGame: 0 }, { name: "Y", fromGame: 1 }])).toBe("X (no games), Y (games 1-)");
    expect(entryHistoryLine(undefined)).toBe("");
  });
  it("names the coaches only when they changed", () => {
    expect(entryCoachLine(spans)).toBe("Ann, then Dan from game 7");
    expect(entryCoachLine(spans.slice(0, 2))).toBe("");
  });
});

describe("takeover panel helpers", () => {
  const view: TakeoverPanelView = {
    member: false,
    listings: [],
    mine: [
      { id: "ta-1", listingId: "tk-1", teamId: "t", listedTeam: "T", state: "declined", mode: "team", enteredAt: "" },
      { id: "ta-2", listingId: "tk-1", teamId: "t", listedTeam: "T", state: "pending", mode: "takeover", enteredAt: "" },
    ],
    applications: [
      { id: "ta-3", listingId: "tk-1", teamId: "t", listedTeam: "T", coachId: "Eve", state: "pending", mode: "team", enteredAt: "", games: 3 },
      { id: "ta-4", listingId: "tk-1", teamId: "t", listedTeam: "T", coachId: "Bob", state: "declined", mode: "team", enteredAt: "" },
      { id: "ta-5", listingId: "tk-2", teamId: "u", listedTeam: "U", coachId: "Dan", state: "pending", mode: "takeover", enteredAt: "", games: 3 },
    ],
  };
  it("finds my live application and the pending ones per listing", () => {
    expect(myLiveApplication(view, "tk-1")!.id).toBe("ta-2");
    expect(myLiveApplication(view, "tk-2")).toBeUndefined();
    expect(pendingFor(view, "tk-1").map((a) => a.id)).toEqual(["ta-3"]);
  });
  it("asks before approving a substituted team for an entry that has played, and opens edit mode", () => {
    expect(needsPlayedPrompt(view.applications![0]!)).toBe(true);
    expect(needsPlayedPrompt({ mode: "team", games: 0 })).toBe(false);
    expect(needsPlayedPrompt(view.applications![2]!)).toBe(false); // a takeover keeps the team
    expect(playedPrompt(3)).toBe("This team has played 3 games. Approve and then edit?");
    expect(playedPrompt(1)).toBe("This team has played 1 game. Approve and then edit?");
    expect(editTeamQuery("s7", "grudge")).toEqual({ season: "s7", tab: "participants", team: "grudge", edit: "1" });
  });
  it("sends the share step only for coaches new to the league", () => {
    const d = { mode: "team" as const, teamRef: "save:1", share: ["email" as const], acknowledged: true };
    expect(applyBody(d, false)).toEqual({ mode: "team", teamRef: "save:1", share: ["email"], acknowledged: true });
    expect(applyBody(d, true)).toEqual({ mode: "team", teamRef: "save:1" });
    expect(applyBody({ ...d, mode: "takeover" }, true)).toEqual({ mode: "takeover" });
  });
});

describe("placement and style", () => {
  it("the takeover panel is on the league overview only, never in Browse leagues", () => {
    const users = walk("").filter((p) => /\.(vue|ts)$/.test(p) && read(p).includes("LeagueTakeoverPanel"));
    expect(users.map((p) => p.replace(/\\/g, "/")).sort()).toEqual(["views/LeagueDetailView.vue"]);
    const view = read("views/LeagueDetailView.vue");
    const at = view.indexOf("<LeagueTakeoverPanel");
    expect(view.lastIndexOf('v-if="tab === \'overview\'"', at)).toBeGreaterThan(0);
    expect(view.slice(view.lastIndexOf('v-if="tab === \'overview\'"', at), at)).not.toContain('v-else-if="tab');
    for (const p of ["leagues/browse.ts", "views/LeagueListView.vue"]) expect(read(p)).not.toMatch(/takeover/i);
  });
  it("the cog offers Swap team and Available for takeover; ?edit=1 opens edit mode", () => {
    const teams = read("components/LeagueTeams.vue");
    expect(teams).toContain("data-cog-swap");
    expect(teams).toContain("data-cog-takeover");
    expect(teams).toContain('route.query.edit === "1"');
    // the coach's transfer option (default off) and the swap dialog's member picker (another member's shared teams)
    expect(teams).toContain("data-permit-transfer");
    expect(teams).toContain("Permit league transfer");
    expect(read("components/TeamSwapDialog.vue")).toContain("data-swap-owner");
  });
  it("takeover.css uses tokens only", () => {
    const css = read("leagues/takeover.css");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});

describe("re-entering a cleared result", () => {
  it("the editor's played-on defaults to when the cleared result was played (a correction stays with its coach)", () => {
    const side = (extra = {}) => ({ team: "T", coach: "Dan", race: "Human", score: null, cas: null, conceded: false, ...extra });
    const f = { id: "f1", home: side({ clearedPlayedBy: { coach: "Ann", at: "2026-10-11T20:00:00.000Z" } }), away: side() } as unknown as LeagueFixture;
    expect(clearedPlayedOn(f)).toBe("2026-10-11T20:00");
    // a date AND time in the league's time zone (a same-day replay is told apart from the takeover by the time)
    expect(clearedPlayedOn(f, "America/New_York")).toBe("2026-10-11T16:00");
    expect(fixtureRowEdit(f, "America/New_York").playedOn).toBe("2026-10-11T16:00");
    expect(clearedPlayedOn({ ...f, home: side() } as unknown as LeagueFixture)).toBe("");
    const editor = readFileSync(join(SPA, "components/LeagueFixturesEditor.vue"), "utf8");
    expect(editor).toContain("data-played-on");
  });
});

describe("played-on times in the league's time zone", () => {
  it("converts a datetime-local value both ways, across a DST change", () => {
    expect(zonedToIso("2026-11-03T19:30", "America/New_York")).toBe("2026-11-04T00:30:00.000Z"); // EST
    expect(zonedToIso("2026-10-11T16:00", "America/New_York")).toBe("2026-10-11T20:00:00.000Z"); // EDT
    expect(zonedToIso("2026-11-03T19:30", "UTC")).toBe("2026-11-03T19:30:00.000Z");
    expect(zonedInput("2026-11-04T00:30:00.000Z", "America/New_York")).toBe("2026-11-03T19:30");
    expect(zonedToIso("soon", "UTC")).toBe("");
    expect(zonedInput(undefined, "UTC")).toBe("");
    const editor = readFileSync(join(SPA, "components/LeagueFixturesEditor.vue"), "utf8");
    expect(editor).toContain('type="datetime-local"');
  });
});
