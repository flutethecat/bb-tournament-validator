import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMatch, tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { TabletopEvent } from "../src/tabletop/events.js";
import type { TabletopPlayer, TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository, headRevision, type LobbyInducements, type MatchRecord } from "../src/tabletop/store.js";
import { TournamentResultStore } from "../src/tournamentResults.js";

// Two organiser tools on the tabletop recorder (lane recorderadmin, 11-02):
//  1. organiser edits of inducements after START (owner ruling 10-29, spec-landing-bubble-retro §9.2): admin-stamped events,
//     treasury follows the record in force, undo like other admin events, coaches refused;
//  2. Team Captain appointment on tabletop teams: appended, stamped revisions; the undo interactions.

let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
const files: Record<string, TabletopTeamFile> = {};
let managers: ((coach: string, match: MatchRecord) => boolean) | undefined;
const NOW = new Date("2026-03-01T10:00:00.000Z");

const player = (id: string, extra: Partial<TabletopPlayer> = {}): TabletopPlayer =>
  ({ id, name: `P ${id}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false, ...extra });
const linemen = (prefix: string, n: number, positionId: string) => Array.from({ length: n }, (_, i) => player(`${prefix}${i + 1}`, { positionId, positionName: "Lineman" }));
const team = (race: string, players: TabletopPlayer[], tv: number, treasury: number): TabletopTeamFile =>
  ({ schema: 1, name: `${race} XI`, race, treasury, dedicatedFans: 2, teamValue: tv, players });

const deps = (): TabletopApiDeps => ({
  repo, results,
  loadTeamFile: (coach, ref) => files[`${coach}/${ref}`],
  listSaves: (coach) => Object.keys(files).filter((k) => k.startsWith(`${coach}/`)).map((k) => ({ id: k.split("/")[1]!, name: files[k]!.name })),
  isBanned: () => false,
  drawSeats: () => false,
  isOrganizer: (c) => c === "Org",
  ...(managers ? { managesMatch: managers } : {}),
  now: () => NOW,
});
const as = async (coach: string, method: string, path: string, body?: unknown, query = ""): Promise<TabletopResult> =>
  (await tabletopApi(method, path, { coach, method: "discord" }, body, deps(), new URLSearchParams(query)))!;
let n = 0;
const E = (type: string, team: "home" | "away", player?: string, payload: Record<string, unknown> = {}) =>
  ({ id: `ev-${String(++n).padStart(6, "0")}`, type, team, ...(player ? { player } : {}), payload });
const view = async (id: string) => (await as("Org", "GET", `/api/tabletop/matches/${id}`)).body as Record<string, any>;
const editInd = (who: string, id: string, body: unknown) => as(who, "POST", `/api/tabletop/matches/${id}/inducements`, body);

const lobby = (picks: Array<[string, string, number, number]>, treasury: number, pettyCash: number): LobbyInducements => {
  const lines = picks.map(([id, name, qty, cost]) => ({ id, name, qty, cost: qty * cost }));
  return { picks: lines, total: lines.reduce((s, l) => s + l.cost, 0), treasury, pettyCash };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-recorderadmin-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  managers = undefined;
  for (const k of Object.keys(files)) delete files[k];
  // Alice: Humans, the lower team value (underdog). Bob: Black Orcs, the favourite (pays from treasury first).
  files["Alice/sv_a"] = team("Human", [
    player("cap", { positionId: "human.human_blitzer", positionName: "Blitzer", skills: ["Block", "Team Captain", "Pro"] }),
    player("blitz2", { positionId: "human.human_blitzer", positionName: "Blitzer", skills: ["Block"] }),
    player("thrower", { positionId: "human.human_thrower", positionName: "Thrower", skills: ["Sure Hands", "Pass", "Pro"] }),
    player("ogre", { positionId: "human.ogre", positionName: "Ogre", skills: ["Mighty Blow"] }),
    player("star", { kind: "star", positionName: "Griff Oberwald" }),
    ...linemen("al", 7, "human.human_lineman"),
  ], 1_000_000, 100_000);
  files["Bob/sv_b"] = team("Black Orc", linemen("b", 11, "black_orc.black_orc"), 1_200_000, 200_000);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A lobby-started match (pre-game skipped to playing): Bob bought 1 Extra Team Training from his treasury (100k);
 *  Alice, the underdog, has 200k gap + 100k = 300k petty cash and bought 3 (300k, no treasury). */
async function lobbyMatch(): Promise<string> {
  const r = await createMatch("Org", true, { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" }, postMatch: "full", pregame: "skip" }, deps(), () => NOW, {
    inducementsByCoach: {
      bob: lobby([["extra_team_training", "Extra Team Training", 1, 100_000]], 100_000, 0),
      alice: lobby([["extra_team_training", "Extra Team Training", 3, 100_000]], 0, 300_000),
    },
  });
  expect(r.status).toBe(201);
  return (r.body as { match: { id: string } }).match.id;
}
const ETT = (qty: number) => ({ picks: [{ id: "extra_team_training", qty }] });

describe("organiser edits of inducements after START", () => {
  it("only organisers (or the match's league / tournament managers) may read or edit; coaches and strangers are refused", async () => {
    const id = await lobbyMatch();
    for (const who of ["Alice", "Bob", "Mallory"]) {
      expect((await as(who, "GET", `/api/tabletop/matches/${id}/inducements`)).status).toBe(403);
      expect((await editInd(who, id, { team: "away", ...ETT(2) })).status).toBe(403);
    }
    const menu = await as("Org", "GET", `/api/tabletop/matches/${id}/inducements`);
    expect(menu.status).toBe(200);
    expect(menu.body).toMatchObject({
      editable: true, prayersLocked: true,
      current: { home: [{ id: "extra_team_training", qty: 3 }], away: [{ id: "extra_team_training", qty: 1 }] },
      budget: { away: { role: "favourite", treasury: 200_000 }, home: { role: "underdog", pettyCash: 300_000 } },
    });
    expect((menu.body as any).inducementOptions.home.some((o: { id: string }) => o.id === "extra_team_training")).toBe(true);

    // scoped: the host says who organises this match's league / tournament (a site organiser elsewhere is refused)
    managers = (c) => c === "Lea";
    expect((await editInd("Org", id, { team: "away", ...ETT(2) })).status).toBe(403);
    const lea = await editInd("Lea", id, { team: "away", ...ETT(2) }); // Lea is neither a seat nor a site organiser
    expect(lea.status).toBe(200);
    expect((await as("Lea", "GET", `/api/tabletop/matches/${id}/inducements`)).status).toBe(200);
  });

  it("records admin-stamped events (history kept) and moves the underdog's petty cash with the favourite's treasury spend", async () => {
    const id = await lobbyMatch();
    const r = await editInd("Org", id, { team: "away", ...ETT(2) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ treasury: { away: { before: 100_000, after: 200_000 }, home: { before: 0, after: 0 } } });
    const events = (await view(id)).events as TabletopEvent[];
    const ind = events.filter((e) => e.type === "inducement");
    expect(ind.map((e) => [e.team, e.admin === true, e.payload.adminEdit === true])).toEqual([
      ["home", false, false], ["away", false, false], // the lobby's records stay in the log
      ["away", true, true], ["home", true, true], // the edit and the underdog's petty-cash adjustment
    ]);
    expect(ind[2]).toMatchObject({ by: "Org", payload: { treasury: 200_000, total: 200_000, replaces: "pg-inducement-away", treasuryBefore: 100_000 } });
    expect(ind[3]).toMatchObject({ payload: { pettyCash: 400_000, treasury: 0, followsFrom: ind[2]!.id } });
    const v = await view(id);
    expect(v.pregame.inducements.away).toMatchObject({ treasury: 200_000, adminEdit: true });
    expect(v.tally.treasurySpent).toEqual({ home: 0, away: 200_000 });
    // a spectator sees the edit in the log, never the treasury figures
    const watched = (await as("Mallory", "GET", `/api/tabletop/matches/${id}`)).body as Record<string, any>;
    const shown = (watched.events as TabletopEvent[]).filter((e) => e.type === "inducement");
    expect(shown).toHaveLength(4);
    for (const e of shown) for (const k of ["treasury", "pettyCash", "treasuryBefore"]) expect(e.payload ?? {}).not.toHaveProperty(k);
  });

  it("the underdog may top up from its treasury (capped); an edit that leaves the other team over budget is refused", async () => {
    const id = await lobbyMatch();
    // Alice: 300k petty cash + at most 50k treasury
    expect((await editInd("Org", id, { team: "home", ...ETT(4) })).status).toBe(400);
    const r = await editInd("Org", id, { team: "home", picks: [{ id: "extra_team_training", qty: 3 }, { id: "team_mascot", qty: 1 }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ treasury: { home: { before: 0, after: 25_000 } } });
    // Bob dropping to nothing cuts Alice's petty cash to 200k: her 325k no longer fits
    const refused = await editInd("Org", id, { team: "away", skip: true });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toMatch(/Human XI over its budget.*Edit their inducements first/);
    expect((await editInd("Org", id, { team: "home", ...ETT(2) })).status).toBe(200);
    expect((await editInd("Org", id, { team: "away", skip: true })).body).toMatchObject({ treasury: { away: { before: 100_000, after: 0 } } });
  });

  it("the post-match treasury debit follows the edited record", async () => {
    const id = await lobbyMatch();
    expect((await editInd("Org", id, { team: "away", ...ETT(2) })).status).toBe(200);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("endOfMatch", "home")] })).status).toBe(200);
    for (const c of ["Alice", "Bob"]) expect((await as(c, "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
    expect(headRevision((await repo.getChain("Bob", "sv_b"))!).teamFile.treasury).toBe(0); // 200k - 200k
    expect(headRevision((await repo.getChain("Alice", "sv_a"))!).teamFile.treasury).toBe(100_000); // petty cash only
  });

  it("an edit after submit recomputes the preview and clears confirmations; after confirm it is refused", async () => {
    const id = await lobbyMatch();
    await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("endOfMatch", "home")] });
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
    const r = await editInd("Org", id, { team: "away", ...ETT(2) });
    expect(r.status).toBe(200);
    const m = (r.body as { match: MatchRecord }).match;
    expect(m.confirmations).toEqual({});
    expect(m.preview!.away.treasuryAfter).toBe(0);
    for (const c of ["Alice", "Bob"]) await as(c, "POST", `/api/tabletop/matches/${id}/confirm`);
    expect((await editInd("Org", id, { team: "away", ...ETT(1) })).status).toBe(409);
  });

  it("undo: organisers only, newest first, the petty-cash adjustment goes with its edit", async () => {
    const id = await lobbyMatch();
    const first = (await editInd("Org", id, { team: "away", ...ETT(2) })).body as { recorded: string[] };
    const [edit, adjust] = first.recorded as [string, string];
    // coaches cannot take an organiser's inducement edit back, even on their own side
    expect((await as("Bob", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("undo", "away", undefined, { target: edit })] })).status).toBe(403);
    // the adjustment is undone with its edit, never alone
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("undo", "home", undefined, { target: adjust })] })).status).toBe(400);
    // a newer edit sits on top: the older one cannot be undone
    const second = (await editInd("Org", id, { team: "home", ...ETT(2) })).body as { recorded: string[] };
    const older = await as("Org", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("undo", "away", undefined, { target: edit })] });
    expect(older.status).toBe(400);
    expect((older.body as { error: string }).error).toMatch(/most recent inducement edit/);
    // the stack: newest first, then the older edit together with its adjustment
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("undo", "home", undefined, { target: second.recorded[0] })] })).status).toBe(200);
    const u = await as("Org", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("undo", "away", undefined, { target: edit })] });
    expect(u.status).toBe(200);
    expect((u.body as { accepted: string[] }).accepted).toHaveLength(2);
    const v = await view(id);
    expect(v.events.filter((e: TabletopEvent) => e.type === "undo").every((e: TabletopEvent) => e.admin === true)).toBe(true);
    expect(v.effectiveEventIds).not.toContain(adjust);
    expect(v.pregame.inducements).toMatchObject({ away: { treasury: 100_000, lobby: true }, home: { pettyCash: 300_000, lobby: true } });
    expect(v.tally.treasurySpent).toEqual({ home: 0, away: 100_000 });
    // the lobby's own records still cannot be undone
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("undo", "away", undefined, { target: "pg-inducement-away" })] })).status).toBe(400);
  });

  it("Prayers to Nuffle cannot change once rolled; a retry with the same id is a no-op; the open pre-game step uses its own picker", async () => {
    const id = await lobbyMatch();
    expect((await editInd("Org", id, { team: "home", picks: [{ id: "extra_team_training", qty: 2 }, { id: "prayers_to_nuffle", qty: 1 }] })).status).toBe(409);
    const body = { team: "home", id: "client-edit-0001", ...ETT(2) };
    expect((await editInd("Org", id, body)).body).toMatchObject({ recorded: ["client-edit-0001"] });
    expect((await editInd("Org", id, body)).body).toMatchObject({ recorded: [], duplicates: ["client-edit-0001"] });
    // a match that did not come from the lobby: its inducements are chosen at the pre-game step
    files["Cat/sv_c"] = team("Human", linemen("c", 11, "human.human_lineman"), 1_000_000, 0);
    files["Dan/sv_d"] = team("Human", linemen("d", 11, "human.human_lineman"), 1_100_000, 0);
    const plain = await as("Cat", "POST", "/api/tabletop/matches", { home: { coach: "Cat", team: "sv_c" }, away: { coach: "Dan", team: "sv_d" } });
    const pid = (plain.body as { match: { id: string } }).match.id;
    expect((await editInd("Org", pid, { team: "home", ...ETT(1) })).body).toMatchObject({ error: "Inducements are chosen at the pre-game step." });
    expect((await as("Org", "GET", `/api/tabletop/matches/${pid}/inducements`)).body).toMatchObject({ editable: false, reason: "Inducements are chosen at the pre-game step." });
  });
});

describe("Team Captain appointment on tabletop teams", () => {
  const capPath = "/api/tabletop/teams/captain";
  /** A match in which Bob kills Alice's captain, confirmed by both: Alice's head revision is vacant. */
  async function captainKilled(): Promise<string> {
    const r = await as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" }, postMatch: "full", pregame: "skip" });
    const id = (r.body as { match: { id: string } }).match.id;
    expect((await as("Bob", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("casualty", "away", "b1", { victim: "cap", result: "DEAD" }), E("endOfMatch", "home")] })).status).toBe(200);
    for (const c of ["Alice", "Bob"]) expect((await as(c, "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
    return id;
  }
  const appoint = (who: string, playerId: string, revision: number, coach = "Alice") => as(who, "POST", capPath, { coach, team: "save:sv_a", playerId, revision });
  const capView = async (who = "Alice") => (await as(who, "GET", capPath, undefined, "coach=Alice&team=sv_a")).body as Record<string, any>;

  it("the team picker marks the vacancy; eligibility matches leagues (no Big Guy, Star, dead player); who may appoint", async () => {
    await captainKilled();
    const saves = (await as("Alice", "GET", "/api/tabletop/saves", undefined, "coach=Alice")).body as { teams: Array<{ ref: string; captainVacant?: true }> };
    expect(saves.teams).toEqual([expect.objectContaining({ ref: "sv_a", captainVacant: true })]);
    // an opponent's lookup gets the plain list; an organiser sees the mark
    expect(((await as("Bob", "GET", "/api/tabletop/saves", undefined, "coach=Alice")).body as any).teams[0].captainVacant).toBeUndefined();
    expect(((await as("Org", "GET", "/api/tabletop/saves", undefined, "coach=Alice")).body as any).teams[0].captainVacant).toBe(true);

    const v = await capView();
    expect(v).toMatchObject({ vacant: true, revision: 1, teamName: "Human XI" });
    const ids = (v.players as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain("blitz2");
    expect(ids).toContain("al1");
    for (const bad of ["cap", "ogre", "star"]) expect(ids).not.toContain(bad);

    expect((await as("Bob", "GET", capPath, undefined, "coach=Alice&team=sv_a")).status).toBe(403);
    expect((await appoint("Bob", "blitz2", 1)).status).toBe(403);
    expect((await appoint("Alice", "ogre", 1)).body).toMatchObject({ error: "A Big Guy cannot be Team Captain." });
    expect((await appoint("Alice", "star", 1)).body).toMatchObject({ error: "A Star Player cannot be Team Captain." });
    expect((await appoint("Alice", "cap", 1)).body).toMatchObject({ error: expect.stringMatching(/dead/) });
    expect((await as("Alice", "POST", capPath, { coach: "Alice", team: "sv_a", playerId: "blitz2" })).status).toBe(428);
    expect((await appoint("Alice", "blitz2", 0)).status).toBe(409); // stale revision
    // an organiser appoints for the coach (stamped admin)
    const ok = await appoint("Org", "thrower", 1);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ revision: 2, vacant: false, playerId: "thrower", skills: ["Sure Hands", "Pass", "Pro", "Team Captain"] });
    const chain = (await repo.getChain("Alice", "sv_a"))!;
    const head = headRevision(chain);
    expect(head).toMatchObject({ revision: 2, parent: 1, appointment: { by: "Org", admin: true, playerId: "thrower", grants: ["Team Captain"] } });
    expect(head.matchId).toBeUndefined();
    expect(head.teamFile.captainVacant).toBeUndefined();
    expect(head.teamFile.players.find((p) => p.id === "thrower")!.captainGrants).toEqual(["Team Captain"]); // already had Pro
    expect(chain.revisions[1]!.teamFile.captainVacant).toBe(true); // history untouched
    expect((await appoint("Alice", "blitz2", 2)).body).toMatchObject({ error: "This team already has a Team Captain." });
    expect(((await as("Alice", "GET", "/api/tabletop/saves", undefined, "coach=Alice")).body as any).teams[0].captainVacant).toBeUndefined();
  });

  it("the coach's own appointment grants Team Captain and Pro, recorded in captainGrants", async () => {
    await captainKilled();
    const ok = await appoint("Alice", "blitz2", 1);
    expect(ok.body).toMatchObject({ skills: ["Block", "Team Captain", "Pro"] });
    const head = headRevision((await repo.getChain("Alice", "sv_a"))!);
    expect(head.appointment).toMatchObject({ by: "Alice", admin: false, grants: ["Team Captain", "Pro"] });
  });

  it("undoing the match that killed the captain is blocked by the appointment until it is revoked; nothing is dropped silently", async () => {
    const id = await captainKilled();
    await appoint("Alice", "blitz2", 1);
    const blocked = await as("Org", "POST", `/api/tabletop/matches/${id}/undo-revision`);
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error: string }).error).toMatch(/appointed a new Team Captain after this match; revoke the appointment first/);
    expect((await repo.getChain("Alice", "sv_a"))!.head).toBe(2);
    // revoke: Bob may not; stale revision refused; the coach does
    expect((await as("Bob", "POST", `${capPath}/revoke`, { coach: "Alice", team: "sv_a", revision: 2 })).status).toBe(403);
    expect((await as("Alice", "POST", `${capPath}/revoke`, { coach: "Alice", team: "sv_a", revision: 1 })).status).toBe(409);
    const rv = await as("Alice", "POST", `${capPath}/revoke`, { coach: "Alice", team: "sv_a", revision: 2 });
    expect(rv.body).toMatchObject({ revision: 1, vacant: true });
    expect((await as("Alice", "POST", `${capPath}/revoke`, { coach: "Alice", team: "sv_a", revision: 1 })).status).toBe(409); // head is the match revision
    // now the match undo goes through and restores the dead captain (no vacancy at all)
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/undo-revision`)).status).toBe(200);
    const chain = (await repo.getChain("Alice", "sv_a"))!;
    expect(chain.head).toBe(0);
    expect(chain.revisions).toHaveLength(3); // revisions are never deleted
    expect((await capView()).vacant).toBe(false);
  });

  it("undoing a LATER match keeps the appointment; appointing while a match is open is refused", async () => {
    await captainKilled();
    // open match on the vacant team: no appointment (that match pinned the head when it was created)
    const r = await as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" }, postMatch: "full", pregame: "skip" });
    const id2 = (r.body as { match: { id: string } }).match.id;
    expect((await appoint("Alice", "blitz2", 1)).body).toMatchObject({ error: expect.stringMatching(/unfinished recorded match/) });
    await as("Alice", "POST", `/api/tabletop/matches/${id2}/events`, { events: [E("endOfMatch", "home")] });
    for (const c of ["Alice", "Bob"]) await as(c, "POST", `/api/tabletop/matches/${id2}/confirm`);
    // match 2 is confirmed (head 2, still vacant: the flag carries over); appoint on top of it
    expect((await capView()).revision).toBe(2);
    expect((await appoint("Alice", "blitz2", 2)).status).toBe(200);
    // a third match builds on the appointment revision; undoing it keeps the appointment
    const r3 = await as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" }, postMatch: "full", pregame: "skip" });
    const id3 = (r3.body as { match: { id: string } }).match.id;
    await as("Alice", "POST", `/api/tabletop/matches/${id3}/events`, { events: [E("endOfMatch", "home")] });
    for (const c of ["Alice", "Bob"]) await as(c, "POST", `/api/tabletop/matches/${id3}/confirm`);
    let chain = (await repo.getChain("Alice", "sv_a"))!;
    expect(headRevision(chain)).toMatchObject({ revision: 4, parent: 3, matchId: id3 });
    expect(headRevision(chain).teamFile.players.find((p) => p.id === "blitz2")!.skills).toContain("Team Captain");
    expect((await as("Org", "POST", `/api/tabletop/matches/${id3}/undo-revision`)).status).toBe(200);
    chain = (await repo.getChain("Alice", "sv_a"))!;
    expect(headRevision(chain)).toMatchObject({ revision: 3, appointment: { playerId: "blitz2" } });
    expect((await capView()).vacant).toBe(false);
    // match 2 (under the appointment) cannot be undone until the appointment is revoked
    expect((await as("Org", "POST", `/api/tabletop/matches/${id2}/undo-revision`)).status).toBe(409);
  });
});
