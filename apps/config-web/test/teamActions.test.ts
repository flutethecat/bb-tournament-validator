import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advancementItems, createAdvancementCache, teamActions } from "../src/teamActions.js";
import { tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";

const no = { available: false };
const yes = { available: true };
const methods = (over: Record<string, { available: boolean }> = {}) => ({ randomPrimary: no, chosenPrimary: no, chosenSecondary: no, characteristic: no, ...over });
const player = (number: number, over: Record<string, unknown> = {}) => ({ number, name: `P${number}`, status: "Active", pendingAdvancement: null, advancementMethods: methods(), ...over });
const detail = (players: unknown[]) => ({ players }) as never;

describe("team actions (red badge on My teams tiles)", () => {
  it("counts a pending roll and an affordable advancement per player, once each", () => {
    const items = advancementItems(detail([
      player(1),
      player(2, { pendingAdvancement: { token: "t" }, advancementMethods: methods({ randomPrimary: yes }) }),
      player(3, { advancementMethods: methods({ chosenPrimary: yes, characteristic: yes }) }),
      player(4, { status: "Dead", advancementMethods: methods({ characteristic: yes }) }),
    ]));
    expect(items).toEqual(["#2 P2: finish the advancement roll", "#3 P3: advancement available"]);
  });

  it("retired teams and Secondary-only affordability add nothing", () => {
    expect(advancementItems(detail([player(1, { advancementMethods: methods({ chosenSecondary: yes }) })]))).toEqual([]);
    expect(advancementItems(detail([player(1, { pendingAdvancement: { token: "t" } })]), true)).toEqual([]);
  });

  it("registrations with roster problems add one item each; clean ones add none", () => {
    const a = teamActions(["x"], [{ tournamentId: "t1", tournamentName: "Spring Cup", problems: 2 }, { tournamentId: "t2", tournamentName: "Open", problems: 0 }]);
    expect(a).toEqual({ count: 2, items: ["x", "Spring Cup: 2 roster problems"] });
    expect(teamActions([], [])).toEqual({ count: 0, items: [] });
  });

  describe("cache", () => {
    let dir = "";
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });
    it("recomputes only when the team file's mtime or size changes", () => {
      dir = mkdtempSync(join(tmpdir(), "team-actions-"));
      const file = join(dir, "team_Alice_77.xml");
      writeFileSync(file, "<team/>");
      const cached = createAdvancementCache();
      let calls = 0;
      const compute = () => { calls++; return [`run ${calls}`]; };
      expect(cached(dir, "77", compute)).toEqual(["run 1"]);
      expect(cached(dir, "77", compute)).toEqual(["run 1"]);
      expect(calls).toBe(1);
      writeFileSync(file, "<team>changed</team>");
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      expect(cached(dir, "77", compute)).toEqual(["run 2"]);
      // no file at all: never cached
      expect(cached(dir, "404", compute)).toEqual(["run 3"]);
      expect(cached(dir, "404", compute)).toEqual(["run 4"]);
    });
  });

  it("saves lookup: registrations and actions only for the coach's own list", async () => {
    const deps = {
      repo: {} as never, isBanned: () => false, isOrganizer: () => false, loadTeamFile: () => undefined,
      listTeams: () => [{ ref: "library:1", name: "Orcs", race: "Orc", tv: 1100, registered: [{ id: "t1", name: "Spring Cup" }], actions: { count: 2, items: ["a", "b"] } }],
    } as unknown as TabletopApiDeps;
    const call = (me: string) => tabletopApi("GET", "/api/tabletop/saves", { coach: me, method: "discord" }, undefined, deps, new URLSearchParams("coach=Alice")) as Promise<TabletopResult>;
    const own = (await call("alice")).body as { teams: Array<Record<string, unknown>> };
    expect(own.teams[0]).toEqual({ ref: "library:1", name: "Orcs", race: "Orc", tv: 1100, registered: [{ id: "t1", name: "Spring Cup" }], actions: { count: 2, items: ["a", "b"] } });
    const other = (await call("Bob")).body as { teams: Array<Record<string, unknown>> };
    expect(other.teams[0]).toEqual({ ref: "library:1", name: "Orcs", race: "Orc", tv: 1100 });
  });
});
