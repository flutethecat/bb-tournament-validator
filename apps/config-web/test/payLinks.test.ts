import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { createSSRApp } from "vue";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { leagueApi, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "../src/leagues/api";
import { defaultSeasonRegistration, seasonRegistrationOf } from "../src/leagues/seasonRegistration";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueTeam, SeasonRecord } from "../src/leagues/types";
import { createTournamentNotifier, type NotificationInput, type NotificationRecord, type TournamentNotify } from "../src/notifications";
import * as server from "../src/payments/links";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api";
import { TournamentStore } from "../src/tournaments/store";
import type { TournamentRecord } from "../src/tournaments/types";
import * as spa from "../spa/src/shared/payLinks";

// Payment links (owner 11-02, links only): validation (server authority, SPA mirror), the tournament and league wizards
// and settings round trips, the "Pay entry fee" read models, the per-entry Paid privacy (laws 21-22) with scoped-role
// actors, who/when on Paid, the coach's notification (none for drafts), and the overview block rendering. Each test has
// its own state dir (laws §C14). Fake names and handles only.

const roots: string[] = [];
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

// ---- validation ----

const PAYPAL_GOOD: Array<[string, string]> = [
  ["https://paypal.me/ExampleOrg", "https://paypal.me/ExampleOrg"],
  ["paypal.me/ExampleOrg", "https://paypal.me/ExampleOrg"],
  ["  https://PAYPAL.ME/ExampleOrg/  ", "https://paypal.me/ExampleOrg"],
  ["https://paypal.me/ExampleOrg/15", "https://paypal.me/ExampleOrg/15"],
  ["https://paypal.me/ExampleOrg/15.50gbp", "https://paypal.me/ExampleOrg/15.50GBP"],
  ["https://www.paypal.com/paypalme/ExampleOrg", "https://www.paypal.com/paypalme/ExampleOrg"],
  ["www.paypal.com/paypalme/ExampleOrg/10USD", "https://www.paypal.com/paypalme/ExampleOrg/10USD"],
  ["HTTPS://WWW.PAYPAL.COM/PayPalMe/Ex4mple", "https://www.paypal.com/paypalme/Ex4mple"],
];
const PAYPAL_BAD = [
  "http://paypal.me/ExampleOrg", // https only
  "javascript:alert(1)",
  "JavaScript://paypal.me/%0aalert(1)",
  "data:text/html,<script>alert(1)</script>",
  "https://evil.example/paypal.me/ExampleOrg",
  "https://paypal.me.evil.example/ExampleOrg",
  "https://evil.example#paypal.me/ExampleOrg",
  "https://paypal.me@evil.example/ExampleOrg",
  "https://user:pw@paypal.me/ExampleOrg",
  "https://paypal.me:8443/ExampleOrg",
  "https://paypal.me\\@evil.example",
  "https://paypal.me/Example%2FOrg",
  "https://paypal.me/ExampleOrg?next=https://evil.example",
  "https://paypal.me/ExampleOrg#x",
  "https://paypal.me/",
  "https://paypal.me//ExampleOrg",
  "https://paypal.me/Example-Org", // PayPal.Me names are letters and digits
  "https://paypal.me/ExampleOrgWithAVeryLongName1", // over 20
  "https://paypal.me/ExampleOrg/ten",
  "https://paypal.me/ExampleOrg/15/extra",
  "https://www.paypal.com/ExampleOrg",
  "https://paypal.com/paypalme/ExampleOrg", // only www.paypal.com
  "https://www.paypal.com/donate/?hosted_button_id=X",
  "https://venmo.com/u/Example-Org",
  "https://xn--pypal-4ve.me/ExampleOrg", // look-alike host
  "https://pаypal.me/ExampleOrg", // Cyrillic a
  "https:paypal.me/ExampleOrg",
  "https://paypal.me/Example Org",
  "ftp://paypal.me/ExampleOrg",
  `https://paypal.me/${"a".repeat(300)}`,
];
const VENMO_GOOD: Array<[string, string]> = [["Example-Org", "Example-Org"], ["@Example_Org", "Example_Org"], ["  @abcde ", "abcde"], ["a".repeat(30), "a".repeat(30)]];
const VENMO_BAD = ["abcd", "@abcd", "a".repeat(31), "@@Example-Org", "Example Org", "Example.Org", "https://venmo.com/u/Example-Org", "javascript:alert(1)", "Exämple-Org", "<b>Example</b>"];

describe("payment link validation (server, and the SPA mirror on the same cases)", () => {
  for (const [name, impl] of [["server", server], ["spa", spa]] as const) {
    it(`${name}: PayPal.Me links normalise to the https form; everything else is refused`, () => {
      for (const [raw, want] of PAYPAL_GOOD) expect(impl.normalisePayPal(raw), raw).toEqual({ ok: true, value: want });
      for (const raw of PAYPAL_BAD) expect(impl.normalisePayPal(raw).ok, raw).toBe(false);
      expect(impl.normalisePayPal("   ")).toEqual({ ok: true, value: "" });
    });
    it(`${name}: Venmo usernames are stored without the @`, () => {
      for (const [raw, want] of VENMO_GOOD) expect(impl.normaliseVenmo(raw), raw).toEqual({ ok: true, value: want });
      for (const raw of VENMO_BAD) expect(impl.normaliseVenmo(raw).ok, raw).toBe(false);
      expect(impl.normaliseVenmo("")).toEqual({ ok: true, value: "" });
    });
  }

  it("the server re-checks stored values on read; only paypal.me / paypal.com and venmo.com/u links come out", () => {
    expect(server.paymentLinksView("https://paypal.me/ExampleOrg", "Example-Org")).toEqual({
      payPal: "https://paypal.me/ExampleOrg", venmo: { handle: "Example-Org", url: "https://venmo.com/u/Example-Org" },
    });
    expect(server.paymentLinksView("javascript:alert(1)", "x")).toBeUndefined();
    expect(server.paymentLinksView("paypal.me/ExampleOrg", "")).toBeUndefined(); // not the stored https form
    expect(server.paymentLinksView(42, { evil: true })).toBeUndefined();
    expect(server.venmoUrl("../evil")).toBeUndefined();
    expect(server.parsePayField("venmo", 5)).toEqual({ ok: false, error: server.VENMO_ERROR });
    expect(server.parsePayField("payPal", null)).toEqual({ ok: true, value: "" });
    expect(server.parsePayField("payPal", undefined)).toBeUndefined();
  });

  it("the SPA renders only safe links from what the server sent", () => {
    expect(spa.safePaymentLinks({ payPal: "javascript:alert(1)", venmo: { handle: "a b", url: "javascript:alert(1)" } })).toBeUndefined();
    // The Venmo href is rebuilt from the handle, never taken from the payload.
    expect(spa.safePaymentLinks({ venmo: { handle: "Example-Org", url: "https://evil.example" } })).toEqual({ venmo: { handle: "Example-Org", url: "https://venmo.com/u/Example-Org" } });
    expect(spa.paymentStatusText(true)).toBe("Payment: received");
    expect(spa.paymentStatusText(false)).toBe("Payment: not yet marked");
    expect(spa.PAY_NOTE).toBe("Payment is made directly to the organiser. Super FUMBBL doesn't handle payments.");
  });
});

// ---- tournaments ----

const NOW = new Date("2026-11-02T12:00:00.000Z");
const VEERS: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
/** A per-tournament organiser of A only: no site organiser or admin level (the scoped role alone). */
const PIETT: TournamentApiIdentity = { coach: "Piett", organizer: false, admin: false };
/** A site organiser (global role) who is not a manager of either tournament. */
const THRAWN: TournamentApiIdentity = { coach: "Thrawn", organizer: true, admin: false };
const coach = (name: string): TournamentApiIdentity => ({ coach: name, organizer: false, admin: false });

type Sent = { coach: string; input: NotificationInput };
function tournamentFixture() {
  const dir = tmp("bbtv-paylinks-t-");
  const store = new TournamentStore(dir);
  const sent: Sent[] = [];
  const notify: TournamentNotify = createTournamentNotifier({ add: (c: string, input: NotificationInput) => { sent.push({ coach: c, input }); return {} as NotificationRecord; } }, store);
  const deps = (): TournamentApiDeps => ({
    store, teamBuild: (teamId) => ({ teamId, teamName: `${teamId} XI` }), packageExists: (n) => n === "Spike 2026", registeredCoach: (n) => n, notify, now: () => NOW,
  });
  const call = (method: string, path: string, auth?: TournamentApiIdentity, body?: unknown) => tournamentApi(method, path, new URLSearchParams(), auth, body, deps());
  const a = store.createTournament({ name: "Spike Open", packageName: "Spike 2026", maxPlayers: 8, format: "swiss", organizerCoachId: "Veers", roundCount: 3 }, NOW);
  store.addOrganizer(a.id, "Piett", NOW);
  const b = store.createTournament({ name: "Other Cup", packageName: "Spike 2026", maxPlayers: 8, format: "swiss", organizerCoachId: "Mon", roundCount: 3 }, NOW);
  for (const [t, name] of [[a.id, "Alice"], [a.id, "Bob"], [b.id, "Cy"]] as const)
    store.registerEntrant(t, { coachId: name, ffbCoachId: name, verifiedAt: NOW.toISOString() }, `team-${name}`, NOW);
  const entrant = (t: string, name: string) => store.entrants(t).find((e) => e.coach.ffbCoachId === name)!;
  const patchPath = (t: string, name: string) => `/api/tournaments/${t}/entrants/${encodeURIComponent(entrant(t, name).id)}`;
  return { dir, store, sent, call, a: a.id, b: b.id, entrant, patchPath };
}
type Entrants = Array<{ coachId: string; flags?: { paid: boolean }; paidUpdated?: unknown }>;
const entrantsOf = (r: unknown): Entrants => ((r as { body: { entrants: Entrants } }).body.entrants);

describe("tournament payment links", () => {
  it("wizard: the links round-trip to a draft (normalised), publish keeps them, and the public read shows them", async () => {
    const { store, call } = tournamentFixture();
    const body = { name: "Hidden Cup", packageName: "Spike 2026", maxPlayers: 8, format: "swiss", entryFee: "15 GBP", payPal: "paypal.me/ExampleOrg/15gbp", venmo: "@Example-Org" };
    const draft = await call("POST", "/api/tournaments", VEERS, { ...body, publish: false });
    expect(draft!.status).toBe(201);
    const t = (draft!.body as { tournament: TournamentRecord & { paymentLinks?: unknown } }).tournament;
    expect(store.tournament(t.id)).toMatchObject({ unpublished: true, payPal: "https://paypal.me/ExampleOrg/15GBP", venmo: "Example-Org" });
    // Hidden from everyone but its managers, links and all.
    expect((await call("GET", `/api/tournaments/${t.id}`, undefined))!.status).toBe(404);
    expect(((await call("GET", `/api/tournaments/${t.id}`, VEERS))!.body as { tournament: { paymentLinks?: unknown } }).tournament.paymentLinks).toEqual({
      payPal: "https://paypal.me/ExampleOrg/15GBP", venmo: { handle: "Example-Org", url: "https://venmo.com/u/Example-Org" },
    });
    expect((await call("POST", `/api/tournaments/${t.id}/publish`, VEERS))!.status).toBe(200);
    const pub = (await call("GET", `/api/tournaments/${t.id}`, undefined))!.body as { tournament: { paymentLinks?: unknown; entryFee?: string } };
    expect(pub.tournament).toMatchObject({ entryFee: "15 GBP", paymentLinks: { payPal: "https://paypal.me/ExampleOrg/15GBP", venmo: { url: "https://venmo.com/u/Example-Org" } } });
    // Published straight from the wizard too.
    const live = await call("POST", "/api/tournaments", VEERS, { ...body, name: "Open Cup", publish: true });
    expect((live!.body as { tournament: TournamentRecord }).tournament).toMatchObject({ payPal: "https://paypal.me/ExampleOrg/15GBP", venmo: "Example-Org" });
  });

  it("wizard: a bad link is refused before anything is written", async () => {
    const { store, call } = tournamentFixture();
    const before = Object.keys(store.snapshot().tournaments).length;
    for (const bad of [{ payPal: "javascript:alert(1)" }, { payPal: "http://paypal.me/ExampleOrg" }, { venmo: "ab" }, { payPal: 7 }]) {
      const r = await call("POST", "/api/tournaments", VEERS, { name: "Bad Cup", packageName: "Spike 2026", maxPlayers: 8, format: "swiss", publish: false, ...bad });
      expect(r!.status, JSON.stringify(bad)).toBe(400);
    }
    expect(Object.keys(store.snapshot().tournaments).length).toBe(before);
  });

  it("Manage: set, change and clear the links after publish; bad values change nothing; a coach can't set them", async () => {
    const { store, call, a } = tournamentFixture();
    expect((await call("PATCH", `/api/tournaments/${a}`, VEERS, { payPal: "https://www.paypal.com/paypalme/ExampleOrg", venmo: "Example_Org" }))!.status).toBe(200);
    expect(store.tournament(a)).toMatchObject({ payPal: "https://www.paypal.com/paypalme/ExampleOrg", venmo: "Example_Org" });
    expect((await call("PATCH", `/api/tournaments/${a}`, PIETT, { payPal: "data:text/html,x" }))!.status).toBe(400);
    expect((await call("PATCH", `/api/tournaments/${a}`, PIETT, { venmo: "x" }))!.status).toBe(400);
    expect(store.tournament(a)).toMatchObject({ payPal: "https://www.paypal.com/paypalme/ExampleOrg", venmo: "Example_Org" });
    expect((await call("PATCH", `/api/tournaments/${a}`, coach("Alice"), { payPal: "https://paypal.me/Alice" }))!.status).toBe(403);
    expect((await call("PATCH", `/api/tournaments/${a}`, PIETT, { payPal: null, venmo: "" }))!.status).toBe(200);
    expect(store.tournament(a)).not.toHaveProperty("payPal");
    expect(store.tournament(a)).not.toHaveProperty("venmo");
    expect(((await call("GET", `/api/tournaments/${a}`, undefined))!.body as { tournament: object }).tournament).not.toHaveProperty("paymentLinks");
  });

  it("Paid: the scoped organiser sets it; who and when are recorded; the coach is told \"Payment received\"", async () => {
    const { dir, sent, call, a, entrant, patchPath } = tournamentFixture();
    const r = await call("PATCH", patchPath(a, "Alice"), PIETT, { paid: true });
    expect(r!.status).toBe(200);
    expect(entrant(a, "Alice")).toMatchObject({ flags: { paid: true }, paidUpdated: { by: "Piett", at: NOW.toISOString() } });
    expect(sent).toEqual([{ coach: "Alice", input: expect.objectContaining({ type: "entrant-flag", body: "Payment received.", from: "Piett" }) }]);
    sent.length = 0;
    // A change of another flag leaves the Paid record alone.
    await call("PATCH", patchPath(a, "Alice"), VEERS, { flags: { checkedIn: true } });
    expect(entrant(a, "Alice").paidUpdated).toEqual({ by: "Piett", at: NOW.toISOString() });
    await call("PATCH", patchPath(a, "Alice"), VEERS, { flags: { paid: false } });
    expect(entrant(a, "Alice").paidUpdated?.by).toBe("Veers");
    expect(sent.at(-1)!.input.body).toBe("Payment no longer marked as received.");
    // Written through the store (survives a reload of the file).
    expect(new TournamentStore(dir).entrants(a).find((e) => e.coach.ffbCoachId === "Alice")!.paidUpdated?.by).toBe("Veers");
  });

  it("Paid privacy: anonymous and other coaches never see it; the coach sees only their own; managers see all", async () => {
    const { call, a, patchPath } = tournamentFixture();
    await call("PATCH", patchPath(a, "Alice"), VEERS, { paid: true });
    await call("PATCH", patchPath(a, "Bob"), VEERS, { paid: true });
    const anon = entrantsOf(await call("GET", `/api/tournaments/${a}`, undefined));
    expect(anon.every((e) => e.flags === undefined && e.paidUpdated === undefined)).toBe(true);
    expect(JSON.stringify(anon)).not.toContain("paid");
    const alice = entrantsOf(await call("GET", `/api/tournaments/${a}`, coach("Alice")));
    expect(alice.find((e) => e.coachId === "Alice")!.flags?.paid).toBe(true);
    expect(alice.find((e) => e.coachId === "Bob")).not.toHaveProperty("flags");
    expect(JSON.stringify(alice.find((e) => e.coachId === "Bob"))).not.toContain("paid");
    // A site organiser who manages neither tournament: no flags, no writes, no export.
    const global = entrantsOf(await call("GET", `/api/tournaments/${a}`, THRAWN));
    expect(global.every((e) => e.flags === undefined)).toBe(true);
    expect((await call("PATCH", patchPath(a, "Alice"), THRAWN, { paid: false }))!.status).toBe(403);
    expect((await call("GET", `/api/tournaments/${a}/export`, THRAWN))!.status).toBe(403);
    expect((await call("GET", `/api/tournaments/${a}/export`, coach("Alice")))!.status).toBe(403);
    expect((await call("GET", `/api/tournaments/${a}/export`, undefined))!.status).toBe(401);
    expect((await call("PATCH", patchPath(a, "Bob"), coach("Alice"), { paid: false }))!.status).toBe(403);
    expect((await call("PATCH", patchPath(a, "Bob"), undefined, { paid: false }))!.status).toBe(401);
    const managers = entrantsOf(await call("GET", `/api/tournaments/${a}`, PIETT));
    expect(managers.map((e) => e.flags?.paid)).toEqual([true, true]);
  });

  it("an organiser of A can't read or set Paid on B", async () => {
    const { call, a, b, entrant, patchPath } = tournamentFixture();
    expect((await call("PATCH", patchPath(b, "Cy"), PIETT, { paid: true }))!.status).toBe(403);
    expect(entrant(b, "Cy").flags?.paid).toBe(false);
    expect(entrantsOf(await call("GET", `/api/tournaments/${b}`, PIETT)).every((e) => e.flags === undefined)).toBe(true);
    // Through A's path with B's entrant id: not found, nothing changes.
    expect((await call("PATCH", `/api/tournaments/${a}/entrants/${encodeURIComponent(entrant(b, "Cy").id)}`, PIETT, { paid: true }))!.status).toBe(404);
    expect(entrant(b, "Cy").flags?.paid).toBe(false);
  });

  it("no notification on an unpublished draft", async () => {
    const { store, sent, call, a, patchPath } = tournamentFixture();
    const snap = store.snapshot();
    snap.tournaments[a]!.unpublished = true;
    store.writeSnapshot(snap);
    expect((await call("PATCH", patchPath(a, "Alice"), VEERS, { paid: true }))!.status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("the Paid writes are state changes under the CSRF rule (X-CW-Auth needed with a cookie, law 14b)", () => {
    expect(isStateChangingApiRequest("PATCH", "/api/tournaments/t1/entrants/e1")).toBe(true);
    expect(isStateChangingApiRequest("PATCH", "/api/leagues/tabbl/seasons/season-6/participants/orcs")).toBe(true);
    expect(isStateChangingApiRequest("POST", "/api/leagues/tabbl/seasons/season-6/participants")).toBe(true);
    expect(isStateChangingApiRequest("PATCH", "/api/leagues/tabbl/seasons/season-6/registration")).toBe(true);
    expect(isStateChangingApiRequest("PATCH", "/api/tournaments/t1")).toBe(true);
  });
});

// ---- leagues ----

const JAY: LeagueApiIdentity = { coach: "Jay", admin: false };
/** Organiser of another league only. */
const IVY: LeagueApiIdentity = { coach: "Ivy", admin: false };
/** A site organiser (global role) who organises neither league. */
const OLGA: LeagueApiIdentity = { coach: "Olga", admin: false, organizer: true };
const BOB: LeagueApiIdentity = { coach: "Bob", admin: false };
const DEE: LeagueApiIdentity = { coach: "Dee", admin: false };

const team = (id: string, name: string, coachName: string, over: Partial<LeagueTeam> = {}): LeagueTeam => ({
  id, name, race: "Orc", coach: coachName, teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false,
  tier: "1", raceLeague: "", players: [], formerPlayers: [], ...over,
});
const seasonOf = (leagueId: string, teams: LeagueTeam[]): SeasonRecord => ({
  id: "season-6", leagueId, number: 6, name: "Season 6", sourceSlug: "s6", ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [], teams, participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

function leagueFixture() {
  const store = new LeagueStore(tmp("bbtv-paylinks-l-"));
  let body: unknown;
  const sent: Array<{ coach: string; input: NotificationInput }> = [];
  const deps = (): LeagueApiDeps => ({
    store, now: () => NOW,
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    notify: (c, input) => { sent.push({ coach: c, input: input as NotificationInput }); },
    identities: () => [{ coach: "Olga", level: "organizer" }, { coach: "Jay", level: "player" }],
  });
  const call = async (method: string, p: string, auth: LeagueApiIdentity | undefined, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, p, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route for ${method} ${p}`);
    return r;
  };
  store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
  store.putSeason(seasonOf("tabbl", [
    team("orcs", "Orcs", "Bob", { coachId: "Bob" }), team("elves", "Elves", "Bob", { coachId: "Bob" }), team("dwarfs", "Dwarfs", "Dee", { coachId: "Dee" }),
  ]));
  store.upsertLeague({ id: "other", name: "Other", fullName: "Other League", slug: "other", organisers: ["Ivy"] });
  store.putSeason(seasonOf("other", [team("rats", "Rats", "Cy", { coachId: "Cy" })]));
  const rev = (id = "tabbl") => store.season(id, "season-6")!.revision ?? 0;
  const setLinks = (fields: Record<string, unknown>, auth = JAY) => call("PATCH", "/api/leagues/tabbl/seasons/season-6/registration", auth, { revision: rev(), ...fields });
  const part = (id = "tabbl") => `/api/leagues/${id}/seasons/season-6/participants`;
  const seasonRead = async (auth?: LeagueApiIdentity, id = "tabbl") => (await call("GET", `/api/leagues/${id}/seasons/season-6`, auth)).body as { season: SeasonRecord };
  return { store, sent, call, rev, setLinks, part, seasonRead };
}

describe("league payment links", () => {
  it("season settings: links next to the entry fee, normalised, refused when bad, cleared to \"\" for the season", async () => {
    const { store, setLinks } = leagueFixture();
    const ok = await setLinks({ entryFee: "$10", payPal: "https://paypal.me/ExampleOrg", venmo: "@Example-Org" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(store.season("tabbl", "season-6")!.registration).toMatchObject({ entryFee: "$10", payPal: "https://paypal.me/ExampleOrg", venmo: "Example-Org" });
    for (const bad of [{ payPal: "javascript:alert(1)" }, { payPal: "https://evil.example/x" }, { venmo: "no" }, { venmo: { x: 1 } }]) {
      const r = await setLinks(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect((r.body as { field?: string }).field).toBe(Object.keys(bad)[0]);
    }
    expect((await setLinks({ payPal: "paypal.me/Changed" }, BOB)).status).toBe(403);
    expect((await setLinks({ payPal: "paypal.me/Changed" }, OLGA)).status).toBe(403);
    expect(store.season("tabbl", "season-6")!.registration).toMatchObject({ payPal: "https://paypal.me/ExampleOrg" });
    expect((await setLinks({ payPal: null, venmo: "" })).status).toBe(200);
    expect(store.season("tabbl", "season-6")!.registration).toMatchObject({ payPal: "", venmo: "" });
  });

  it("league defaults: set in League settings, copied by a new season; a season cleared to \"\" keeps no link", async () => {
    const { store, call } = leagueFixture();
    const r = await call("PATCH", "/api/leagues/tabbl/settings", JAY, { revision: store.league("tabbl")!.revision ?? 0, registrations: { payPal: "www.paypal.com/paypalme/ExampleOrg", venmo: "Example-Org" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const league = store.league("tabbl")!;
    expect(league.registrations).toMatchObject({ payPal: "https://www.paypal.com/paypalme/ExampleOrg", venmo: "Example-Org" });
    expect(defaultSeasonRegistration(league)).toMatchObject({ payPal: "https://www.paypal.com/paypalme/ExampleOrg", venmo: "Example-Org" });
    // A season without its own settings reads the league's; one cleared for itself shows none.
    expect(seasonRegistrationOf(league, store.season("tabbl", "season-6"))).toMatchObject({ payPal: "https://www.paypal.com/paypalme/ExampleOrg" });
    expect(seasonRegistrationOf(league, { registration: { ...defaultSeasonRegistration(league), payPal: "" } }).payPal).toBe("");
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { revision: store.league("tabbl")!.revision ?? 0, registrations: { venmo: "bad handle" } })).status).toBe(400);
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { revision: store.league("tabbl")!.revision ?? 0, registrations: { payPal: "", venmo: null } })).status).toBe(200);
    expect(store.league("tabbl")!.registrations).not.toHaveProperty("payPal");
    expect(store.league("tabbl")!.registrations).not.toHaveProperty("venmo");
  });

  it("wizard: Season 1's links round-trip to the draft (and the league defaults), stay hidden until Publish, then show", async () => {
    const { store, call } = leagueFixture();
    const created = await call("POST", "/api/leagues", OLGA, { name: "Rivertown BBL" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body as { id: string }).id;
    const patch = await call("PATCH", `/api/leagues/${id}/draft`, OLGA, {
      revision: store.league(id)!.revision ?? 0,
      season: { name: "Season 1", registration: { entryFee: "$5", payPal: "paypal.me/ExampleOrg", venmo: "@Example-Org" } },
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect((patch.body as { draft: { season: { registration: object } } }).draft.season.registration).toMatchObject({ payPal: "https://paypal.me/ExampleOrg", venmo: "Example-Org" });
    expect(store.league(id)!.registrations).toMatchObject({ payPal: "https://paypal.me/ExampleOrg", venmo: "Example-Org" });
    const bad = await call("PATCH", `/api/leagues/${id}/draft`, OLGA, { revision: store.league(id)!.revision ?? 0, season: { registration: { payPal: "http://paypal.me/x" } } });
    expect(bad.status).toBe(400);
    // Draft: the organiser sees the block; anyone else gets no league at all.
    const own = (await call("GET", `/api/leagues/${id}/seasons/season-1`, OLGA)).body as { season: SeasonRecord };
    expect(own.season.payment).toMatchObject({ entryFee: "$5", payPal: "https://paypal.me/ExampleOrg" });
    expect((await call("GET", `/api/leagues/${id}/seasons/season-1`, undefined)).status).toBe(404);
    expect((await call("GET", `/api/leagues/${id}/seasons/season-1`, BOB)).status).toBe(404);
    expect((await call("POST", `/api/leagues/${id}/publish`, OLGA, {})).status).toBe(200);
    const pub = (await call("GET", `/api/leagues/${id}/seasons/season-1`, undefined)).body as { season: SeasonRecord };
    expect(pub.season.payment).toEqual({ entryFee: "$5", payPal: "https://paypal.me/ExampleOrg", venmo: { handle: "Example-Org", url: "https://venmo.com/u/Example-Org" } });
  });

  it("season read: the block only when a link is set; a coach gets only their own teams' paid status, never anyone else's", async () => {
    const { call, setLinks, part, rev, seasonRead } = leagueFixture();
    expect((await seasonRead()).season).not.toHaveProperty("payment");
    await setLinks({ entryFee: "$10", payPal: "https://paypal.me/ExampleOrg" });
    expect((await call("PATCH", `${part()}/orcs`, JAY, { revision: rev(), paid: true })).status).toBe(200);
    expect((await call("PATCH", `${part()}/dwarfs`, JAY, { revision: rev(), paid: true })).status).toBe(200);
    const anon = (await seasonRead()).season;
    expect(anon.payment).toEqual({ entryFee: "$10", payPal: "https://paypal.me/ExampleOrg" });
    expect(JSON.stringify(anon)).not.toMatch(/"paid"|paidUpdated/);
    const bob = await call("GET", "/api/leagues/tabbl/seasons/season-6", BOB);
    expect(bob.headers?.["cache-control"]).toBe("private, no-store");
    const bobSeason = (bob.body as { season: SeasonRecord }).season;
    expect(bobSeason.payment?.mine).toEqual([{ teamId: "elves", team: "Elves", paid: false }, { teamId: "orcs", team: "Orcs", paid: true }]);
    expect(JSON.stringify(bobSeason)).not.toContain("dwarfs\",\"team\":\"Dwarfs\",\"paid");
    expect(bobSeason.participants.some((p) => "paid" in p || "paidUpdated" in p)).toBe(false);
    expect((await seasonRead(DEE)).season.payment?.mine).toEqual([{ teamId: "dwarfs", team: "Dwarfs", paid: true }]);
    // A coach with a team but no link: the status still shows when there is a fee.
    await setLinks({ payPal: "" });
    expect((await seasonRead(DEE)).season.payment).toEqual({ entryFee: "$10", mine: [{ teamId: "dwarfs", team: "Dwarfs", paid: true }] });
    expect((await seasonRead()).season).not.toHaveProperty("payment");
  });

  it("Participants Paid: organiser only (scoped role), who and when recorded, coach told; other-league organiser and global organiser refused", async () => {
    const { store, sent, call, part, rev } = leagueFixture();
    for (const who of [IVY, OLGA, BOB]) {
      expect((await call("GET", part(), who)).status, who.coach).toBe(403);
      expect((await call("PATCH", `${part()}/orcs`, who, { revision: rev(), paid: true })).status, who.coach).toBe(403);
      expect((await call("POST", part(), who, { revision: rev(), set: { paid: true } })).status, who.coach).toBe(403);
    }
    expect((await call("GET", part(), undefined)).status).toBe(401);
    expect((await call("PATCH", `${part("other")}/rats`, JAY, { revision: rev("other"), paid: true })).status).toBe(403);
    expect(store.season("other", "season-6")!.participants.some((p) => p.paid)).toBe(false);
    expect(store.season("tabbl", "season-6")!.participants.some((p) => p.paid)).toBe(false);
    expect(sent).toEqual([]);
    const ok = await call("PATCH", `${part()}/orcs`, JAY, { revision: rev(), paid: true });
    expect(ok.status).toBe(200);
    const row = (ok.body as { participants: Array<{ teamId: string; paidUpdated?: unknown }> }).participants.find((r) => r.teamId === "orcs")!;
    expect(row.paidUpdated).toEqual({ by: "Jay", at: NOW.toISOString() });
    expect(store.season("tabbl", "season-6")!.participants.find((p) => p.teamId === "orcs")).toMatchObject({ paid: true, paidUpdated: { by: "Jay" } });
    expect(sent).toEqual([{ coach: "Bob", input: expect.objectContaining({ type: "entrant-flag", body: "Orcs: Payment received." }) }]);
    // A different flag later does not move the Paid record.
    await call("PATCH", `${part()}/orcs`, JAY, { revision: rev(), checkedIn: true });
    expect(store.season("tabbl", "season-6")!.participants.find((p) => p.teamId === "orcs")!.paidUpdated?.at).toBe(NOW.toISOString());
  });

  it("no notification for a draft league (draft-aware notifier)", async () => {
    const { store, sent, call, part, rev } = leagueFixture();
    store.updateLeague("tabbl", (l) => { l.visibility = "draft"; });
    expect((await call("PATCH", `${part()}/orcs`, JAY, { revision: rev(), paid: true })).status).toBe(200);
    expect(sent).toEqual([]);
    expect(store.season("tabbl", "season-6")!.participants.find((p) => p.teamId === "orcs")!.paid).toBe(true);
  });
});

// ---- the overview block ----

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

describe("Pay entry fee block (server-rendered)", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [renderer, vueRouter, pay, tOverview, lOverview, app, detail] = await Promise.all([
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("/src/components/PayEntryFee.vue"), vite.ssrLoadModule("/src/components/TournamentOverview.vue"), vite.ssrLoadModule("/src/components/LeagueOverview.vue"),
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/session.ts"),
    ]);
    const tdetail = await vite.ssrLoadModule("/src/tournaments/detail.ts");
    mods = { vue: { createSSRApp }, renderer, vueRouter, Pay: pay.default, TOverview: tOverview.default, LOverview: lOverview.default, app, session: detail, tdetail };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(component: unknown, props: Record<string, unknown>): Promise<string> {
    const blank = { render: () => null };
    const router = mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory("/app/"), routes: [
      { path: "/leagues/:id", name: "league-detail", component: blank }, { path: "/:p(.*)*", component: blank },
    ] });
    await router.push("/x");
    await router.isReady();
    const app = mods.vue.createSSRApp(component, props);
    app.use(router);
    const api = (async () => { throw new Error("no api in this test"); }) as never;
    app.provide(mods.app.API_KEY, api);
    app.provide(mods.session.SESSION_KEY, mods.session.createSessionStore(api));
    const td = mods.tdetail.createTournamentDetail({ api });
    td.state.tournament = props.tournament ?? null;
    app.provide(mods.tdetail.TOURNAMENT_DETAIL_KEY, td);
    return ((await mods.renderer.renderToString(app)) as string).replace(/<!--[^>]*-->/g, "");
  }
  const LINKS = { payPal: "https://paypal.me/ExampleOrg", venmo: { handle: "Example-Org", url: "https://venmo.com/u/Example-Org" } };

  it("links open in a new tab with rel=noopener noreferrer, in-house text badges, the fee and the note", async () => {
    const html = await render(mods.Pay, { idPrefix: "x", entryFee: "15 GBP", links: LINKS, status: [{ label: "Orcs", paid: true }] });
    expect(html).toContain("Pay entry fee");
    expect(html).toContain("15 GBP");
    expect(html).toMatch(/<a[^>]*href="https:\/\/paypal\.me\/ExampleOrg"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    expect(html).toMatch(/<a[^>]*href="https:\/\/venmo\.com\/u\/Example-Org"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    expect(html).toMatch(/<svg[^>]*data-badge="paypal"[^]*>PayPal<\/text>/);
    expect(html).toMatch(/<svg[^>]*data-badge="venmo"[^]*>Venmo<\/text>/);
    expect(html).not.toMatch(/<img/);
    expect(html).toContain("Orcs: Payment: received");
    expect(html).toContain("Payment is made directly to the organiser. Super FUMBBL doesn&#39;t handle payments.");
  });

  it("nothing renders without a safe link, and an unsafe one never becomes an href", async () => {
    expect(await render(mods.Pay, { idPrefix: "x", entryFee: "15 GBP" })).not.toContain("Pay entry fee");
    const html = await render(mods.Pay, { idPrefix: "x", links: { payPal: "javascript:alert(1)", venmo: { handle: "Example-Org", url: "javascript:alert(1)" } } });
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://venmo.com/u/Example-Org"');
  });

  const tournament = (over: Record<string, unknown> = {}) => ({
    id: "t1", name: "Spike Open", status: "draft", format: "swiss", packageName: "nut-cup", maxPlayers: 8, roundCount: 5, currentRound: 0, entryFee: "15 GBP", ...over,
  });
  it("tournament overview: the block sits in the Details panel only when a link is set, and not once finished", async () => {
    const withLinks = await render(mods.TOverview, { tournament: tournament({ paymentLinks: LINKS }) });
    expect(withLinks).toMatch(/aria-labelledby="tn-facts-h"[^]*data-pay-block="true"/);
    expect(await render(mods.TOverview, { tournament: tournament() })).not.toContain("data-pay-block");
    expect(await render(mods.TOverview, { tournament: tournament({ paymentLinks: LINKS, status: "completed" }) })).not.toContain("data-pay-block");
  });

  it("league overview: the block sits in the season panel only when the server sent it", async () => {
    const league = { id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", organisers: ["Jay"], createdAt: "2026-10-30T00:00:00.000Z", seasonCount: 1 };
    const season = { ...seasonOf("tabbl", []), payment: { entryFee: "$10", ...LINKS, mine: [{ teamId: "orcs", team: "Orcs", paid: false }] } };
    const summary = { id: "season-6", name: "Season 6", number: 6, ruleset: "BB2025", status: "active", teamCount: 0, fixtureCount: 0, playedCount: 0 };
    const html = await render(mods.LOverview, { league, season, summary, crests: {} });
    expect(html).toMatch(/aria-labelledby="lg-summary-h"[^]*data-pay-block="true"[^]*Orcs: Payment: not yet marked/);
    const { payment: _p, ...plain } = season;
    expect(await render(mods.LOverview, { league, season: plain, summary, crests: {} })).not.toContain("data-pay-block");
  });
});
