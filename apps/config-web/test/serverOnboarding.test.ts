import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { PRIVACY_VERSION } from "../src/auth/contactSchema.js";
import { TournamentStore } from "../src/tournaments/store.js";
import { seedLeague } from "./onboardedFixture.js";

// New-user flow over HTTP: GET/POST /api/me/onboarding, GET/PATCH /api/me/contact, and the 428 gate on /api/me writes
// while onboarding is needed (reads, sign-out and public routes untouched). Sidecar mode, cookie and Bearer sessions.

const root = mkdtempSync(join(tmpdir(), "server-onboarding-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
type Stored = { profile: Record<string, string>; contact?: Record<string, unknown>; consent?: Record<string, unknown> };
const identities = () => JSON.parse(readFileSync(join(root, "identities.json"), "utf8")) as { coaches: Record<string, Stored> };
const record = (ffbCoachId: string, extra: Record<string, unknown> = {}) => ({
  ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "", updatedBy: "", ...extra,
});

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_TEAMS_DIR: join(root, "teams"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    TABLETOP_DIR: join(root, "tabletop"),
    VALIDATED_CSV: join(root, "validated-rosters.csv"),
    FORK_STATE_DIR: join(root, "state"),
    BUILD_LOG_FILE: join(root, "build-log.json"),
    FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "packages", "tournaments", "log"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    newbie: record("Newbie", { identities: { discordUserId: "101", discordUsername: "newbie_dc", email: "newbie@example.test" } }),
    stale: record("Stale", { consent: { privacy: { acceptedVersion: "2025-01-01", at: "2025-01-01T00:00:00.000Z" } } }),
    limited: record("Limited"),
    victim: record("Victim", {
      identities: { discordUserId: "909909909909909909", discordAvatarHash: "victimhash", discordUsername: "victim_dc", email: "victim-discord@example.test", nafName: "Victim NAF", nafId: "4242" },
      profile: { preferredName: "Secret Pref" },
      contact: { email: "victim@example.test", emailSource: "user", emailVerified: false, phones: [{ number: "+15550001111" }] },
      consent: { leagueContact: { granted: true, at: "2026-10-31T00:00:00.000Z", version: "2026-10-31" }, privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" }, leagues: { lg: { at: "2026-10-31T00:00:00.000Z", version: "2026-10-31" } } },
    }),
    org: record("Org", { level: "organizer", consent: { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" } } }),
    quiet: record("Quiet", {
      note: "quiet-admin-note", identities: { discordUserId: "777000", discordUsername: "quiet_dc", email: "quiet-discord@example.test" },
      scheduling: { timezone: "Pacific/Auckland", availability: [{ day: "tue", start: "19:15", end: "21:45" }] },
      profile: { preferredName: "Quiet Pref", displayName: "Quiet Display" }, contact: { email: "quiet@example.test", emailSource: "user", emailVerified: false, phones: [{ number: "+15550002222" }] }, consent: { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" } } }),
    outsider: record("Outsider", { contact: { email: "outsider@example.test", emailSource: "user", emailVerified: false, phones: [] }, consent: { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" } } }),
    org2: record("Org2", { level: "organizer", consent: { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" } } }),
    torg: record("TOrg", { level: "organizer", consent: { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" } } }),
    boss: record("Boss", { level: "admin", consent: { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" } } }),
  } }), "utf8");
  // Leagues: lg (organised by Org) has Victim (acknowledged) and Quiet (not); other (Org2) has Victim too, unacknowledged.
  seedLeague(join(root, "state"), { id: "lg", name: "Test League", organisers: ["Org"], members: ["Victim", "Quiet"] });
  seedLeague(join(root, "state"), { id: "other", name: "Other League", organisers: ["Org2"], members: ["Victim"] });
  // A tournament organised by TOrg with Victim entered, and Quiet entered then withdrawn (the NAF route is open to a tournament organiser for active entrants only).
  const tournaments = new TournamentStore(join(root, "tournaments"));
  const t = tournaments.createTournament({ name: "Cup", packageName: "p", maxPlayers: 8, format: "swiss", organizerCoachId: "TOrg" });
  tournaments.registerEntrant(t.id, { coachId: "Victim", ffbCoachId: "Victim", discordUserId: "909909909909909909", verifiedAt: "2026-10-31T00:00:00.000Z" }, "team-v");
  writeFileSync(join(root, "validated-rosters.csv"), "discordUserId,coachName,teamName,rosterRace,packageName,messageLink,validatedAt\n909909909909909909,Victim,Victim Orcs,Orc,p,,2026-10-31\n", "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "coaches.json"), "[]", "utf8");
  writeFileSync(join(root, "build-log.json"), "[]", "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000); // the first server import compiles the whole app

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const cookie = (coach: string) => `cw_session=${createSession(coach, Date.now(), "discord").token}`;
const call = (coach: string | undefined, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${origin}${path}`, {
    method,
    headers: { ...(coach ? { cookie: cookie(coach) } : {}), ...(method !== "GET" ? { "x-cw-auth": "1", "content-type": "application/json" } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const okBody = { preferredName: "New Bie", email: "newbie@example.test", phones: [{ number: "+1 555 123 4567", label: "mobile" }], leagueContact: false, privacyAccepted: true, privacyVersion: PRIVACY_VERSION };

describe("GET /api/me/onboarding", () => {
  it("401 signed out; needed + prefill for a new coach; needed again for an older accepted version", async () => {
    expect((await call(undefined, "GET", "/api/me/onboarding")).status).toBe(401);
    const res = await call("Newbie", "GET", "/api/me/onboarding");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toMatchObject({ needed: true, prefill: { preferredName: "newbie_dc", email: "newbie@example.test", emailSource: "discord" }, privacyVersion: PRIVACY_VERSION });
    expect(await (await call("Stale", "GET", "/api/me/onboarding")).json()).toMatchObject({ needed: true });
    // A coach with no record at all (first sign-in mid-provisioning) is needed too.
    expect(await (await call("NoRecord", "GET", "/api/me/onboarding")).json()).toMatchObject({ needed: true, prefill: { preferredName: "NoRecord", email: null } });
  });
});

describe("428 gate while onboarding is needed", () => {
  it("/api/me writes answer 428; /api/me reads, sign-out and public routes are unaffected", async () => {
    const gated = await call("Newbie", "PATCH", "/api/me/profile", { displayName: "Blocked" });
    expect(gated.status).toBe(428);
    expect(await gated.json()).toMatchObject({ error: "Complete your profile first.", onboarding: true });
    expect((await call("Newbie", "PUT", "/api/me/scheduling", { timezone: "UTC" })).status).toBe(428);
    expect((await call("Newbie", "PATCH", "/api/me/contact", { preferredName: "X" })).status).toBe(428);
    expect((await call("Newbie", "DELETE", "/api/me/avatar")).status).toBe(428);
    expect((await call("Newbie", "PATCH", "/api/account", { profile: { displayName: "Blocked" } })).status).toBe(428);
    // Bearer sessions (the desktop client) are gated the same way.
    const { token } = createSession("Newbie", Date.now(), "discord");
    expect((await fetch(`${origin}/api/me/profile`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })).status).toBe(428);
    expect((await call("Newbie", "GET", "/api/me/profile")).status).toBe(200);
    expect((await call("Newbie", "GET", "/api/me/contact")).status).toBe(200);
    expect((await call("Newbie", "GET", "/api/account")).status).toBe(200);
    expect((await call(undefined, "GET", "/api/build-log")).status).toBe(200);
    expect(identities().coaches.newbie!.profile.displayName).toBeUndefined();
  });
});

describe("POST /api/me/onboarding", () => {
  it("needs X-CW-Auth on a cookie write; refuses a missing privacy acceptance, a bad phone, a long name, a bad email", async () => {
    expect((await fetch(`${origin}/api/me/onboarding`, { method: "POST", headers: { cookie: cookie("Newbie"), "content-type": "application/json" }, body: JSON.stringify(okBody) })).status).toBe(403);
    expect((await call(undefined, "POST", "/api/me/onboarding", okBody)).status).toBe(401);
    for (const bad of [
      { ...okBody, privacyAccepted: false },
      { ...okBody, phones: [{ number: "555-1234" }] },
      { ...okBody, preferredName: "x".repeat(41) },
      { ...okBody, email: "nope@" },
    ]) {
      const res = await call("Newbie", "POST", "/api/me/onboarding", bad);
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBeTruthy();
    }
    expect(identities().coaches.newbie!.consent).toBeUndefined();
  });

  it("saves every field, lifts the gate, and the Account section reads and edits them", async () => {
    const res = await call("Newbie", "POST", "/api/me/onboarding", okBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ needed: false, prefill: { preferredName: "New Bie" } });
    const stored = identities().coaches.newbie!;
    expect(stored.profile.preferredName).toBe("New Bie");
    expect(stored.contact).toEqual({ email: "newbie@example.test", emailSource: "discord", emailVerified: true, phones: [{ number: "+15551234567", label: "mobile" }] });
    expect(stored.consent).toMatchObject({ privacy: { acceptedVersion: PRIVACY_VERSION }, leagueContact: { granted: false } });
    expect((await call("Newbie", "PATCH", "/api/me/profile", { displayName: "Now Fine" })).status).toBe(200);

    const patched = await call("Newbie", "PATCH", "/api/me/contact", { email: "elsewhere@example.test", leagueContact: true });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ email: "elsewhere@example.test", emailSource: "user", emailVerified: false, leagueContact: { granted: true }, privacy: { acceptedVersion: PRIVACY_VERSION } });
    expect((await call("Newbie", "PATCH", "/api/me/contact", { phones: [{ number: "abc" }] })).status).toBe(400);
    expect((await call("Newbie", "PATCH", "/api/me/contact", { privacyAccepted: false })).status).toBe(400);
  });

  it("an older accepted version: the coach accepts the new notice through the same POST", async () => {
    expect((await call("Stale", "PATCH", "/api/me/profile", { displayName: "Blocked" })).status).toBe(428);
    expect((await call("Stale", "POST", "/api/me/onboarding", { ...okBody, email: null, phones: [] })).status).toBe(200);
    expect((await call("Stale", "PATCH", "/api/me/profile", { displayName: "Stale Ok" })).status).toBe(200);
  });

  it("is rate-limited to 10 writes a minute per coach (429 with retry-after)", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) last = await call("Limited", "POST", "/api/me/onboarding", { ...okBody, privacyAccepted: false });
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("all writes are gated while onboarding is needed", () => {
  it("builder save, team avatar, tournament entry, league action and a lobby write answer 428; the allow-list and anonymous calls do not", async () => {
    for (const [method, path] of [
      ["POST", "/api/fork/team-builder/saves"], ["PUT", "/api/fork/teams/abc/avatar"], ["POST", "/api/tournaments/t1/entrants"],
      ["POST", "/api/leagues/lg/news"], ["POST", "/api/lobby"], ["POST", "/api/tabletop/matches"], ["POST", "/api/bug-reports"],
    ]) {
      const res = await call("Gated", method!, path!, {});
      expect(res.status, `${method} ${path}`).toBe(428);
    }
    // Allow-list: logout, the onboarding POST (400 here: invalid body, but not 428), name checks; anonymous lobby write.
    expect((await call("Gated", "POST", "/api/auth/logout", {})).status).not.toBe(428);
    expect((await call("Gated", "POST", "/api/me/onboarding", {})).status).toBe(400);
    expect((await call("Gated", "POST", "/api/team/checkName", { name: "x" })).status).not.toBe(428);
    expect((await call(undefined, "POST", "/api/lobby", {})).status).not.toBe(428);
  });

  it("legacy GET routes that change state are gated too; onboarded coaches and anonymous sign-ups keep working", async () => {
    // Session-authenticated.
    expect((await call("Gated", "GET", "/api/fork/register?coach=Gated")).status).toBe(428);
    expect((await call("Gated", "GET", "/api/fork/challenge?coach=Gated&teamId=t&opponent=Org")).status).toBe(428);
    expect((await call("Gated", "GET", "/api/fork/matchstatus?coach=Gated")).status).toBe(428);
    // Digest-authenticated legacy calls act for the `coach` parameter.
    expect((await call(undefined, "GET", "/api/fork/challenge?coach=Gated&teamId=t&opponent=Org&passwordMd5=" + "a".repeat(32))).status).toBe(428);
    expect((await call(undefined, "GET", "/api/fork/matchstatus?coach=Gated&passwordMd5=" + "a".repeat(32))).status).toBe(428);
    // Mismatch: an onboarded coach is signed in but the digest call acts for the gated coach -> gated; the reverse is not.
    expect((await call("Org", "GET", "/api/fork/challenge?coach=Gated&teamId=t&opponent=Boss&passwordMd5=" + "a".repeat(32))).status).toBe(428);
    expect((await call("Org", "GET", "/api/fork/matchstatus?coach=Gated&passwordMd5=" + "a".repeat(32))).status).toBe(428);
    expect((await call("Gated", "GET", "/api/fork/matchstatus?coach=Org&passwordMd5=" + "a".repeat(32))).status).not.toBe(428);
    // An anonymous poll without a credential changes nothing and is not gated.
    expect((await call(undefined, "GET", "/api/fork/matchstatus?coach=Gated")).status).not.toBe(428);
    // Withdrawing a challenge and plain reads stay open; an onboarded coach is never gated; an anonymous sign-up is not gated.
    expect((await call("Gated", "GET", "/api/fork/cancel?coach=Gated")).status).not.toBe(428);
    expect((await call("Gated", "GET", "/api/fork/library?coach=Gated")).status).not.toBe(428);
    expect((await call("Org", "GET", "/api/fork/challenge?coach=Org&teamId=t&opponent=Boss")).status).not.toBe(428);
    expect((await call("Org", "GET", "/api/fork/matchstatus?coach=Org")).status).toBe(200);
    expect((await call(undefined, "GET", "/api/fork/register?coach=BrandNew")).status).not.toBe(428);
  });
});

describe("organiser identity access (owner ruling 10-31: a tournament organiser records NAF details for their active entrants; league organisers have no power)", () => {
  const personal = ["victim@example.test", "victim-discord@example.test", "+15550001111", "Secret Pref"];
  const leaks = (text: string, values = personal) => [...values, "leagueContact", "\"contact\"", "\"consent\""].filter((t) => text.includes(t));
  const naf = (as: string, target: string) => call(as, "POST", "/api/admin/identities/naf", { ffbCoachId: target, nafName: `${target} NAF`, nafId: "4242" });

  it("a tournament organiser sets an active entrant's NAF details and gets the NAF allow-list only", async () => {
    const res = await call("TOrg", "POST", "/api/admin/identities/naf", { ffbCoachId: "Victim", nafName: "Victim NAF 2", nafId: "5151" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).coach).toEqual({ ffbCoachId: "Victim", identities: { nafName: "Victim NAF 2", nafId: "5151" } });
    for (const leaked of [...personal, "909909909909909909", "victim_dc", "\"consent\"", "\"contact\"", "\"profile\"", "\"level\"", "\"note\"", "preferredName"]) expect(text, leaked).not.toContain(leaked);
    expect(identities().coaches.victim).toMatchObject({ identities: { nafName: "Victim NAF 2", nafId: "5151" }, updatedBy: "TOrg" });
  });

  it("a tournament organiser cannot touch a coach who is not entered or has withdrawn: 403 and nothing is written", async () => {
    for (const target of ["Outsider", "Quiet"]) {
      const before = JSON.stringify(identities().coaches[target.toLowerCase()]);
      const refused = await naf("TOrg", target);
      expect(refused.status, target).toBe(403);
      expect(await refused.json()).toEqual({ error: "That coach is not entered in a tournament you organise." });
      expect(JSON.stringify(identities().coaches[target.toLowerCase()]), target).toBe(before);
    }
  });

  it("a league organiser gets 403 for their own league's members, acknowledged or not, and nothing is written", async () => {
    for (const target of ["Victim", "Quiet"]) {
      const before = JSON.stringify(identities().coaches[target.toLowerCase()]);
      const res = await naf("Org", target);
      expect(res.status, target).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "That coach is not entered in a tournament you organise." });
      expect(leaks(text)).toEqual([]);
      expect(JSON.stringify(identities().coaches[target.toLowerCase()]), target).toBe(before);
    }
    expect((await naf("Org2", "Victim")).status).toBe(403);
  });

  it("a site admin is unchanged: the full record of anyone", async () => {
    const admin = await naf("Boss", "Outsider");
    expect(admin.status).toBe(200);
    expect((await admin.json()).coach).toMatchObject({ contact: { email: "outsider@example.test" } });
  });

  it("the admin identities list, edit and merge stay site-admin only (403 for any organiser)", async () => {
    expect((await call("Org", "GET", "/api/admin/identities")).status).toBe(403);
    expect((await call("Org", "POST", "/api/admin/identities", { ffbCoachId: "Victim", note: "x" })).status).toBe(403);
    expect((await call("Org", "POST", "/api/admin/identities/merge", { sourceFfbCoachId: "Victim", targetFfbCoachId: "Org" })).status).toBe(403);
  });

  it("the organiser's own account, profile, contact and onboarding views carry only their own record", async () => {
    for (const path of ["/api/account", "/api/me/profile", "/api/me/contact", "/api/me/onboarding", "/api/me/leagues/sharing"]) {
      const res = await call("Org", "GET", path);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      expect(personal.filter((t) => text.includes(t)), path).toEqual([]);
    }
  });
});

describe("GET/POST /api/me/leagues/sharing", () => {
  it("lists the coach's leagues with the notice; sharing needs the checkbox; stop sharing is recorded", async () => {
    const view = await (await call("Quiet", "GET", "/api/me/leagues/sharing")).json();
    expect(view.leagues).toEqual([expect.objectContaining({ id: "lg", name: "Test League", status: "pending", onRoster: true })]);
    expect(view.leagues[0].text).toBe("You are joining Test League. Its organisers can see your coach name and your teams. Choose below what else they can see.");
    expect((await call("Quiet", "POST", "/api/me/leagues/sharing", { leagueId: "lg", share: true })).status).toBe(400);
    const shared = await call("Quiet", "POST", "/api/me/leagues/sharing", { leagueId: "lg", share: true, acknowledged: true });
    expect(shared.status).toBe(200);
    expect((await shared.json()).leagues[0]).toMatchObject({ status: "shared" });
    const stopped = await call("Quiet", "POST", "/api/me/leagues/sharing", { leagueId: "lg", share: false });
    expect((await stopped.json()).leagues[0]).toMatchObject({ status: "declined" });
    // The league organiser has no identity route either way (the acknowledgement now gates the league mailer only).
    expect((await call("Org", "POST", "/api/admin/identities/naf", { ffbCoachId: "Quiet", nafName: "Quiet NAF", nafId: "4242" })).status).toBe(403);
    // Cookie writes need X-CW-Auth; a not-onboarded coach is gated.
    expect((await fetch(`${origin}/api/me/leagues/sharing`, { method: "POST", headers: { cookie: cookie("Quiet"), "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await call("Gated", "POST", "/api/me/leagues/sharing", { leagueId: "lg", share: false })).status).toBe(428);
  });
});

describe("per-organiser sharing over HTTP (spec 2026-10-31)", () => {
  it("PUT /api/me/sharing/<scope>: CSRF header, onboarding gate, membership; organisers read only what was granted", async () => {
    const lgContact = (as: string, coach = "Victim") => call(as, "GET", `/api/leagues/lg/members/${coach}/contact`);
    // Nothing granted yet: the organiser sees the coach name only.
    const before = await lgContact("Org");
    expect(before.status).toBe(200);
    expect(before.headers.get("cache-control")).toContain("no-store");
    expect(await before.json()).toEqual({ contact: { coach: "Victim" } });
    expect((await lgContact("Org2")).status).toBe(403); // organises another league
    expect((await lgContact("Quiet")).status).toBe(403); // a plain coach
    expect((await call(undefined, "GET", "/api/leagues/lg/members/Victim/contact")).status).toBe(401);
    expect((await lgContact("Org", "Quiet")).status).toBe(404); // on the roster, never joined
    // The coach shares email with lg only.
    const put = (coach: string, scope: string, body: unknown, extra: Record<string, string> = {}) =>
      call(coach, "PUT", `/api/me/sharing/${encodeURIComponent(scope)}`, body, extra);
    expect((await fetch(`${origin}/api/me/sharing/league%3Alg`, { method: "PUT", headers: { cookie: cookie("Victim"), "content-type": "application/json" }, body: JSON.stringify({ fields: ["email"] }) })).status).toBe(403);
    expect((await put("Gated", "league:lg", { fields: [] })).status).toBe(428);
    expect((await put("Victim", "league:other", { fields: ["email"] })).status).toBe(403); // not acknowledged there
    const saved = await put("Victim", "league:lg", { fields: ["email"] });
    expect(saved.status).toBe(200);
    const view = await saved.json();
    expect(view.scopes.find((r: { scope: string }) => r.scope === "league:lg")).toMatchObject({ fields: ["email"] });
    expect(await (await lgContact("Org")).json()).toEqual({ contact: { coach: "Victim", email: "victim@example.test" } });
    const leaked = await (await lgContact("Org")).text();
    for (const secret of ["+15550001111", "909909909909909909", "victim_dc", "Secret Pref"]) expect(leaked).not.toContain(secret);
    // The tournament organiser sees nothing beyond the name: that grant is per scope.
    const t = new TournamentStore(join(root, "tournaments")).tournaments(["draft"])[0]!;
    const detail = await (await call("TOrg", "GET", `/api/tournaments/${t.id}`)).json();
    const victim = detail.entrants.find((e: { coachId: string }) => e.coachId === "Victim");
    expect(victim.shared).toEqual({ coach: "Victim" });
    const tc = await call("TOrg", "GET", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(victim.id)}/contact`);
    expect(await tc.json()).toEqual({ contact: { coach: "Victim" } });
    expect((await call("Org", "GET", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(victim.id)}/contact`)).status).toBe(403);
    // A coach with no seat on the league cannot answer for it (no write, no notice).
    expect((await call("Outsider", "POST", "/api/me/leagues/sharing", { leagueId: "lg", share: false })).status).toBe(403);
    // Back to nothing shared, so the route sweep below sees the default.
    expect((await put("Victim", "league:lg", { fields: [] })).status).toBe(200);
    expect(await (await lgContact("Org")).json()).toEqual({ contact: { coach: "Victim" } });
  });
});

describe("no HTTP route returns another coach's contact email or phones to anyone but a site admin", () => {
  it("every literal /api GET route in server.ts, as a league organiser and as a plain coach", async () => {
    const source = readFileSync(join(import.meta.dirname, "..", "src", "server.ts"), "utf8");
    const paths = [...new Set([...source.matchAll(/path === "(\/api\/[^"]+)"/g)].map((m) => m[1]!))]
      .filter((p) => !p.startsWith("/api/auth/discord/")); // the Discord sign-in redirects off-site
    expect(paths.length).toBeGreaterThan(40);
    // Another coach's email, phones, Discord id or Discord avatar never reach an organiser, a plain coach or anonymous.
    const secrets = ["victim@example.test", "+15550001111", "909909909909909909", "cdn.discordapp.com", "victimhash"];
    for (const as of ["Org", "Quiet", undefined]) {
      for (const path of paths) {
        const res = await fetch(`${origin}${path}`, { headers: as ? { cookie: cookie(as) } : {}, redirect: "manual" });
        const text = await res.text();
        expect(secrets.filter((t) => text.includes(t)), `${as ?? "anonymous"} GET ${path}`).toEqual([]);
      }
    }
    // The organiser write that returns an identity: never the address either; the site admin does see it.
    const org = await (await call("TOrg", "POST", "/api/admin/identities/naf", { ffbCoachId: "Victim", nafName: "Victim NAF", nafId: "4242" })).text();
    expect(secrets.filter((t) => org.includes(t))).toEqual([]);
    const admin = await (await call("Boss", "POST", "/api/admin/identities/naf", { ffbCoachId: "Victim", nafName: "Victim NAF", nafId: "4242" })).text();
    expect(admin).toContain("victim@example.test");
    // Validated rosters: public columns for non-admins, every column for a site admin.
    const rosters = await (await call("Quiet", "GET", "/api/coaches")).json();
    expect(rosters).toEqual([{ coachName: "Victim", teamName: "Victim Orcs", rosterRace: "Orc", packageName: "p", messageLink: "", validatedAt: "2026-10-31" }]);
    expect(await (await call("Boss", "GET", "/api/coaches")).text()).toContain("909909909909909909");
    // The fork admin routes refuse a plain coach (requireAdminGate needs an organiser or site admin).
    // (/api/fork/games is answered first by the signed-in active-games list, forkGames.ts: game names and coach names only.)
    for (const path of ["/api/fork/users", "/api/fork/matchmaking-settings", "/api/fork/user/Victim/games"])
      expect((await call("Quiet", "GET", path)).status, path).toBe(403);
    expect((await call("Org", "GET", "/api/fork/legacy-password-auth")).status).toBe(403);
    expect((await call("Boss", "GET", "/api/fork/legacy-password-auth")).status).toBe(200);
  }, 60_000);
});

describe("nothing public carries contact details", () => {
  it("the public coach card and recent results never include an email or phone", async () => {
    for (const path of ["/api/recent-results", "/api/build-log"]) {
      const text = await (await call(undefined, "GET", path)).text();
      expect(text).not.toContain("example.test");
      expect(text).not.toContain("+1555");
    }
  });
});
