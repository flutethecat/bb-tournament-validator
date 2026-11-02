import { describe, expect, it } from "vitest";
import { feedRows } from "../spa/src/tabletop/feed";
import { createTabletopList } from "../spa/src/tabletop/list";
import { createRecorder, type RecordedEvent } from "../spa/src/tabletop/recorder";
import type { Fetcher } from "../spa/src/session";
import { memoryStorage } from "../spa/src/tabletop/queue";

// SPA side of lane recorderadmin: the admin inducement edit in the log and the recorder controller, and the tabletop
// Team Captain calls of the New match form's controller.

const match = { home: { coach: "Alice", teamName: "Humans" }, away: { coach: "Bob", teamName: "Orcs" } };
const teams = { home: { name: "Humans", players: [] }, away: { name: "Orcs", players: [] } };
const ind = (id: string, team: "home" | "away", payload: Record<string, unknown>, admin = false): RecordedEvent =>
  ({ id, type: "inducement", team, payload: { picks: [{ id: "extra_team_training", name: "Extra Team Training", qty: 2 }], ...payload }, by: admin ? "Org" : "Alice", ...(admin ? { admin: true } : {}) });

describe("the log shows an organiser's inducement edit", () => {
  const events = [
    ind("pg-inducement-away", "away", { lobby: true }),
    ind("adm-ind-away-1", "away", { adminEdit: true, replaces: "pg-inducement-away" }, true),
    ind("adm-ind-away-1-pc", "home", { adminEdit: true, followsFrom: "adm-ind-away-1" }, true),
  ];
  const rows = feedRows(events, events.map((e) => e.id), teams, {}, match, null);

  it("in the admin colour, with its own sentence; the lobby record stays", () => {
    expect(rows.map((r) => [r.id, r.admin, r.rest])).toEqual([
      ["pg-inducement-away", false, " buys 2 x Extra Team Training."],
      ["adm-ind-away-1", true, " inducements changed by an organiser: 2 x Extra Team Training."],
      ["adm-ind-away-1-pc", true, " petty cash re-priced: 2 x Extra Team Training."],
    ]);
  });

  it("only the edit itself offers undo (never the lobby record or the petty-cash follow-on), and it is marked organiser-only", () => {
    expect(rows.map((r) => [r.id, r.undoable, r.adminEdit === true])).toEqual([
      ["pg-inducement-away", false, false], ["adm-ind-away-1", true, true], ["adm-ind-away-1-pc", false, true],
    ]);
  });
});

describe("recorder controller: Edit inducements", () => {
  it("loads the picker and posts an edit (client id, picks or skip), then reloads the match", async () => {
    const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = [];
    const api = (async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, init });
      if (path.endsWith("/inducements") && !init) return { editable: true, current: { home: [], away: [] } };
      if (path.endsWith("/inducements")) return { match: { id: "tm_x", state: "recording" } };
      return { match: { id: "tm_x", state: "recording", home: match.home, away: match.away }, events: [], effectiveEventIds: [], teams };
    }) as Fetcher;
    const rec = createRecorder("tm_x", { api, onSignedOut: () => undefined, storage: memoryStorage() });
    expect(await rec.inducementMenu()).toMatchObject({ editable: true });
    await rec.editInducements("away", [{ id: "extra_team_training", qty: 2 }]);
    await rec.editInducements("home", "skip");
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts.map((c) => c.path)).toEqual(["/api/tabletop/matches/tm_x/inducements", "/api/tabletop/matches/tm_x/inducements"]);
    expect(posts[0]!.init!.body).toMatchObject({ team: "away", picks: [{ id: "extra_team_training", qty: 2 }], id: expect.stringMatching(/^[\w-]{8,64}$/) });
    expect(posts[1]!.init!.body).toMatchObject({ team: "home", skip: true });
    expect(rec.state.actionError).toBe("");
  });
});

describe("New match form: tabletop Team Captain", () => {
  it("reads the captaincy and appoints with the revision; a refusal comes back as text", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const api = (async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, body: init?.body });
      if (init?.method === "POST" && (init.body as { playerId: string }).playerId === "ogre") throw new Error("A Big Guy cannot be Team Captain.");
      if (init?.method === "POST") return { ok: true };
      return { vacant: true, revision: 3, teamName: "Humans", players: [{ id: "p2", name: "Blitzer", spp: 0, mng: false, dead: false }] };
    }) as Fetcher;
    const list = createTabletopList({ api, coach: () => "Alice", onSignedOut: () => undefined });
    const info = await list.captainInfo("Alice", "save:sv_a");
    expect(calls[0]!.path).toBe("/api/tabletop/teams/captain?coach=Alice&team=save%3Asv_a");
    expect(info).toMatchObject({ vacant: true, revision: 3 });
    expect(await list.appointCaptain("Alice", "save:sv_a", "p2", 3)).toBe("");
    expect(calls[1]).toEqual({ path: "/api/tabletop/teams/captain", body: { coach: "Alice", team: "save:sv_a", playerId: "p2", revision: 3 } });
    expect(await list.appointCaptain("Alice", "save:sv_a", "ogre", 3)).toBe("A Big Guy cannot be Team Captain.");
  });
});
