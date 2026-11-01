import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onboardingGateApplies } from "../src/auth/onboarding";
import type { NotificationInput } from "../src/notifications";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { leagueCsvFiles } from "../src/leagues/exportZip";
import { carryParticipantFlags } from "../src/leagues/participants";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueTeam, SeasonRecord } from "../src/leagues/types";

// League season Participants (src/leagues/participants.ts): organiser-only read, single + bulk flag writes with the
// season revision, one notification per coach, shared-contact privacy, and the public season read without the flags.

const team = (id: string, name: string, coach: string, over: Partial<LeagueTeam> = {}): LeagueTeam => ({
  id, name, race: "Orc", coach, teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false,
  tier: "1", raceLeague: "", players: [], formerPlayers: [], ...over,
});
const season = (): SeasonRecord => ({
  id: "season-6", leagueId: "tabbl", number: 6, name: "Season 6", sourceSlug: "s6", ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [],
  teams: [
    team("orcs", "Orcs", "Dee Display", { coachId: "Dee" }),
    team("elves", "Elves", "Bob", { coachId: "Bob", race: "Wood Elf" }),
    team("dwarfs", "Dwarfs", "Bob", { coachId: "Bob", race: "Dwarf" }),
    team("rats", "Rats", "Nobody Here", { race: "Skaven" }),
  ],
  participants: [
    { coach: "Dee Display", coachId: "Dee", country: "US", race: "Orc", team: "Orcs", active: false },
    { coach: "Bob", coachId: "Bob", country: "US", race: "Wood Elf", team: "Elves", active: true },
  ],
  honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "tourplay-export",
});

describe("league participants", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let sent: Array<{ coach: string; input: NotificationInput }>;
  let ifMatch: string | undefined;
  const deps = (): LeagueApiDeps => ({
    store, now: () => new Date("2026-11-01T12:00:00Z"), ifMatch,
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    notify: (coach, input) => { sent.push({ coach, input }); },
    // Bob shared his email with this league; Dee shared nothing but her preferred name. A Discord id must never pass.
    memberContact: (_viewer, coach) => (coach === "Bob"
      ? { coach: "Bob", email: "bob@example.com", discordUserId: "123456789", phones: [{ number: "+15555550100", label: "mobile" }] } as { coach: string }
      : coach === "Dee" ? { coach: "Dee", preferredName: "Dee D." } as { coach: string } : undefined),
  });
  const JAY = { coach: "Jay", admin: false };
  const ROOT = { coach: "Root", admin: true };
  const BOB = { coach: "Bob", admin: false };
  const base = "/api/leagues/tabbl/seasons/season-6/participants";
  const rev = () => store.season("tabbl", "season-6")!.revision ?? 0;
  const call = async (method: string, p: string, auth: { coach: string; admin: boolean } | undefined, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, p, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route for ${method} ${p}`);
    return r;
  };
  type Row = { teamId: string; flags: Record<string, boolean>; contact?: Record<string, unknown>; coachId?: string; updated?: { by: string } };
  const rows = (r: LeagueApiResult): Row[] => (r.body as { participants: Row[] }).participants;
  const row = (r: LeagueApiResult, id: string): Row => rows(r).find((x) => x.teamId === id)!;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-participants-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
    store.putSeason(season());
    sent = [];
    ifMatch = undefined;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("auth: anonymous 401, a member coach 403, organiser and admin 200, for the read and both writes; private, no-store", async () => {
    for (const [m, p, b] of [["GET", base, undefined], ["PATCH", `${base}/orcs`, { revision: rev(), paid: true }], ["POST", base, { revision: rev(), set: { paid: true } }]] as const) {
      expect((await call(m, p, undefined, b)).status, `${m} anon`).toBe(401);
      expect((await call(m, p, BOB, b)).status, `${m} member`).toBe(403);
    }
    expect(store.season("tabbl", "season-6")!.participants.some((p) => p.paid)).toBe(false);
    const read = await call("GET", base, JAY);
    expect(read.status).toBe(200);
    expect(read.headers?.["cache-control"]).toBe("private, no-store");
    expect((await call("GET", base, ROOT)).status).toBe(200);
    expect((await call("GET", "/api/leagues/tabbl/seasons/season-9/participants", JAY)).status).toBe(404);
    expect((await call("GET", "/api/leagues/nope/seasons/season-6/participants", JAY)).status).toBe(404);
    expect((await call("DELETE", base, JAY)).status).toBe(405);
    expect((await call("POST", `${base}/orcs`, JAY, {})).status).toBe(405);
  });

  it("writes are gated by CSRF and onboarding like every /api write (server.ts)", () => {
    expect(onboardingGateApplies("PATCH", `${base}/orcs`)).toBe(true);
    expect(onboardingGateApplies("POST", base)).toBe(true);
    expect(onboardingGateApplies("GET", base)).toBe(false);
  });

  it("rows: one per team (name order), five flags (the export's active is ignored: active until set here), coach account", async () => {
    const r = await call("GET", base, JAY);
    expect(rows(r).map((x) => x.teamId)).toEqual(["dwarfs", "elves", "orcs", "rats"]);
    // TourPlay marks every row inactive; that value means nothing here.
    expect(row(r, "orcs").flags).toEqual({ paid: false, rosterVerified: false, frozen: false, checkedIn: false, active: true });
    expect(row(r, "rats").flags.active).toBe(true);
    expect(row(r, "rats").coachId).toBeUndefined();
    expect((r.body as { revision: number }).revision).toBe(rev());
  });

  it("privacy: only the fields the coach shared with the league; never a Discord id; nothing without an account", async () => {
    const r = await call("GET", base, JAY);
    expect(row(r, "elves").contact).toEqual({ email: "bob@example.com", phones: [{ number: "+15555550100", label: "mobile" }] });
    expect(row(r, "orcs").contact).toEqual({ preferredName: "Dee D." });
    expect(row(r, "rats").contact).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain("123456789");
    // A league without the contact source shows none.
    const bare = await leagueApi("GET", base, new URLSearchParams(), JAY, { store });
    expect(JSON.stringify(bare!.body)).not.toContain("example.com");
  });

  it("revision: 428 missing, 409 stale, 400 bad; If-Match works; the answer carries the new revision", async () => {
    expect((await call("PATCH", `${base}/orcs`, JAY, { paid: true })).status).toBe(428);
    expect((await call("POST", base, JAY, { set: { paid: true } })).status).toBe(428);
    const stale = await call("PATCH", `${base}/orcs`, JAY, { revision: rev() + 3, paid: true });
    expect(stale.status).toBe(409);
    expect((stale.body as { revision: number }).revision).toBe(rev());
    expect((await call("POST", base, JAY, { revision: rev() + 3, set: { paid: true } })).status).toBe(409);
    expect((await call("PATCH", `${base}/orcs`, JAY, { revision: "x", paid: true })).status).toBe(400);
    expect(store.season("tabbl", "season-6")!.participants.some((p) => p.paid)).toBe(false);
    const before = rev();
    ifMatch = `"${before}"`;
    const ok = await call("PATCH", `${base}/orcs`, JAY, { paid: true });
    expect(ok.status).toBe(200);
    expect((ok.body as { revision: number }).revision).toBe(before + 1);
    expect(rev()).toBe(before + 1);
  });

  it("single toggle: validates the flags, stores them on the participant row (creating one), records who", async () => {
    expect((await call("PATCH", `${base}/orcs`, JAY, { revision: rev() })).status).toBe(400);
    expect((await call("PATCH", `${base}/orcs`, JAY, { revision: rev(), paid: "yes" })).body).toMatchObject({ field: "paid" });
    expect((await call("PATCH", `${base}/nope`, JAY, { revision: rev(), paid: true })).status).toBe(404);
    const r = await call("PATCH", `${base}/orcs`, JAY, { revision: rev(), paid: true, rosterVerified: true, active: true });
    expect(r.status).toBe(200);
    expect(row(r, "orcs").flags).toEqual({ paid: true, rosterVerified: true, frozen: false, checkedIn: false, active: true });
    expect(row(r, "orcs").updated).toEqual({ by: "Jay", at: "2026-11-01T12:00:00.000Z" });
    const stored = store.season("tabbl", "season-6")!;
    expect(stored.participants[0]).toMatchObject({ team: "Orcs", paid: true, rosterVerified: true, active: true, flagsUpdated: { by: "Jay" } });
    // Turning a flag off removes it; a team with no row gets one.
    const off = await call("PATCH", `${base}/orcs`, JAY, { revision: rev(), paid: false });
    expect(store.season("tabbl", "season-6")!.participants[0]!.paid).toBeUndefined();
    expect(row(off, "orcs").flags.paid).toBe(false);
    await call("PATCH", `${base}/rats`, JAY, { revision: rev(), frozen: true });
    expect(store.season("tabbl", "season-6")!.participants.find((p) => p.team === "Rats")).toMatchObject({ coach: "Nobody Here", frozen: true, active: true });
    // No change: no write, revision unchanged.
    const same = rev();
    const noop = await call("PATCH", `${base}/rats`, JAY, { revision: same, frozen: true });
    expect((noop.body as { changed: number }).changed).toBe(0);
    expect(rev()).toBe(same);
  });

  it("bulk: every team by default, or the listed ones; bad lists refused", async () => {
    expect((await call("POST", base, JAY, { revision: rev(), set: {} })).status).toBe(400);
    expect((await call("POST", base, JAY, { revision: rev(), teamIds: ["orcs", "ghost"], set: { paid: true } })).status).toBe(400);
    expect((await call("POST", base, JAY, { revision: rev(), teamIds: "orcs", set: { paid: true } })).status).toBe(400);
    expect((await call("POST", base, JAY, { revision: rev(), teamIds: [], set: { paid: true } })).status).toBe(400);
    const all = await call("POST", base, JAY, { revision: rev(), set: { paid: true } });
    expect(all.status).toBe(200);
    expect((all.body as { changed: number }).changed).toBe(4);
    expect(rows(all).every((x) => x.flags.paid)).toBe(true);
    const some = await call("POST", base, ROOT, { revision: rev(), teamIds: ["orcs", "elves"], set: { rosterVerified: true, checkedIn: true } });
    expect(rows(some).filter((x) => x.flags.rosterVerified).map((x) => x.teamId).sort()).toEqual(["elves", "orcs"]);
    const cleared = await call("POST", base, JAY, { revision: rev(), set: { paid: false } });
    expect(rows(cleared).some((x) => x.flags.paid)).toBe(false);
  });

  it("notifications: what changed, once per coach per request (two teams = one), the actor excluded, none without an account", async () => {
    await call("POST", base, JAY, { revision: rev(), set: { paid: true } });
    expect(sent.map((s) => s.coach).sort()).toEqual(["Bob", "Dee"]);
    const bob = sent.find((s) => s.coach === "Bob")!.input;
    expect(bob).toMatchObject({ type: "entrant-flag", title: "TABBL, Season 6: your entry was updated", link: "/app/leagues/tabbl?season=season-6", from: "Jay" });
    expect(bob.body).toBe("Elves: Marked as paid. Dwarfs: Marked as paid.");
    sent = [];
    await call("PATCH", `${base}/orcs`, JAY, { revision: rev(), rosterVerified: false, active: false });
    expect(sent).toEqual([{ coach: "Dee", input: expect.objectContaining({ body: "Orcs: Moved to standby." }) }]); // verified was already off
    sent = [];
    await call("PATCH", `${base}/elves`, { coach: "Bob", admin: true }, { revision: rev(), frozen: true });
    expect(sent).toEqual([]); // an admin changing their own team is not told
    await call("PATCH", `${base}/rats`, JAY, { revision: rev(), checkedIn: true });
    expect(sent).toEqual([]);
  });

  it("public season read drops the organiser flags; organisers still see them", async () => {
    await call("POST", base, JAY, { revision: rev(), set: { paid: true, rosterVerified: true } });
    const pub = await call("GET", "/api/leagues/tabbl/seasons/season-6", undefined);
    const member = await call("GET", "/api/leagues/tabbl/seasons/season-6", BOB);
    for (const r of [pub, member]) {
      const parts = (r.body as { season: SeasonRecord }).season.participants;
      expect(parts.length).toBe(4);
      expect(JSON.stringify(parts)).not.toMatch(/paid|rosterVerified|flagsUpdated/);
      expect(parts.every((x) => x.active === true)).toBe(true); // the export's active:false is not the site's
      expect(JSON.stringify(parts)).not.toMatch(/teamId|addedHere|activeSet/);
    }
    const org = await call("GET", "/api/leagues/tabbl/seasons/season-6", JAY);
    expect((org.body as { season: SeasonRecord }).season.participants[0]).toMatchObject({ paid: true, rosterVerified: true });
  });

  it("organiser export CSV carries the flags; a re-import keeps them", async () => {
    await call("PATCH", `${base}/orcs`, JAY, { revision: rev(), paid: true, checkedIn: true });
    const s = store.season("tabbl", "season-6")!;
    const csv = String(Object.entries(leagueCsvFiles(store.league("tabbl")!, [s])).find(([k]) => k.endsWith("participants.csv"))![1]);
    expect(csv.split(/\r?\n/)[0]).toContain("paid,roster_verified,frozen,checked_in");
    expect(csv).toContain("Orcs,,yes,yes,no,no,yes"); // the export's active:false is not the site's
    const next = season();
    expect(carryParticipantFlags(s, next)).toBe(1);
    expect(next.participants[0]).toMatchObject({ paid: true, checkedIn: true, teamId: "orcs", flagsUpdated: { by: "Jay" } });
    expect(next.participants[0]!.activeSet).toBeUndefined();
  });

  it("standby set here sticks, reads back, exports and survives a re-import", async () => {
    const r = await call("PATCH", `${base}/orcs`, JAY, { revision: rev(), active: false });
    expect(row(r, "orcs").flags.active).toBe(false);
    const s = store.season("tabbl", "season-6")!;
    expect(s.participants[0]).toMatchObject({ active: false, activeSet: true });
    const csv = String(Object.entries(leagueCsvFiles(store.league("tabbl")!, [s])).find(([k]) => k.endsWith("participants.csv"))![1]);
    expect(csv).toContain("Orcs,,no,");
    expect(csv).toContain("Elves,,yes,");
    const pub = await call("GET", "/api/leagues/tabbl/seasons/season-6", undefined);
    expect((pub.body as { season: SeasonRecord }).season.participants.find((p) => p.team === "Orcs")!.active).toBe(false);
    const next = season();
    carryParticipantFlags(s, next);
    expect(next.participants[0]).toMatchObject({ active: false, activeSet: true });
  });

  it("never another coach's row: same team name, different coach or account, gets its own row; the other coach is untouched", async () => {
    const s = store.season("tabbl", "season-6")!;
    // Bob's team is also called Orcs (no account mapped); Carol's team "Elves" is named like Bob's row but has its own account.
    s.teams.push(team("orcs-bob", "Orcs", "Bob"), team("elves-carol", "Elves", "Bob", { coachId: "Carol" }));
    store.putSeason(s);
    const r = await call("PATCH", `${base}/orcs-bob`, JAY, { revision: rev(), paid: true });
    expect(row(r, "orcs-bob").flags.paid).toBe(true);
    expect(row(r, "orcs").flags.paid).toBe(false);
    await call("PATCH", `${base}/elves-carol`, JAY, { revision: rev(), checkedIn: true });
    const after = store.season("tabbl", "season-6")!;
    expect(after.participants.find((p) => p.coach === "Dee Display")).not.toHaveProperty("paid");
    // Bob's existing Elves row also matches Carol's team by name and coach, but its account (Bob) contradicts Carol's.
    expect(after.participants.find((p) => p.coachId === "Bob")).not.toHaveProperty("checkedIn");
    expect(after.participants.filter((p) => p.addedHere).map((p) => p.teamId).sort()).toEqual(["elves-carol", "orcs-bob"]);
    expect(sent.map((x) => x.coach)).toEqual(["Carol"]); // Dee and Bob never hear about it
    // Two teams with the same name AND coach: neither claims the unpinned row.
    const twins = { ...season(), teams: [team("a", "Orcs", "Dee Display"), team("b", "Orcs", "Dee Display")] };
    const { participantOf } = await import("../src/leagues/participants");
    expect(participantOf(twins, twins.teams[0]!)).toBeUndefined();
  });

  it("re-import: a coach change drops the flags; rows created here for teams the export lacks are kept while the team exists", async () => {
    await call("POST", base, JAY, { revision: rev(), set: { paid: true } });
    const prior = store.season("tabbl", "season-6")!;
    expect(prior.participants.find((p) => p.team === "Rats")).toMatchObject({ addedHere: true, teamId: "rats", paid: true });
    // Orcs now belongs to another account; Elves keeps Bob; Rats is still on the roster but not in the export.
    const next = season();
    next.teams[0] = { ...next.teams[0]!, coachId: "Someone" };
    next.participants[0] = { ...next.participants[0]!, coachId: "Someone" };
    carryParticipantFlags(prior, next);
    expect(next.participants.find((p) => p.team === "Orcs")).not.toHaveProperty("paid");
    expect(next.participants.find((p) => p.team === "Elves")).toMatchObject({ paid: true });
    expect(next.participants.find((p) => p.team === "Rats")).toMatchObject({ addedHere: true, teamId: "rats", paid: true });
    expect(next.participants.find((p) => p.team === "Dwarfs")).toMatchObject({ addedHere: true, paid: true });
    // A team gone from the season takes its created row with it; a created row whose team changed coach keeps no flags.
    const gone = season();
    gone.teams = gone.teams.filter((t) => t.id !== "rats");
    gone.teams[2] = { ...gone.teams[2]!, coachId: "NewCoach" }; // dwarfs
    carryParticipantFlags(prior, gone);
    expect(gone.participants.some((p) => p.team === "Rats")).toBe(false);
    const dwarfs = gone.participants.find((p) => p.team === "Dwarfs")!;
    expect(dwarfs).toMatchObject({ coachId: "NewCoach", active: true });
    expect(dwarfs).not.toHaveProperty("paid");
  });
});
