import { describe, expect, it } from "vitest";
import { activeTab, clubFacts, manageLocation, SECTION_UP, tabFromQuery, tabLocation, visibleTabs } from "../spa/src/shell/sectionNav";
import { registerBody } from "../spa/src/tournaments/registration";
import { joinBody } from "../spa/src/leagues/registration";
import { NAV_ICON, NAV_OPEN_DEFAULTS } from "../spa/src/home/nav";
import { notificationIcon } from "../spa/src/home/notifications";
import { wdl, winRate } from "../spa/src/clubs/clubs";

// The Clubs section in the SPA: the shared section header's club tabs (Overview, Members, Results, Stats, Board - the Board
// live, not "soon"), the cog route, the club pick in the join bodies, the nav category and the notification icon.

describe("club section nav", () => {
  it("shows the five club tabs in order, all links; ?tab=stats is Stats; the cog is club-manage", () => {
    const tabs = visibleTabs("club", "harbour", clubFacts());
    expect(tabs.map((t) => [t.id, t.label, Boolean(t.soon)])).toEqual([
      ["overview", "Overview", false], ["members", "Members", false], ["results", "Results", false], ["statistics", "Stats", false], ["board", "Board", false],
    ]);
    expect(tabLocation("club", "harbour", "statistics")).toEqual({ name: "club-detail", params: { id: "harbour" }, query: { tab: "stats" } });
    expect(tabFromQuery("club", "stats")).toBe("statistics");
    expect(tabFromQuery("club", "board")).toBe("board");
    expect(manageLocation("club", "harbour")).toEqual({ name: "club-manage", params: { id: "harbour" }, query: {} });
    expect(activeTab("club", { name: "club-manage" })).toBe("manage");
    expect(SECTION_UP.club).toEqual({ to: "/clubs", label: "All clubs", noun: "Club" });
    // other sections keep Board as "soon"
    expect(visibleTabs("league", "l", {}).find((t) => t.id === "board")?.soon).toBe(true);
  });
});

describe("club pick in the join bodies", () => {
  it("sends clubId only when a club is picked", () => {
    expect(registerBody({ teamRef: "save:a", region: "", share: [], notNafMember: false, clubId: "harbour" }, false)).toMatchObject({ clubId: "harbour" });
    expect(registerBody({ teamRef: "save:a", region: "", share: [], notNafMember: false, clubId: "" }, false)).not.toHaveProperty("clubId");
    expect(joinBody({ teamRef: "save:a", region: "", share: [], acknowledged: true, clubId: "harbour" }, false)).toMatchObject({ clubId: "harbour" });
    expect(joinBody({ teamRef: "save:a", region: "", share: [], acknowledged: true }, false)).not.toHaveProperty("clubId");
  });
});

describe("nav, notifications and helpers", () => {
  it("adds the Clubs category (open by default) with an existing icon, and a club notification icon", () => {
    expect(NAV_OPEN_DEFAULTS.clubs).toBe(true);
    expect(NAV_ICON("clubs")).toBe("/icons/panel/friends.png");
    expect(NAV_ICON("leagues")).toBe("/icons/nav/leagues.png");
    expect(notificationIcon("club")).toBe("/icons/panel/friends.png");
    expect(wdl({ wins: 3, draws: 1, losses: 2 })).toBe("3-1-2");
    expect(winRate({ games: 4, wins: 2, draws: 1 })).toBe("63%");
    expect(winRate({ games: 0, wins: 0, draws: 0 })).toBe("-");
  });
});
