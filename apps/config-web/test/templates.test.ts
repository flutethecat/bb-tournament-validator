// Competition templates (src/templates, src/competition/templates.ts): season templates saved from a season and used for
// Start a new season, tournament templates captured from a tournament or the wizard's settings (relative check-in
// times), sharing (use, copy, no edit, revoke keeps what was made), secrets left out, access for a scoped organiser vs
// others, and the privacy export / delete. Isolated temp state dirs; invented names and example.test data only.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagueApi, type LeagueApiDeps } from "../src/leagues/api";
import { LeagueStore } from "../src/leagues/store";
import type { SeasonRecord } from "../src/leagues/types";
import type { TournamentRecord } from "../src/tournaments/types";
import { minutesBefore, relativeText, resolveRelative } from "../src/competition/templates";
import { seasonTemplateFor, templatesApi, type TemplatesAuth, type TemplatesDeps } from "../src/templates/api";
import { TemplateStore } from "../src/templates/store";
import { DELETE_STEPS, STORE_COLLECTORS } from "../src/privacy/collectors";

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";
const PAY = "https://paypal.me/RiverBBL";

let dir: string;
let leagues: LeagueStore;
let templates: TemplateStore;
let notes: Array<{ coach: string; type: string; title: string; body: string }>;
let body: unknown;
const tournaments = new Map<string, TournamentRecord>();

const ORGANISERS = [{ coach: "Jay", displayName: "Jay the Organiser" }, { coach: "Kim", displayName: "Kim K" }, { coach: "Mallory" }, { coach: "Root" }];
const JAY: TemplatesAuth = { coach: "Jay", organizer: true, admin: false };
const KIM: TemplatesAuth = { coach: "Kim", organizer: true, admin: false };
const MALLORY: TemplatesAuth = { coach: "Mallory", organizer: true, admin: false };
const ROOT: TemplatesAuth = { coach: "Root", organizer: false, admin: true };
/** A league organiser who is only a player on the site (scoped role). */
const LEE: TemplatesAuth = { coach: "Lee", organizer: false, admin: false };

const tdeps = (): TemplatesDeps => ({
  store: templates, leagues, tournaments: { tournament: (id: string) => tournaments.get(id) },
  tournamentDiscordEvents: () => ({ published: true, roundPosted: true, matchStarted: false, fixtureCreated: true, nonsense: true }),
  organisers: () => ORGANISERS,
  displayName: (c) => ORGANISERS.find((o) => o.coach.toLowerCase() === c.toLowerCase())?.displayName ?? "",
  notify: (coach, input) => { notes.push({ coach, type: input.type, title: input.title, body: input.body }); },
  now: () => new Date("2026-11-03T12:00:00Z"),
});
const api = (auth: TemplatesAuth | undefined, method: string, path: string, b?: unknown, q = "") => templatesApi(method, path, new URLSearchParams(q), auth, b, tdeps())!;
const ldeps = (): LeagueApiDeps => ({
  store: leagues,
  readBody: async () => Buffer.from(JSON.stringify(body ?? {})),
  now: () => new Date("2026-11-03T12:00:00Z"),
  identities: () => [{ coach: "Jay", level: "organizer" }, { coach: "Kim", level: "organizer" }],
  notify: () => undefined,
  seasonTemplate: (id, coach) => seasonTemplateFor(templates, id, coach),
});
const leagueCall = async (who: { coach: string; admin: boolean }, method: string, path: string, b?: unknown) => {
  body = b;
  return (await leagueApi(method, path, new URLSearchParams(), who, ldeps()))!;
};

const season = (leagueId: string, number: number, over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: `season-${number}`, leagueId, number, name: `Season ${number}`, sourceSlug: `s${number}`, ruleset: "BB2025", status: "active", stage: "active",
  phases: [
    { id: "season-regular", category: "Season", name: "Regular", groups: ["North", "South"], tiebreaks: ["points", "tdDiff"], standings: [
      { group: "North", rank: 1, team: "Grudge Rollers", race: "Human", coach: "Ann", points: 3, played: 1, wins: 1, draws: 0, losses: 0, tdFor: 2, tdAgainst: 1, casFor: 1, casAgainst: 0,
        injuriesFor: 0, injuriesAgainst: 0, completions: 0, interceptions: 0, deathsFor: 0, deathsAgainst: 0, foulsFor: 0, foulsAgainst: 0, sentOffsFor: 0, sentOffsAgainst: 0, secretObjectives: 0, buchholz: 0 },
    ] },
    { id: "cup-play-offs", category: "Cup", name: "Play-offs", groups: [""], format: "knockout", standings: [] },
  ],
  fixtures: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-01T00:00:00Z", source: "manual",
  teams: [{ id: "grudge", name: "Grudge Rollers", race: "Human", coach: "Ann", coachId: "Ann", teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: true, tier: "1", raceLeague: "", players: [], formerPlayers: [] }],
  participants: [{ coach: "Ann", coachId: "Ann", country: "US", race: "Human", team: "Grudge Rollers", active: true }],
  registration: {
    allowedRosters: { official: true, nafApproved: false, unofficial: true }, allowRegistration: true, maxRegistrations: 12, maxPerRace: 2,
    opensAt: "2026-09-01T00:00:00.000Z", closesAt: "2026-09-20T00:00:00.000Z", approval: "auto", waitlist: false, allowExistingTeams: true, allowMidSeason: true,
    entryFee: "10 USD", payPal: PAY, venmo: "River-BBL",
  },
  ...over,
});

const tournament = (over: Partial<TournamentRecord> = {}): TournamentRecord => ({
  id: "spring-open", name: "Spring Open", status: "draft", format: "swiss", packageName: "BB2025 Default", maxPlayers: 24, roundCount: 5, roundCountExplicit: true,
  currentRound: 0, tiebreakers: ["sonnebornBerger", "headToHead", "touchdownDifferential"], points: { win: 2000, draw: 1000, loss: 0, bye: 2000 },
  startsAt: "2026-12-05T09:00:00.000Z", turnTimer: { enforced: "required", seconds: 240 }, ownerCoachId: "Jay", organizerCoachId: "Jay", organizerCoachIds: ["Kim"],
  pairingSystem: "monrad", seedingMode: "manual", playOnFork: false, entryFee: "15 GBP", payPal: PAY, venmo: "Spring-Open",
  location: { venue: "Example Hall", address: "1 Example Road" }, summary: "A summary that is not copied.",
  deadlines: { registration: "2026-12-01T09:00:00.000Z", checkIn: "2026-12-05T08:30:00.000Z" },
  registration: { opensAt: "2026-11-05T09:00:00.000Z", approval: "organiser", waitlist: false, rosterLater: true, rosterBy: "2026-12-03T09:00:00.000Z", checkIn: { self: true, opensAt: "2026-12-04T09:00:00.000Z" } },
  houseRules: { prayers: { mode: "banned" }, brawlingBrutes: "on", maxStatIncreasesTeam: 6, maxStatIncreasesPlayer: 2, progression: { enabled: true, spp: true, injuries: false, treasury: false } },
  pairingAvoid: "club", regions: ["West", "East"], nafSanctioned: true,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
} as TournamentRecord);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "templates-"));
  leagues = new LeagueStore(dir);
  templates = new TemplateStore(dir);
  notes = [];
  tournaments.clear();
  tournaments.set("spring-open", tournament());
  leagues.upsertLeague({ id: "river", name: "River BBL", fullName: "River Blood Bowl League", slug: "river", organisers: ["Jay", "Lee"], owner: "Jay",
    ruleset: "BB2025", rulesetPackage: "Small Gods", regions: ["Upstream", "Downstream"],
    houseRules: { prayers: { mode: "cost", costK: 50 }, brawlingBrutes: "off", maxStatIncreasesTeam: 8, maxStatIncreasesPlayer: 3, mvp: "pick3", hireFire: "enforced" } });
  leagues.setSecrets("river", { discordWebhookUrl: HOOK });
  leagues.putSeason(season("river", 1, { status: "completed", stage: undefined }));
  leagues.upsertLeague({ id: "lake", name: "Lake League", fullName: "Lake League", slug: "lake", organisers: ["Kim"], owner: "Kim" });
  leagues.upsertLeague({ id: "pond", name: "Pond League", fullName: "Pond League", slug: "pond", organisers: ["Jay"], owner: "Jay" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const saveSeason = async (auth = JAY, extra: Record<string, unknown> = {}) => api(auth, "POST", "/api/templates", { kind: "season", name: "River format", description: "Two divisions and a cup.", from: { leagueId: "river", seasonId: "season-1" }, ...extra });
type View = { id: string; mine: boolean; owner: string; content: Record<string, any>; sharedWith?: Array<{ coach: string }>; hasPayLinks?: boolean; revision: number };
const tpl = (r: { body: unknown }) => (r.body as { template: View }).template;

describe("season templates", () => {
  it("save captures phases, divisions, registration settings, regions, payment-link defaults and the rules + house rules snapshot", async () => {
    const r = await saveSeason();
    expect(r.status).toBe(201);
    const c = tpl(r).content;
    expect(c.ruleset).toBe("BB2025");
    expect(c.rulesetPackage).toBe("Small Gods");
    expect(c.houseRules).toEqual({ prayers: { mode: "cost", costK: 50 }, brawlingBrutes: "off", maxStatIncreasesTeam: 8, maxStatIncreasesPlayer: 3, mvp: "pick3", hireFire: "enforced" });
    expect(c.phases).toEqual([
      { id: "season-regular", category: "Season", name: "Regular", groups: ["North", "South"], tiebreaks: ["points", "tdDiff"] },
      { id: "cup-play-offs", category: "Cup", name: "Play-offs", groups: [""], format: "knockout" },
    ]);
    expect(c.registration).toEqual({ allowedRosters: { official: true, nafApproved: false, unofficial: true }, allowRegistration: true, maxRegistrations: 12, maxPerRace: 2,
      approval: "auto", waitlist: false, allowExistingTeams: true, allowMidSeason: true, entryFee: "10 USD" });
    expect(c.regions).toEqual(["Upstream", "Downstream"]);
    expect(c.payLinks).toEqual({ payPal: PAY, venmo: "River-BBL" });
    expect(tpl(r).hasPayLinks).toBe(true);
  });

  it("never copies secrets or coach data: no webhook, standings, teams, participants, dates", async () => {
    await saveSeason();
    const raw = readFileSync(join(dir, "competition-templates.json"), "utf8");
    for (const bad of ["webhooks", "discord.com", "Grudge Rollers", "\"Ann\"", "standings", "opensAt", "closesAt", "participants"]) expect(raw).not.toContain(bad);
    // without the payment links when the organiser leaves them out
    const r = await saveSeason(JAY, { includePayLinks: false });
    expect(tpl(r).content.payLinks).toBeUndefined();
  });

  it("New season From template applies every captured field (with its rules and, when asked, its payment links)", async () => {
    const id = tpl(await saveSeason()).id;
    const made = await leagueCall({ coach: "Jay", admin: false }, "POST", "/api/leagues/pond/seasons", { from: "template", templateId: id, usePayLinks: true });
    expect(made.status).toBe(201);
    expect((made.body as any).template).toEqual({ name: "River format", rulesApplied: true });
    const s = leagues.season("pond", "season-1")!;
    expect(s.phases.map((p) => [p.id, p.groups, p.format ?? "table", p.standings.length])).toEqual([["season-regular", ["North", "South"], "table", 0], ["cup-play-offs", [""], "knockout", 0]]);
    expect(s.registration).toMatchObject({ maxRegistrations: 12, maxPerRace: 2, approval: "auto", waitlist: false, allowExistingTeams: true, allowMidSeason: true, entryFee: "10 USD", payPal: PAY, venmo: "River-BBL" });
    expect(s.registration!.opensAt).toBeUndefined();
    expect(s.stage).toBe("setup");
    expect(s.teams).toEqual([]);
    const pond = leagues.league("pond")!;
    expect(pond.rulesetPackage).toBe("Small Gods");
    expect(pond.houseRules).toMatchObject({ prayers: { mode: "cost", costK: 50 }, mvp: "pick3" });
    expect(pond.regions).toEqual(["Upstream", "Downstream"]);
  });

  it("New season Copy last season takes the newest season's phases and registration settings (no dates, no teams)", async () => {
    const made = await leagueCall({ coach: "Jay", admin: false }, "POST", "/api/leagues/river/seasons", { from: "last" });
    expect(made.status).toBe(201);
    const s = leagues.season("river", "season-2")!;
    expect(s.phases.map((p) => p.groups)).toEqual([["North", "South"], [""]]);
    expect(s.phases[0]!.standings).toEqual([]);
    expect(s.registration).toMatchObject({ maxRegistrations: 12, approval: "auto", entryFee: "10 USD" });
    expect(s.registration!.closesAt).toBeUndefined();
    expect(s.teams).toEqual([]);
  });

  it("the template's rules never replace the league's silently while another season runs with coaches", async () => {
    const id = tpl(await saveSeason()).id;
    leagues.putSeason(season("pond", 1)); // running, with a coach
    const refused = await leagueCall({ coach: "Jay", admin: false }, "POST", "/api/leagues/pond/seasons", { from: "template", templateId: id });
    expect(refused.status).toBe(409);
    expect((refused.body as any).field).toBe("applyRules");
    const ok = await leagueCall({ coach: "Jay", admin: false }, "POST", "/api/leagues/pond/seasons", { from: "template", templateId: id, applyRules: false });
    expect(ok.status).toBe(201);
    expect(leagues.league("pond")!.rulesetPackage).toBeUndefined();
  });

  it("unticking Use its rules keeps the league's base ruleset too (BB2020 template into a BB2025 league)", async () => {
    leagues.updateLeague("river", (l) => { delete l.rulesetPackage; l.ruleset = "BB2020"; });
    leagues.putSeason({ ...season("river", 1, { status: "completed", stage: undefined }), ruleset: "BB2020" });
    const id = tpl(await saveSeason()).id;
    expect((templates.get(id)!.content as { ruleset: string }).ruleset).toBe("BB2020");
    leagues.updateLeague("pond", (l) => { l.ruleset = "BB2025"; });
    const kept = await leagueCall({ coach: "Jay", admin: false }, "POST", "/api/leagues/pond/seasons", { from: "template", templateId: id, applyRules: false });
    expect(kept.status).toBe(201);
    expect(leagues.season("pond", "season-1")!.ruleset).toBe("BB2025");
    expect(leagues.league("pond")!.ruleset).toBe("BB2025");
    expect((kept.body as any).template.rulesApplied).toBe(false);
    // ticked (the default): the template's ruleset comes with its rules
    const taken = await leagueCall({ coach: "Jay", admin: false }, "POST", "/api/leagues/pond/seasons", { from: "template", templateId: id });
    expect(taken.status).toBe(201);
    expect(leagues.season("pond", "season-2")!.ruleset).toBe("BB2020");
    expect(leagues.league("pond")!.ruleset).toBe("BB2020");
  });

  it("a ladder can't be saved as a season template", async () => {
    leagues.putSeason({ ...season("river", 9), id: "ladder-1", competition: "ladder" } as SeasonRecord);
    const r = api(JAY, "POST", "/api/templates", { kind: "season", name: "x", from: { leagueId: "river", seasonId: "ladder-1" } });
    expect([404, 409]).toContain(r.status);
  });
});

describe("tournament templates", () => {
  it("captured from a tournament: settings kept, times stored relative to the start, webhook and page text left out", () => {
    const r = api(JAY, "POST", "/api/templates", { kind: "tournament", name: "Open format", from: { tournamentId: "spring-open" } });
    expect(r.status).toBe(201);
    const c = tpl(r).content;
    expect(c).toMatchObject({
      packageName: "BB2025 Default", format: "swiss", roundCount: 5, pairingSystem: "monrad", seedingMode: "manual", turnTimer: "required",
      tiebreakers: ["sonnebornBerger", "headToHead", "touchdownDifferential"], points: { win: 2000, draw: 1000, loss: 0 }, pairingAvoid: "club",
      regions: ["West", "East"], maxPlayers: 24, approval: "organiser", waitlist: false, rosterLater: true, selfCheckIn: true, nafSanctioned: true, entryFee: "15 GBP",
      houseRules: { prayers: { mode: "banned" }, brawlingBrutes: "on", progression: { enabled: true, spp: true, injuries: false, treasury: false } },
      payLinks: { payPal: PAY, venmo: "Spring-Open" },
    });
    expect(c.relative).toEqual({ registrationOpens: 30 * 1440, registrationCloses: 4 * 1440, rosterBy: 2 * 1440, checkInOpens: 1440, checkInCloses: 30 });
    // Discord: toggles only, tournament keys only (fixtureCreated is a league key; nonsense is no key)
    expect(c.discordEvents).toEqual({ published: true, roundPosted: true, matchStarted: false });
    const raw = readFileSync(join(dir, "competition-templates.json"), "utf8");
    for (const bad of ["webhooks", "Example Hall", "1 Example Road", "A summary"]) expect(raw).not.toContain(bad);
  });

  it("a legacy tournament (no registration settings) is captured with its effective settings: no waitlist, roster with the entry, no self check-in", () => {
    const { registration: _r, ...legacy } = tournament();
    tournaments.set("old-cup", { ...legacy, id: "old-cup" } as TournamentRecord);
    const c = tpl(api(JAY, "POST", "/api/templates", { kind: "tournament", name: "Old cup", from: { tournamentId: "old-cup" } })).content;
    expect(c).toMatchObject({ approval: "auto", waitlist: false, rosterLater: false, selfCheckIn: false });
    expect(c.relative).toMatchObject({ registrationOpens: null, rosterBy: null, checkInOpens: null, checkInCloses: null, registrationCloses: 4 * 1440 });
  });

  it("relative check-in times resolve against a new start date", () => {
    const c = tpl(api(JAY, "POST", "/api/templates", { kind: "tournament", name: "Open format", from: { tournamentId: "spring-open" } })).content;
    const start = "2027-03-06T10:00:00.000Z";
    expect(resolveRelative(start, c.relative.checkInOpens)).toBe("2027-03-05T10:00:00.000Z");
    expect(resolveRelative(start, c.relative.checkInCloses)).toBe("2027-03-06T09:30:00.000Z");
    expect(resolveRelative(start, c.relative.registrationCloses)).toBe("2027-03-02T10:00:00.000Z");
    expect(resolveRelative("", c.relative.checkInOpens)).toBe("");
    expect(resolveRelative(start, null)).toBe("");
    expect(minutesBefore(start, "2027-03-05T10:00:00.000Z")).toBe(1440);
    expect(relativeText(1440)).toBe("1 day before the start");
    expect(relativeText(30)).toBe("30 minutes before the start");
    expect(relativeText(-120)).toBe("2 hours after the start");
  });

  it("saved from the wizard's settings: checked by the tournament parsers, unknown fields (a webhook) dropped", () => {
    const content = {
      packageName: "BB2025 Default", format: "roundRobin", maxPlayers: 8, points: { win: 3, draw: 1, loss: 0 }, tiebreakers: ["headToHead"],
      relative: { checkInOpens: 120, checkInCloses: 0 }, discordEvents: { published: false, matchResult: true }, webhook: HOOK, discordWebhookUrl: HOOK,
      entrants: [{ coach: "Ann" }],
    };
    const r = api(JAY, "POST", "/api/templates", { kind: "tournament", name: "Round robin night", content });
    expect(r.status).toBe(201);
    expect(tpl(r).content).toMatchObject({ format: "roundRobin", maxPlayers: 8, relative: { checkInOpens: 120, checkInCloses: 0, registrationOpens: null }, discordEvents: { published: false, matchResult: true } });
    const raw = readFileSync(join(dir, "competition-templates.json"), "utf8");
    expect(raw).not.toContain("webhooks");
    expect(raw).not.toContain("Ann");
    // bad settings are refused with the parsers' words
    expect(api(JAY, "POST", "/api/templates", { kind: "tournament", name: "x", content: { ...content, points: { win: 1, draw: 1, loss: 0 } } }).status).toBe(400);
    expect(api(JAY, "POST", "/api/templates", { kind: "tournament", name: "x", content: { ...content, relative: { checkInOpens: 10 ** 9 } } }).status).toBe(400);
    expect(api(JAY, "POST", "/api/templates", { kind: "tournament", name: "x", content: { ...content, payLinks: { payPal: "https://evil.example.test/pay" } } }).status).toBe(400);
  });
});

describe("sharing", () => {
  it("shared organisers use and copy, never edit; revoke keeps what was already made", async () => {
    const id = tpl(await saveSeason()).id;
    // share by account with a site organiser; they get a notification
    const shared = api(JAY, "POST", `/api/templates/${id}/share`, { coach: "kim" });
    expect(shared.status).toBe(200);
    expect(tpl(shared).sharedWith!.map((s) => s.coach)).toEqual(["Kim"]);
    expect(notes).toEqual([expect.objectContaining({ coach: "Kim", type: "template-shared", title: "Jay the Organiser shared a season template with you" })]);
    // Kim sees it (no payment links, no list of who else has access, the owner by display name)
    const seen = (api(KIM, "GET", "/api/templates", undefined, "kind=season").body as { templates: View[] }).templates;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id, mine: false, owner: "Jay the Organiser" });
    expect(seen[0]!.content.payLinks).toBeUndefined();
    expect(seen[0]!.sharedWith).toBeUndefined();
    expect(seen[0]!.hasPayLinks).toBeUndefined();
    // no edit, delete or share for Kim
    expect(api(KIM, "PATCH", `/api/templates/${id}`, { revision: 1, name: "Mine now" }).status).toBe(403);
    expect(api(KIM, "DELETE", `/api/templates/${id}`).status).toBe(403);
    expect(api(KIM, "POST", `/api/templates/${id}/share`, { coach: "Mallory" }).status).toBe(403);
    expect(api(KIM, "POST", `/api/templates/${id}/unshare`, { coach: "Kim" }).status).toBe(403);
    // Kim uses it in her league (the owner's payment links never reach her season, even if she asks)
    const made = await leagueCall({ coach: "Kim", admin: false }, "POST", "/api/leagues/lake/seasons", { from: "template", templateId: id, usePayLinks: true });
    expect(made.status).toBe(201);
    expect(leagues.season("lake", "season-1")!.registration).toMatchObject({ maxRegistrations: 12, entryFee: "10 USD" });
    expect(leagues.season("lake", "season-1")!.registration!.payPal).toBeUndefined();
    // Kim makes her own copy: hers, editable, without the owner's payment links
    const copy = api(KIM, "POST", `/api/templates/${id}/copy`, {});
    expect(copy.status).toBe(201);
    expect(tpl(copy)).toMatchObject({ mine: true, owner: "Kim" });
    expect(tpl(copy).content.payLinks).toBeUndefined();
    expect(api(KIM, "PATCH", `/api/templates/${tpl(copy).id}`, { revision: 0, name: "Lake format" }).status).toBe(200);
    // the owner stops sharing: Kim loses the original (404), keeps her season and her copy
    expect(api(JAY, "POST", `/api/templates/${id}/unshare`, { coach: "Kim" }).status).toBe(200);
    expect(api(KIM, "GET", `/api/templates/${id}`).status).toBe(404);
    expect((await leagueCall({ coach: "Kim", admin: false }, "POST", "/api/leagues/lake/seasons", { from: "template", templateId: id })).status).toBe(404);
    expect(leagues.season("lake", "season-1")!.phases.map((p) => p.groups)).toEqual([["North", "South"], [""]]);
    expect(api(KIM, "GET", `/api/templates/${tpl(copy).id}`).status).toBe(200);
    // the owner still edits and owns the original
    expect(api(JAY, "PATCH", `/api/templates/${id}`, { revision: tpl(api(JAY, "GET", `/api/templates/${id}`)).revision, name: "River format v2" }).status).toBe(200);
  });

  it("share targets are site organisers, found by display name, linked by account", async () => {
    const id = tpl(await saveSeason()).id;
    expect((api(JAY, "GET", "/api/templates/organisers", undefined, "q=kim k").body as any).organisers).toEqual([{ coach: "Kim", name: "Kim K" }]);
    expect((api(JAY, "GET", "/api/templates/organisers", undefined, "q=jay").body as any).organisers).toEqual([]); // never yourself
    expect(api(JAY, "POST", `/api/templates/${id}/share`, { coach: "Lee" }).status).toBe(400); // a player
    expect(api(JAY, "POST", `/api/templates/${id}/share`, { coach: "Kim K" }).status).toBe(400); // a display name is not an account
    expect(api(JAY, "POST", `/api/templates/${id}/share`, { coach: "Jay" }).status).toBe(400);
  });
});

describe("access control", () => {
  it("only the owner and shared organisers read; others (admins included) get 404", async () => {
    const id = tpl(await saveSeason()).id;
    for (const who of [MALLORY, ROOT, KIM, LEE]) {
      expect(api(who, "GET", `/api/templates/${id}`).status).toBe(404);
      expect(api(who, "PATCH", `/api/templates/${id}`, { revision: 0, name: "x" }).status).toBe(404);
      expect(api(who, "DELETE", `/api/templates/${id}`).status).toBe(404);
      expect(api(who, "POST", `/api/templates/${id}/copy`, {}).status).toBe(404);
      expect((api(who, "GET", "/api/templates").body as { templates: unknown[] }).templates).toEqual([]);
      expect(() => seasonTemplateFor(templates, id, who.coach)).toThrow("Template not found.");
    }
    expect(api(undefined, "GET", "/api/templates").status).toBe(401);
    expect(api({ ...JAY, test: true }, "POST", "/api/templates", { kind: "season", name: "x", from: { leagueId: "river", seasonId: "season-1" } }).status).toBe(403);
  });

  it("a league-scoped organiser saves from the league they run, and nowhere else", async () => {
    // Lee organises River only (site level: player)
    const r = await saveSeason(LEE);
    expect(r.status).toBe(201);
    expect(tpl(r).owner).toBe("Lee");
    expect(api(LEE, "POST", "/api/templates", { kind: "season", name: "x", from: { leagueId: "lake", seasonId: "season-1" } }).status).toBe(404);
    expect(api(LEE, "POST", "/api/templates", { kind: "tournament", name: "x", from: { tournamentId: "spring-open" } }).status).toBe(404);
    expect(api(LEE, "POST", "/api/templates", { kind: "tournament", name: "x", content: { packageName: "BB2025 Default" } }).status).toBe(403);
    // Kim co-organises the tournament: she may save it; Mallory may not
    expect(api(KIM, "POST", "/api/templates", { kind: "tournament", name: "x", from: { tournamentId: "spring-open" } }).status).toBe(201);
    expect(api(MALLORY, "POST", "/api/templates", { kind: "tournament", name: "x", from: { tournamentId: "spring-open" } }).status).toBe(404);
    // Mallory runs no league here
    expect((await saveSeason(MALLORY)).status).toBe(404);
  });

  it("stale or missing revisions are refused; bad input answers 400", async () => {
    const t = tpl(await saveSeason());
    expect(api(JAY, "PATCH", `/api/templates/${t.id}`, { name: "x" }).status).toBe(428);
    expect(api(JAY, "PATCH", `/api/templates/${t.id}`, { revision: 7, name: "x" }).status).toBe(409);
    expect(api(JAY, "POST", "/api/templates", { kind: "ladder", name: "x" }).status).toBe(400);
    expect(api(JAY, "POST", "/api/templates", { kind: "season", name: "", from: { leagueId: "river", seasonId: "season-1" } }).status).toBe(400);
    expect(api(JAY, "POST", "/api/templates", { kind: "season", name: "x".repeat(61), from: { leagueId: "river", seasonId: "season-1" } }).status).toBe(400);
    expect(api(JAY, "GET", "/api/templates/not-an-id").status).toBe(404);
  });
});

describe("privacy export and delete", () => {
  it("exports the coach's own templates and what was shared with them; delete removes their templates and their share grants", async () => {
    const jays = tpl(await saveSeason()).id;
    const kims = tpl(api(KIM, "POST", "/api/templates", { kind: "tournament", name: "Kim's open", from: { tournamentId: "spring-open" } })).id;
    api(JAY, "POST", `/api/templates/${jays}/share`, { coach: "Kim" });
    api(KIM, "POST", `/api/templates/${kims}/share`, { coach: "Jay" });
    const collector = STORE_COLLECTORS.find((c) => c.id === "competition-templates")!;
    const exportFn = collector.export as (ctx: unknown) => Array<{ name: string; content: string }>;
    const files = exportFn({ deps: { stateDir: dir }, coach: "Kim", keys: new Set(["kim"]) });
    const data = JSON.parse(files[0]!.content);
    expect(files[0]!.name).toBe("templates.json");
    expect(data.own.map((t: { id: string }) => t.id)).toEqual([kims]);
    expect(data.sharedWithYou).toEqual([{ id: jays, kind: "season", name: "River format", owner: "Jay", sharedAt: "2026-11-03T12:00:00.000Z" }]);
    expect(exportFn({ deps: { stateDir: dir }, coach: "Nobody", keys: new Set(["nobody"]) })).toEqual([]);
    // delete Kim: her template goes, and her grant on Jay's template goes; Jay's template stays
    const step = DELETE_STEPS.find((s) => s.id === "competition-templates")!;
    await step.run({ deps: { stateDir: dir }, names: new Set(["kim"]) } as never);
    const after = templates.all();
    expect(after.map((t) => t.id)).toEqual([jays]);
    expect(after[0]!.sharedWith).toEqual([]);
    expect(collector.erase).toEqual(["competition-templates", "final-sweep"]);
  });
});
