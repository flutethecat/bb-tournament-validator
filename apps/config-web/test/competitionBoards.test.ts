import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { requireSession } from "../src/auth/requireSession.js";
import { isStateChangingApiRequest } from "../src/auth/csrf.js";
import { onboardingGateApplies } from "../src/auth/onboarding.js";
import { BoardStore } from "../src/boards/board.js";
import {
  competitionBoardApi, competitionBoardPath, createCompetitionBoardLimiters, isPublicCompetitionBoardRead,
  type BoardAuth, type CompetitionBoardDeps,
} from "../src/boards/competitionApi.js";
import type { LeagueRecord, SeasonRecord } from "../src/leagues/types.js";
import type { NotificationInput } from "../src/notifications.js";
import { starProfanity } from "../src/discord/profanity.js";
import type { TournamentEntrantRecord, TournamentRecord } from "../src/tournaments/types.js";

// League and tournament boards (owner 11-04): readers (league coaches with a team in any season or ladder, registered
// tournament coaches, organisers, admins; public read off by default), posting, moderation (delete / hide / pin / lock /
// mute, every action logged), reports (deduplicated, organisers told through the draft-aware notifier), the on/off
// switch, rate limits, and that GETs never write. Fake names only; each test has its own state dir; no transport.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const ACCOUNTS: Record<string, string> = { olga: "Olga", oscar: "Oscar", mia: "Mia", lad: "Lad", past: "Past", nora: "Nora", ted: "Ted", tess: "Tess", gone: "Gone", fenced: "Fenced", siteadmin: "SiteAdmin" };

function season(id: string, teams: Array<{ id: string; coach: string; coachId?: string }>, competition?: "ladder"): SeasonRecord {
  return {
    id, number: 1, name: id, status: "completed", fixtures: [], participants: [], phases: [], awards: [],
    teams: teams.map((t) => ({ ...t, name: t.id, race: "Orc", teamValue: null, treasury: null, rerolls: null })),
    ...(competition ? { competition } : {}),
  } as unknown as SeasonRecord;
}

function harness(opts: { draft?: boolean; unpublished?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bbtv-cboards-"));
  roots.push(root);
  let clock = new Date("2026-11-04T12:00:00.000Z");
  const boards = new BoardStore(root, { now: () => clock });
  const league = { id: "lg1", name: "Grudge League", organisers: ["Olga"], owner: "Oscar", ...(opts.draft ? { visibility: "draft" } : {}) } as unknown as LeagueRecord;
  let version = 1;
  const comps = [
    season("s1", [{ id: "orcs", coach: "Mia", coachId: "Mia" }]),
    season("s0", [{ id: "old", coach: "Past", coachId: "Past" }]),
    season("lad1", [{ id: "lad", coach: "Lad", coachId: "Lad" }], "ladder"),
  ];
  const tournament = {
    id: "t1", name: "Spring Cup", status: "active", ownerCoachId: "Nora", organizerCoachIds: [], ...(opts.unpublished ? { unpublished: true } : {}),
  } as unknown as TournamentRecord;
  const entrant = (id: string, coach: string, extra: Partial<TournamentEntrantRecord> = {}) =>
    ({ id, tournamentId: "t1", seed: 1, coach: { coachId: coach, ffbCoachId: coach, verifiedAt: "" }, teamId: "", registeredAt: "", ...extra }) as TournamentEntrantRecord;
  const entrants = [entrant("e1", "Ted"), entrant("e2", "Gone", { droppedAt: "2026-11-01T00:00:00.000Z", entryState: "withdrawn" })];
  const sent: Array<{ coach: string; input: NotificationInput }> = [];
  const deps: CompetitionBoardDeps = {
    boards,
    leagues: { league: (id) => (id === "lg1" ? structuredClone(league) : undefined), competitions: (id) => (id === "lg1" ? comps : []), version: () => version },
    tournaments: { tournament: (id) => (id === "t1" ? structuredClone(tournament) : undefined), entrants: (id) => (id === "t1" ? entrants : []) },
    coach: (n) => ACCOUNTS[n.trim().toLowerCase()],
    isFenced: (c) => c.toLowerCase() === "fenced",
    isAdmin: (c) => c.toLowerCase() === "siteadmin",
    notify: (coach, input) => { sent.push({ coach, input }); },
    limiters: createCompetitionBoardLimiters(),
    now: () => clock,
  };
  const as = (coach: string, extra: Partial<BoardAuth> = {}): BoardAuth => ({ coach, ...(coach === "SiteAdmin" ? { admin: true } : {}), ...extra });
  const call = async (method: string, path: string, auth?: BoardAuth, body?: unknown) => (await competitionBoardApi(method, path, auth, body, deps))!;
  const L = "/api/leagues/lg1/board";
  const T = "/api/tournaments/t1/board";
  const thread = async (base: string, who: string, title = "Hello", text = "First post") => {
    const r = await call("POST", base, as(who), { title, text });
    expect(r.status).toBe(201);
    return (r.body as { thread: { id: string } }).thread.id;
  };
  const settingsRev = async (base: string, who = "Olga") => ((await call("GET", base, as(who))).body as { settings: { revision: number } }).settings.revision;
  return {
    root, boards, deps, sent, as, call, L, T, thread, settingsRev, comps, entrants,
    tick: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    bump: () => { version += 1; },
  };
}

type View = {
  threads: Array<{ id: string; title: string; text: string; author: string; pinned?: true; locked?: true; hidden?: true; removed?: { by: string }; canReport?: boolean; canEdit: boolean; replies: Array<{ id: string; text: string; hidden?: true; removed?: { by: string } }> }>;
  canPost: boolean; canModerate: boolean; canReport: boolean; settings: { enabled: boolean; publicRead: boolean; revision?: number }; mutedUntil?: string; openReports?: number;
};
const viewOf = (r: { body?: unknown }): View => ((r.body as { board?: View }).board ?? r.body) as View;

describe("paths", () => {
  it("parses league and tournament board paths; only the board and its status are public reads", () => {
    expect(competitionBoardPath("/api/leagues/lg1/board")).toEqual({ kind: "league", id: "lg1", rest: [] });
    expect(competitionBoardPath("/api/tournaments/t1/board/p3/replies")).toEqual({ kind: "tournament", id: "t1", rest: ["p3", "replies"] });
    expect(competitionBoardPath("/api/clubs/c1/board")).toBeUndefined();
    expect(isPublicCompetitionBoardRead("GET", "/api/tournaments/t1/board")).toBe(true);
    expect(isPublicCompetitionBoardRead("GET", "/api/tournaments/t1/board/status")).toBe(true);
    expect(isPublicCompetitionBoardRead("GET", "/api/tournaments/t1/board/log")).toBe(false);
    expect(isPublicCompetitionBoardRead("POST", "/api/tournaments/t1/board")).toBe(false);
  });

  it("gates: the board and its status are public reads on requireSession; every write is CSRF and onboarding covered", () => {
    const req = (method: string) => ({ method, headers: {} }) as IncomingMessage;
    for (const p of ["/api/tournaments/t1/board", "/api/tournaments/t1/board/status", "/api/leagues/lg1/board", "/api/leagues/lg1/board/status"]) {
      expect(requireSession(req("GET"), p, "").kind, p).toBe("allow");
    }
    expect(requireSession(req("GET"), "/api/tournaments/t1/board/log", "").kind).toBe("unauthorized");
    expect(requireSession(req("POST"), "/api/tournaments/t1/board", "").kind).toBe("unauthorized");
    for (const [m, p] of [["POST", "/api/leagues/lg1/board"], ["PATCH", "/api/tournaments/t1/board/settings"], ["DELETE", "/api/leagues/lg1/board/p1"], ["POST", "/api/leagues/lg1/board/p1/report"]] as const) {
      expect(isStateChangingApiRequest(m, p), p).toBe(true);
      expect(onboardingGateApplies(m, p), p).toBe(true);
    }
  });
});

describe("who reads and posts", () => {
  it("league: coaches with a team in any season or ladder and the organisers read and post; others are refused", async () => {
    const h = harness();
    for (const who of ["Mia", "Past", "Lad", "Olga", "Oscar", "SiteAdmin"]) {
      expect((await h.call("GET", h.L, h.as(who))).status, who).toBe(200);
      expect((await h.call("POST", h.L, h.as(who), { title: `From ${who}`, text: "hi" })).status, who).toBe(201);
    }
    // non-member refused (read and post); anonymous needs a session
    const stranger = await h.call("GET", h.L, h.as("Tess"));
    expect(stranger.status).toBe(403);
    expect(stranger.body).toMatchObject({ code: "members-only" });
    expect((await h.call("POST", h.L, h.as("Tess"), { title: "x", text: "y" })).status).toBe(403);
    expect((await h.call("GET", h.L)).status).toBe(401);
    expect((await h.call("POST", h.L, undefined, { title: "x", text: "y" })).status).toBe(401);
    // the status route says what the tab shows
    expect((await h.call("GET", `${h.L}/status`)).body).toEqual({ enabled: true, publicRead: false, canRead: false, canModerate: false });
    expect((await h.call("GET", `${h.L}/status`, h.as("Mia"))).body).toMatchObject({ canRead: true, canModerate: false });
    expect((await h.call("GET", `${h.L}/status`, h.as("Olga"))).body).toMatchObject({ canRead: true, canModerate: true });
  });

  it("tournament: registered coaches and organisers; a withdrawn coach is refused", async () => {
    const h = harness();
    expect((await h.call("POST", h.T, h.as("Ted"), { title: "Ready", text: "See you there" })).status).toBe(201);
    expect((await h.call("POST", h.T, h.as("Nora"), { title: "Venue", text: "Doors at 9" })).status).toBe(201);
    expect((await h.call("GET", h.T, h.as("Gone"))).status).toBe(403);
    expect((await h.call("POST", h.T, h.as("Gone"), { title: "x", text: "y" })).status).toBe(403);
    expect((await h.call("POST", h.T, h.as("Mia"), { title: "x", text: "y" })).status).toBe(403);
  });

  it("test sessions, unknown and fenced accounts never write; drafts are 404 to everyone but their managers", async () => {
    const h = harness();
    expect((await h.call("POST", h.L, h.as("Mia", { test: true }), { title: "x", text: "y" })).status).toBe(403);
    expect((await h.call("POST", h.L, h.as("Fenced"), { title: "x", text: "y" })).status).toBe(410);
    expect((await h.call("POST", h.L, h.as("Nobody"), { title: "x", text: "y" })).status).toBe(403);
    const d = harness({ draft: true, unpublished: true });
    expect((await d.call("GET", d.L, d.as("Mia"))).status).toBe(404);
    expect((await d.call("GET", `${d.L}/status`)).status).toBe(404);
    expect((await d.call("GET", d.L, d.as("Olga"))).status).toBe(200);
    expect((await d.call("GET", d.T, d.as("Ted"))).status).toBe(404);
    expect((await d.call("GET", d.T, d.as("Nora"))).status).toBe(200);
  });

  it("public read is off by default; the organisers turn it on (revisioned: 428 missing, 409 stale) and anyone reads, never writes", async () => {
    const h = harness();
    await h.thread(h.L, "Mia");
    expect((await h.call("PATCH", `${h.L}/settings`, h.as("Olga"), { publicRead: true })).status).toBe(428);
    expect((await h.call("PATCH", `${h.L}/settings`, h.as("Mia"), { revision: 0, publicRead: true })).status).toBe(403);
    const rev = await h.settingsRev(h.L);
    expect((await h.call("PATCH", `${h.L}/settings`, h.as("Olga"), { revision: rev, publicRead: true })).status).toBe(200);
    expect((await h.call("PATCH", `${h.L}/settings`, h.as("Olga"), { revision: rev, publicRead: false })).status).toBe(409);
    const anon = await h.call("GET", h.L);
    expect(anon.status).toBe(200);
    expect(viewOf(anon)).toMatchObject({ canPost: false, canModerate: false, canReport: false, settings: { enabled: true, publicRead: true } });
    expect(viewOf(anon).settings.revision).toBeUndefined();
    expect((await h.call("GET", h.L, h.as("Tess"))).status).toBe(200);
    expect((await h.call("POST", h.L, h.as("Tess"), { title: "x", text: "y" })).status).toBe(403);
  });
});

describe("the on / off switch", () => {
  it("on by default; off hides the board from coaches, refuses posts and reports, keeps the posts; organisers still see it", async () => {
    const h = harness();
    const t = await h.thread(h.L, "Mia", "Kept", "Still here");
    const rev = await h.settingsRev(h.L);
    expect((await h.call("PATCH", `${h.L}/settings`, h.as("Olga"), { revision: rev, enabled: false })).status).toBe(200);
    expect((await h.call("GET", `${h.L}/status`, h.as("Mia"))).body).toMatchObject({ enabled: false, canRead: false });
    const off = await h.call("GET", h.L, h.as("Mia"));
    expect(off.status).toBe(403);
    expect(off.body).toMatchObject({ code: "board-off" });
    expect((await h.call("POST", h.L, h.as("Mia"), { title: "x", text: "y" })).body).toMatchObject({ code: "board-off" });
    expect((await h.call("POST", `${h.L}/${t}/replies`, h.as("Mia"), { text: "y" })).body).toMatchObject({ code: "board-off" });
    expect((await h.call("POST", `${h.L}/${t}/report`, h.as("Lad"), { reason: "spam" })).body).toMatchObject({ code: "board-off" });
    // organisers: the board still reads (to switch it back on); its posts are kept
    const org = await h.call("GET", h.L, h.as("Olga"));
    expect(viewOf(org).threads.map((x) => x.text)).toEqual(["Still here"]);
    expect(viewOf(org).canPost).toBe(false);
    expect((await h.call("PATCH", `${h.L}/settings`, h.as("Olga"), { revision: rev + 1, enabled: true })).status).toBe(200);
    expect((await h.call("POST", `${h.L}/${t}/replies`, h.as("Mia"), { text: "back" })).status).toBe(201);
  });
});

describe("moderation", () => {
  it("delete is soft (\"removed by an organiser\"), hide / unhide masks the text from coaches, pin lists first, lock refuses replies", async () => {
    const h = harness();
    const a = await h.thread(h.L, "Mia", "Older", "older text");
    h.tick(1000);
    const b = await h.thread(h.L, "Lad", "Newer", "newer text");
    const reply = (await h.call("POST", `${h.L}/${b}/replies`, h.as("Mia"), { text: "a reply" })).body as { reply: { id: string } };
    // coaches can't moderate
    expect((await h.call("POST", `${h.L}/${a}/pin`, h.as("Mia"), { pinned: true })).status).toBe(403);
    // pin: the older thread now lists first
    expect((await h.call("POST", `${h.L}/${a}/pin`, h.as("Olga"), { pinned: true, reason: "Rules" })).status).toBe(200);
    expect(viewOf(await h.call("GET", h.L, h.as("Mia"))).threads.map((t) => [t.id, t.pinned])).toEqual([[a, true], [b, undefined]]);
    // only a thread pins or locks
    expect((await h.call("POST", `${h.L}/${reply.reply.id}/lock`, h.as("Olga"), { locked: true })).status).toBe(400);
    // hide a reply: coaches get the placeholder without the text; organisers see it
    expect((await h.call("POST", `${h.L}/${reply.reply.id}/hide`, h.as("Olga"), { hidden: true, reason: "Rude" })).status).toBe(200);
    const coachView = viewOf(await h.call("GET", h.L, h.as("Lad")));
    expect(coachView.threads[1]!.replies[0]).toMatchObject({ hidden: true, text: "" });
    expect(viewOf(await h.call("GET", h.L, h.as("Olga"))).threads[1]!.replies[0]).toMatchObject({ hidden: true, text: "a reply" });
    expect((await h.call("PATCH", `${h.L}/${reply.reply.id}`, h.as("Mia"), { text: "edited" })).status).toBe(409);
    expect((await h.call("POST", `${h.L}/${reply.reply.id}/hide`, h.as("Olga"), { hidden: false })).status).toBe(200);
    expect(viewOf(await h.call("GET", h.L, h.as("Lad"))).threads[1]!.replies[0]!.text).toBe("a reply");
    // a hidden thread: coaches see its placeholder without the title, text or replies
    expect((await h.call("POST", `${h.L}/${b}/hide`, h.as("Olga"), { hidden: true })).status).toBe(200);
    expect(viewOf(await h.call("GET", h.L, h.as("Mia"))).threads[1]).toMatchObject({ hidden: true, title: "", text: "", replies: [] });
    expect((await h.call("POST", `${h.L}/${b}/replies`, h.as("Mia"), { text: "x" })).body).toMatchObject({ code: "hidden" });
    expect((await h.call("POST", `${h.L}/${b}/hide`, h.as("Olga"), { hidden: false })).status).toBe(200);
    // lock: coaches can't reply (locked thread refused), organisers still can
    expect((await h.call("POST", `${h.L}/${b}/lock`, h.as("Olga"), { locked: true })).status).toBe(200);
    const locked = await h.call("POST", `${h.L}/${b}/replies`, h.as("Mia"), { text: "nope" });
    expect(locked.status).toBe(409);
    expect(locked.body).toMatchObject({ code: "locked" });
    expect((await h.call("POST", `${h.L}/${b}/replies`, h.as("Olga"), { text: "Closed." })).status).toBe(201);
    expect((await h.call("POST", `${h.L}/${b}/lock`, h.as("Olga"), { locked: false })).status).toBe(200);
    expect((await h.call("POST", `${h.L}/${b}/replies`, h.as("Mia"), { text: "open again" })).status).toBe(201);
    // delete: soft, by a moderator
    const del = await h.call("DELETE", `${h.L}/${a}`, h.as("Olga"), { reason: "Off topic" });
    expect(viewOf(del).threads.find((t) => t.id === a)).toMatchObject({ title: "", text: "", removed: { by: "moderator" } });
    expect((await h.call("DELETE", `${h.L}/${b}`, h.as("Mia"))).status).toBe(403);
    // every action is in the log, organisers only
    expect((await h.call("GET", `${h.L}/log`, h.as("Mia"))).status).toBe(403);
    const log = (await h.call("GET", `${h.L}/log`, h.as("Olga"))).body as { log: Array<{ action: string; by: string; reason?: string; coach?: string; at: string }> };
    expect(log.log.map((e) => e.action)).toEqual(["delete", "unlock", "lock", "unhide", "hide", "unhide", "hide", "pin"]);
    expect(log.log[0]).toMatchObject({ by: "Olga", coach: "Mia", reason: "Off topic", at: expect.any(String) });
    expect(log.log.at(-1)).toMatchObject({ action: "pin", reason: "Rules" });
  });

  it("mute 1h / 24h / 7d / custom refuses the coach's posts until it ends; organisers can't be muted; lifted early", async () => {
    const h = harness();
    const t = await h.thread(h.L, "Olga", "Rules", "Be nice");
    expect((await h.call("POST", `${h.L}/mutes`, h.as("Mia"), { coach: "Lad", duration: "1h" })).status).toBe(403);
    expect((await h.call("POST", `${h.L}/mutes`, h.as("Olga"), { coach: "Oscar", duration: "1h" })).body).toMatchObject({ code: "moderator" });
    expect((await h.call("POST", `${h.L}/mutes`, h.as("Olga"), { coach: "Lad", duration: "2h" })).status).toBe(400);
    expect((await h.call("POST", `${h.L}/mutes`, h.as("Olga"), { coach: "Lad", duration: "custom", until: "2026-11-01T00:00:00Z" })).status).toBe(400);
    expect((await h.call("POST", `${h.L}/mutes`, h.as("Olga"), { coach: "Lad", duration: "1h", reason: "Cool off" })).status).toBe(201);
    const muted = await h.call("POST", `${h.L}/${t}/replies`, h.as("Lad"), { text: "but" });
    expect(muted.status).toBe(403);
    expect(muted.body).toMatchObject({ code: "muted" });
    expect((await h.call("POST", h.L, h.as("Lad"), { title: "x", text: "y" })).body).toMatchObject({ code: "muted" });
    expect(viewOf(await h.call("GET", h.L, h.as("Lad"))).mutedUntil).toBe("2026-11-04T13:00:00.000Z");
    expect(((await h.call("GET", `${h.L}/mutes`, h.as("Olga"))).body as { mutes: unknown[] }).mutes).toHaveLength(1);
    h.tick(60 * 60_000 + 1);
    expect((await h.call("POST", `${h.L}/${t}/replies`, h.as("Lad"), { text: "ok now" })).status).toBe(201);
    for (const [duration, ms] of [["24h", 24 * 3600_000], ["7d", 7 * 24 * 3600_000]] as const) {
      expect((await h.call("POST", `${h.L}/mutes`, h.as("Olga"), { coach: "Lad", duration })).status).toBe(201);
      h.tick(ms - 1000);
      expect((await h.call("POST", `${h.L}/${t}/replies`, h.as("Lad"), { text: "x" })).status).toBe(403);
      h.tick(2000);
      expect((await h.call("POST", `${h.L}/${t}/replies`, h.as("Lad"), { text: "x" })).status).toBe(201);
    }
    expect((await h.call("POST", `${h.L}/mutes`, h.as("Olga"), { coach: "lad", duration: "custom", until: "2027-01-01T00:00:00Z" })).status).toBe(201);
    expect((await h.call("POST", `${h.L}/${t}/replies`, h.as("Lad"), { text: "x" })).status).toBe(403);
    expect((await h.call("DELETE", `${h.L}/mutes/lad`, h.as("Olga"), { reason: "Apologised" })).status).toBe(200);
    expect((await h.call("DELETE", `${h.L}/mutes/lad`, h.as("Olga"))).status).toBe(404);
    expect((await h.call("POST", `${h.L}/${t}/replies`, h.as("Lad"), { text: "thanks" })).status).toBe(201);
    const log = ((await h.call("GET", `${h.L}/log`, h.as("Olga"))).body as { log: Array<{ action: string; coach?: string; reason?: string }> }).log;
    expect(log.map((e) => e.action)).toEqual(["unmute", "mute", "mute", "mute", "mute"]);
    expect(log[0]).toMatchObject({ coach: "Lad", reason: "Apologised" });
  });

  it("site admins moderate any board", async () => {
    const h = harness();
    const t = await h.thread(h.T, "Ted");
    expect((await h.call("POST", `${h.T}/${t}/hide`, h.as("SiteAdmin"), { hidden: true })).status).toBe(200);
    expect((await h.call("GET", `${h.T}/log`, h.as("SiteAdmin"))).status).toBe(200);
  });
});

describe("reports", () => {
  it("a coach reports a post with a reason; organisers get an inbox note and a Reports queue; duplicates are not queued again", async () => {
    const h = harness();
    const t = await h.thread(h.L, "Mia", "Trash talk", "secret words");
    expect((await h.call("POST", `${h.L}/${t}/report`, h.as("Lad"), {})).status).toBe(400);
    expect((await h.call("POST", `${h.L}/${t}/report`, h.as("Mia"), { reason: "me" })).status).toBe(400);
    expect((await h.call("POST", `${h.L}/${t}/report`, h.as("Tess"), { reason: "x" })).status).toBe(403);
    const first = await h.call("POST", `${h.L}/${t}/report`, h.as("Lad"), { reason: "Abusive" });
    expect(first.status).toBe(201);
    expect(h.sent.map((s) => [s.coach, s.input.type, s.input.link])).toEqual([
      ["Oscar", "board-report", "/app/leagues/lg1?tab=board&reports=1"],
      ["Olga", "board-report", "/app/leagues/lg1?tab=board&reports=1"],
    ]);
    expect(JSON.stringify(h.sent)).not.toContain("secret words");
    expect(JSON.stringify(h.sent)).not.toContain("Abusive");
    const again = await h.call("POST", `${h.L}/${t}/report`, h.as("Lad"), { reason: "Still abusive" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true });
    expect(h.sent).toHaveLength(2);
    await h.call("POST", `${h.L}/${t}/report`, h.as("Past"), { reason: "Agree" });
    expect((await h.call("GET", `${h.L}/reports`, h.as("Mia"))).status).toBe(403);
    const q = (await h.call("GET", `${h.L}/reports`, h.as("Olga"))).body as { reports: Array<{ id: string; reporter: string; reason: string; resolved?: unknown; post: { text: string } }> };
    expect(q.reports.map((r) => [r.reporter, r.reason])).toEqual([["Past", "Agree"], ["Lad", "Abusive"]]);
    expect(q.reports[0]!.post.text).toBe("secret words");
    expect(viewOf(await h.call("GET", h.L, h.as("Olga"))).openReports).toBe(2);
    // resolve one (logged); deleting the post closes the rest as actioned
    expect((await h.call("POST", `${h.L}/reports/${q.reports[0]!.id}/resolve`, h.as("Olga"), { outcome: "dismissed" })).status).toBe(200);
    expect((await h.call("POST", `${h.L}/reports/${q.reports[0]!.id}/resolve`, h.as("Olga"), { outcome: "dismissed" })).status).toBe(409);
    await h.call("DELETE", `${h.L}/${t}`, h.as("Olga"), { reason: "Abuse" });
    expect(viewOf(await h.call("GET", h.L, h.as("Olga"))).openReports).toBe(0);
    // a resolved report frees the coach to report again (a new post here)
    const t2 = await h.thread(h.L, "Mia", "Again", "more");
    expect((await h.call("POST", `${h.L}/${t2}/report`, h.as("Lad"), { reason: "Again" })).status).toBe(201);
    const log = ((await h.call("GET", `${h.L}/log`, h.as("Olga"))).body as { log: Array<{ action: string }> }).log;
    expect(log.map((e) => e.action)).toEqual(["delete", "report-dismissed"]);
  });

  it("organisers moderate instead of reporting", async () => {
    const h = harness();
    const t = await h.thread(h.L, "Mia");
    expect((await h.call("POST", `${h.L}/${t}/report`, h.as("Olga"), { reason: "x" })).body).toMatchObject({ code: "moderators-moderate" });
    expect(h.sent).toEqual([]);
  });
});

describe("profanity and storage", () => {
  it("posts are stored as written; the viewer's filter stars them on display", async () => {
    const h = harness();
    await h.thread(h.L, "Mia", "Rant", "this is shit");
    const v = viewOf(await h.call("GET", h.L, h.as("Lad")));
    expect(v.threads[0]!.text).toBe("this is shit");
    expect(starProfanity(v.threads[0]!.text)).toBe("this is ***");
  });

  it("GETs never write: board, status, reports, mutes and log reads leave the state dir untouched", async () => {
    const h = harness();
    const t = await h.thread(h.L, "Mia");
    await h.call("POST", `${h.L}/${t}/report`, h.as("Lad"), { reason: "x" });
    await h.call("POST", `${h.L}/mutes`, h.as("Olga"), { coach: "Lad", duration: "1h" });
    const dir = join(h.root, "boards");
    const snap = () => readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("|");
    const before = snap();
    for (const who of [undefined, "Mia", "Olga", "Tess"]) {
      for (const p of ["", "/status", "/reports", "/mutes", "/log"]) await h.call("GET", `${h.L}${p}`, who ? h.as(who) : undefined);
      for (const p of ["", "/status"]) await h.call("GET", `${h.T}${p}`, who ? h.as(who) : undefined);
    }
    expect(snap()).toBe(before);
    // a tournament board nobody wrote to has no file at all
    expect(readdirSync(dir)).toHaveLength(1);
    expect(existsSync(join(dir, "nothing"))).toBe(false);
  });

  it("posting is rate limited like the club board (20 posts per 10 minutes)", async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) expect((await h.call("POST", h.L, h.as("Mia"), { title: `T${i}`, text: "x" })).status).toBe(201);
    const r = await h.call("POST", h.L, h.as("Mia"), { title: "one more", text: "x" });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: "rate" });
  });

  it("the seat index refreshes when the league changes (a new season team becomes a member)", async () => {
    const h = harness();
    expect((await h.call("GET", h.L, h.as("Tess"))).status).toBe(403);
    h.comps.push(season("s2", [{ id: "new", coach: "Tess", coachId: "Tess" }]));
    h.bump();
    expect((await h.call("GET", h.L, h.as("Tess"))).status).toBe(200);
  });
});
