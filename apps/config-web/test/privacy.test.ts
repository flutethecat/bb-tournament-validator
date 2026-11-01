import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnonymiser } from "../src/privacy/anonymise.js";
import {
  buildPlan, collectExport, deleteContext, DELETE_STEPS, INVENTORY_ROWS, KNOWN_STORES, splitPlan, STORE_COLLECTORS,
} from "../src/privacy/collectors.js";
import { INVENTORY } from "../spa/src/privacy/inventory";
import { JOB_RETRY_DAYS, PrivacyService } from "../src/privacy/service.js";
import {
  appendAudit, appendJournal, blocklistHash, deletedPseudonymFor, isDiscordBlocked, listJobs, readAudit, readJournal, sealForJob,
} from "../src/privacy/state.js";
import {
  clearFences, coachKey, DeletionFenceError, fenceCoachHash, coachKeyHash, isReservedCoachName, ReservedNameError,
} from "../src/privacy/fence.js";
import { createSession, getSession } from "../src/auth/session.js";
import { normalizeFfbCoachId, readIdentities, upsertIdentity } from "../src/auth/identitiesStore.js";
import { updateOwnProfile } from "../src/accountProfile.js";
import { deleteSave } from "../src/teamBuilderSaves.js";
import { avatarStoreFor } from "../src/teamAvatars.js";
import { coachAvatarKey } from "../src/coachAvatars.js";
import { setResultCoachFilter, TournamentResultStore } from "../src/tournamentResults.js";
import { discordAvatarUrl, PendingSsoStore } from "../src/auth/discordSso.js";
import {
  ALICE_DISCORD, ALICE_EMAIL, BOB_DISCORD, BOB_EMAIL, depsFor, filesContaining, JOSE_NFC, JOSE_NFD, png, seed, SHARE, walkFiles,
} from "./privacyFixture.js";

// Privacy spec 2026-10-31 §2 (export) and §3 (delete, anonymise don't erase), and the Sol 6.1 review fixes: explicit
// per-store coach fields (no key renames), ownership by identity key only, exact identity-store matching, reserved
// pseudonym names, the deletion fence, the deleted-coach map, cache events, league display aliases, honours / log text,
// waiting-room leases, strict unlink, the sealed journal with its retry cap, and audit-before-complete.

const roots: string[] = [];
const prevIdentities = process.env.IDENTITIES_FILE;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "privacy-"));
  roots.push(root);
  process.env.IDENTITIES_FILE = join(root, "identities.json");
  clearFences();
});
afterEach(() => {
  if (prevIdentities === undefined) delete process.env.IDENTITIES_FILE; else process.env.IDENTITIES_FILE = prevIdentities;
  setResultCoachFilter(undefined);
  clearFences();
});
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const readJ = <T = any>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const P = "Deleted coach #1";

describe("collector registry", () => {
  it("every known store has a collector with an export decision and a delete decision", () => {
    const ids = STORE_COLLECTORS.map((s) => s.id);
    for (const known of KNOWN_STORES) {
      const c = STORE_COLLECTORS.find((s) => s.id === known);
      expect(c, `store ${known} has no collector`).toBeDefined();
      expect(typeof c!.export === "function" || typeof (c!.export as { none?: string }).none === "string").toBe(true);
      expect(Array.isArray(c!.erase) || typeof (c!.erase as { none?: string }).none === "string").toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...KNOWN_STORES].sort());
  });
  it("every delete step a collector names exists, and every step is claimed by a store", () => {
    const steps = new Set(DELETE_STEPS.map((s) => s.id));
    const claimed = new Set(STORE_COLLECTORS.flatMap((c) => (Array.isArray(c.erase) ? c.erase : [])));
    for (const s of claimed) expect(steps.has(s), s).toBe(true);
    for (const s of steps) expect(claimed.has(s), s).toBe(true);
  });
  it("matching uses exactly the identity store's key function", () => {
    for (const s of [" Alice ", "ÀLICE", JOSE_NFC, JOSE_NFD, "İstanbul"]) expect(coachKey(s)).toBe(normalizeFfbCoachId(s));
    expect(coachKey(JOSE_NFC)).not.toBe(coachKey(JOSE_NFD));
  });
});

describe("privacy notice inventory vs the registry", () => {
  it("every inventory row has a collector (export files or an explicit not-exported reason, and a delete decision)", () => {
    for (const row of INVENTORY) {
      const stores = Object.entries(INVENTORY_ROWS).filter(([, rows]) => rows.includes(row.id)).map(([id]) => id);
      expect(stores.length, `inventory row ${row.id} has no collector`).toBeGreaterThan(0);
      for (const id of stores) {
        const c = STORE_COLLECTORS.find((x) => x.id === id)!;
        expect(typeof c.export === "function" || Boolean((c.export as { none?: string }).none), `${id} export`).toBe(true);
        expect(Array.isArray(c.erase) || Boolean((c.erase as { none?: string }).none), `${id} erase`).toBe(true);
      }
    }
  });
  it("every registry mapping names a real inventory row, and every known store is mapped", () => {
    const ids = new Set(INVENTORY.map((r) => r.id));
    for (const [store, rows] of Object.entries(INVENTORY_ROWS)) for (const r of rows) expect(ids.has(r), `${store} -> ${r}`).toBe(true);
    expect(Object.keys(INVENTORY_ROWS).sort()).toEqual([...KNOWN_STORES].sort());
  });
});

describe("anonymiser", () => {
  const an = createAnonymiser(["Alice", "Alice Smith"], "Deleted coach #7");
  it("replaces only the named fields, lower-case for folded values, drops re-identifying siblings, never renames keys by itself", () => {
    const o: Record<string, unknown> = { coach: "alice", coachId: "Alice", nafUser: "x", discordUserId: "1", teamName: "Alice", map: { Alice: 1 } };
    expect(an.fields(o, ["coach", "coachId"])).toBe(true);
    expect(o).toEqual({ coach: "deleted coach #7", coachId: "Deleted coach #7", teamName: "Alice", map: { Alice: 1 } });
    expect(an.fields({ coach: "Bob" }, ["coach"])).toBe(false);
  });
  it("text replacement respects word boundaries and prefers the longer name", () => {
    expect(an.text("Alice Smith met Alicent and alice.")).toBe("Deleted coach #7 met Alicent and Deleted coach #7.");
  });
  it("matches with the identity store's key only: a different Unicode form is a different coach", () => {
    const j = createAnonymiser([JOSE_NFC], "D");
    expect(j.matches(JOSE_NFC.toUpperCase())).toBe(true);
    expect(j.matches(JOSE_NFD)).toBe(false);
  });
});

describe("reserved pseudonym names (P1-5)", () => {
  it("anything reading as 'Deleted coach' is reserved, whatever the case, spacing or Unicode form", () => {
    for (const n of ["Deleted coach #1", "deleted coach", "DELETED  COACH #9", "Deleted​coach", "Ｄｅｌｅｔｅｄ Coach", "deleted-coach", " Deleted_Coach#3"]) expect(isReservedCoachName(n), n).toBe(true);
    for (const n of ["Alice", "Deletion Coach", "Coach Deleted"]) expect(isReservedCoachName(n), n).toBe(false);
  });
  it("no session and no identity record for a reserved name", async () => {
    await seed(root);
    expect(() => createSession("Deleted Coach #1", Date.now(), "discord")).toThrow(ReservedNameError);
    expect(() => upsertIdentity({ ffbCoachId: "deleted coach #2", level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "", updatedBy: "" })).toThrow(ReservedNameError);
  });
});

describe("export", () => {
  it("collects every store's files for the coach and nothing of another coach", async () => {
    await seed(root);
    const deps = depsFor(root);
    createSession("Alice", Date.now(), "discord");
    const files = new Map((await collectExport(deps, "alice")).map((f) => [f.name, f.content]));
    expect([...files.keys()].sort()).toEqual([
      "README.txt", "account.json", "avatar.png", "bug-reports-index.json", "builder-saves.json", "league-teams.json", "notifications.json",
      "results.json", "tabletop-matches.json", "team-library.json", "team-logos/library_t1.png", "team-logos/save_s1.png", "tournament-entries.json",
    ]);
    const text = (n: string) => String(files.get(n));
    const account = JSON.parse(text("account.json"));
    expect(account.identities.email).toBe(ALICE_EMAIL);
    expect(account.contact.phones).toEqual(["+00 0000 0001"]); // onboarding fields ride along (whole record)
    expect(account.consent.privacy.acceptedVersion).toBe("1");
    expect(account.legacyOrganiser).toBe(true);
    expect(account.sessions.length).toBeGreaterThan(0);
    expect(JSON.stringify(account.sessions)).not.toMatch(/[a-f0-9]{64}/);
    expect(JSON.parse(text("builder-saves.json"))).toEqual([{ id: "s1", name: "Green Orcs", sharedAt: "2026-10-01T00:00:00Z", body: {}, shared: true }]);
    expect(JSON.parse(text("team-library.json")).map((t: { teamId: string }) => t.teamId)).toEqual(["t1"]);
    const t = JSON.parse(text("tournament-entries.json"));
    expect(t.entries.map((e: { id: string }) => e.id)).toEqual(["e1"]);
    expect(t.matches).toHaveLength(1);
    expect(t.managed.map((m: { id: string; role: string }) => `${m.id}:${m.role}`).sort()).toEqual(["t1:organiser", "t2:owner"]);
    const leagues = JSON.parse(text("league-teams.json"));
    expect(leagues[0].role).toBe("organiser");
    expect(leagues[0].seasons[0].teams.map((x: { id: string }) => x.id)).toEqual(["green-orcs"]);
    expect(JSON.parse(text("tabletop-matches.json")).matches[0].events).toHaveLength(2);
    const results = JSON.parse(text("results.json"));
    expect(results.results.map((r: { gameId: string }) => r.gameId)).toEqual(["g1"]);
    expect(results.title.title).toBe("Star");
    expect(results.nafRecord.nafId).toBe("1001");
    expect(JSON.parse(text("notifications.json"))[0].title).toBe("From Bob");
    expect(JSON.parse(text("bug-reports-index.json")).map((r: { description: string }) => r.description)).toEqual(["Crash"]);
    expect(text("README.txt")).toMatch(/account\.json/);
    const all = [...files.values()].map((c) => (typeof c === "string" ? c : c.toString("latin1"))).join("\n");
    for (const s of [BOB_EMAIL, BOB_DISCORD, SHARE, "webhooks", "Bob crash", "Grey Dwarfs"]) expect(all).not.toContain(s);
  });

  it("an unverified NAF name never selects files: Alice calling herself 'Dave' does not get Dave's saves (P1-2)", async () => {
    await seed(root, { aliceNafName: "Dave", aliceDisplayName: "Dave" });
    const files = new Map((await collectExport(depsFor(root), "Alice")).map((f) => [f.name, String(f.content)]));
    expect(files.get("builder-saves.json")).not.toContain("Grey Dwarfs");
    const svc = new PrivacyService(depsFor(root));
    await svc.deleteCoach("Alice", "Alice", "self");
    expect(walkFiles(depsFor(root).builderSavesDir).some((p) => readFileSync(p, "utf8").includes("Grey Dwarfs"))).toBe(true);
  });

  it("a library file is chosen by its owner rows, never by its sanitised name (P1-3)", async () => {
    await seed(root);
    const deps = depsFor(root);
    const files = new Map((await collectExport(deps, "A_B")).map((f) => [f.name, String(f.content)]));
    expect(JSON.parse(files.get("team-library.json")!)).toEqual([]);
    await new PrivacyService(deps).deleteCoach("A_B", "A_B", "self");
    expect(existsSync(join(deps.libraryDir, "a_b.json"))).toBe(true);
  });
});

describe("delete", () => {
  it("is blocked while the coach owns an active tournament or a league, and on a mismatched confirm", async () => {
    await seed(root, { aliceOwnsActiveTournament: true, aliceOwnsLeague: true });
    const svc = new PrivacyService(depsFor(root));
    expect((await svc.deleteCoach("Alice", "Alicia", "self")).status).toBe("mismatch");
    const out = await svc.deleteCoach("Alice", "alice", "self");
    expect(out.status).toBe("blocked");
    expect(out.owned!.map((o) => `${o.kind}:${o.id}`).sort()).toEqual(["league:l1", "tournament:t2"]);
    expect(readIdentities().coaches.alice).toBeDefined();
    expect(listJobs(depsFor(root).stateDir)).toEqual([]);
  });

  it("every step: removes the account and private data, anonymises public history, leaves other coaches alone", async () => {
    await seed(root);
    const deps = depsFor(root);
    const sso = new PendingSsoStore(join(root, "sso-pending.json"));
    sso.create({ discordId: ALICE_DISCORD, discordUsername: "ally_dc", next: "/app/" });
    const bobToken = sso.create({ discordId: BOB_DISCORD, discordUsername: "bob_dc", next: "/app/" });
    const { token } = createSession("Alice", Date.now(), "discord");
    const { token: bobSession } = createSession("Bob", Date.now(), "discord");
    let events = 0;
    const svc = new PrivacyService({ ...deps, pendingSso: sso, onCoachDeleted: () => { events += 1; } });
    const out = await svc.deleteCoach("alice", "Alice", "self");
    expect(out).toMatchObject({ status: "deleted", pending: [], pseudonym: P });

    // identity, sessions, SSO
    expect(readIdentities().coaches.alice).toBeUndefined();
    expect(readIdentities().coaches.bob).toBeDefined();
    expect(getSession(token)).toBeUndefined();
    expect(getSession(bobSession)?.coach).toBe("Bob");
    expect(sso.get(bobToken)).toBeDefined();
    expect(readFileSync(join(root, "sso-pending.json"), "utf8")).not.toContain(ALICE_DISCORD);
    // avatars + logos
    expect(avatarStoreFor(deps.coachAvatarsDir).find(coachAvatarKey("Alice"))).toBeUndefined();
    expect(avatarStoreFor(deps.coachAvatarsDir).find(coachAvatarKey("Bob"))).toBeDefined();
    expect(walkFiles(join(deps.coachAvatarsDir, "proxy-cache"))).toEqual([]);
    expect(avatarStoreFor(deps.teamAvatarsDir).find("save:s1")).toBeUndefined();
    expect(avatarStoreFor(deps.teamAvatarsDir).find("library:t1")).toBeUndefined();
    expect(avatarStoreFor(deps.teamAvatarsDir).find("save:b1")).toBeDefined();
    // saves + share links, library
    expect(existsSync(join(deps.builderSavesDir, "shares", `${SHARE}.json`))).toBe(false);
    expect(walkFiles(deps.builderSavesDir)).toHaveLength(2); // Bob's and Dave's
    expect(existsSync(join(deps.libraryDir, "alice.json"))).toBe(false);
    expect(existsSync(join(deps.libraryDir, "bob.json"))).toBe(true);
    // notifications, bug reports
    expect(walkFiles(join(deps.stateDir, "notifications"))).toHaveLength(1);
    const bobN = readJ(walkFiles(join(deps.stateDir, "notifications"))[0]!).notifications[0];
    expect(bobN).toMatchObject({ from: P, title: `${P} proposed a time`, body: `${P} says hi; Alicent is someone else` });
    expect(walkFiles(deps.bugReportsDir).map((p) => p.includes("Bob"))).toEqual([true]);
    // organiser roles
    expect(readJ(join(root, "organizers.json")).organizers).toEqual(["Bob"]);
    const tf = readJ(join(deps.tournamentsDir, "tournaments.json"));
    expect(tf.version).toBe(4);
    expect(tf.tournaments.t1.organizerCoachIds).toEqual([]);
    expect(readJ(join(deps.stateDir, "leagues", "l1", "league.json")).organisers).toEqual(["Bob"]);
    // anonymised history (explicit fields; Discord ids dropped; the waiting-room lease dropped, never renamed)
    expect(tf.entrants.e1.coach).toEqual({ coachId: P, ffbCoachId: P, verifiedAt: "2026-10-01T00:00:00Z" });
    expect(tf.entrants.e2.coach.discordUserId).toBe(BOB_DISCORD);
    expect(tf.scheduledMatches.m1.home.coach.ffbCoachId).toBe(P);
    expect(tf.scheduledMatches.m1.away.coach.discordUserId).toBe(BOB_DISCORD);
    expect(tf.tournaments.t2.ownerCoachId).toBe(P); // a completed tournament keeps its record
    expect(tf.standings.t1.rows[0].coachId).toBe(P);
    expect(tf.tournaments.t1.news[0].body).toBe(`${P} wins the opener; well played Alicent.`);
    expect(Object.keys(tf.waitingPresence)).toEqual(["m1\u0000bob"]);
    const season = readJ(join(deps.stateDir, "leagues", "l1", "seasons", "s1.json"));
    expect(season.teams[0]).toMatchObject({ id: "green-orcs", name: "Green Orcs", coach: P, coachId: P });
    expect(season.teams[0].nafUser).toBeUndefined();
    expect(season.teams[1]).toMatchObject({ coach: "BobNaf", nafUser: "BobNaf" });
    expect(season.fixtures[0].home.coach).toBe(P);
    expect(season.participants[0].coach).toBe(P); // "AliceNaf": the identity's NAF alias
    expect(season.phases[0].standings[0].coach).toBe(P); // unlinked row: display name learned from the linked team row
    expect(season.honours[0].rows[0]).toMatchObject({ name: "Grub", coach: P });
    expect(season.honours[1].rows.map((r: { name: string }) => r.name)).toEqual([P, "BobNaf"]); // a coach honour's name is the coach
    expect(season.news[0].by).toBe(P);
    expect(season.log[0].text).toBe(`Bob assigned ${P} to Green Orcs`);
    expect(readJ(join(deps.stateDir, "leagues", "l1", "secrets.json")).webhookUrl).toMatch(/secret$/);
    const tm = readJ(join(deps.tabletopDir, "matches", "tm1.json"));
    expect(tm.home.coach).toBe(P);
    expect(tm.createdBy).toBe(P);
    expect(Object.keys(tm.confirmations).sort()).toEqual(["Bob", P].sort());
    expect(readFileSync(join(deps.tabletopDir, "events", "tm1.ndjson"), "utf8")).toContain(`"by":"${P}"`);
    expect(existsSync(join(deps.tabletopDir, "teams", "chain-alice.json"))).toBe(false);
    expect(existsSync(join(deps.tabletopDir, "teams", "chain-bob.json"))).toBe(true);
    const results = readJ(join(deps.stateDir, "tournament-results.json")).results;
    expect(results.g1.home.coach).toBe(P);
    expect(results.g2.away.coach).toBe("Carol");
    expect(readJ(join(deps.stateDir, "tournament-matches.json")).matches.g1.home.ffbCoachId).toBe(P);
    expect(Object.keys(readJ(join(deps.stateDir, "coach-titles.json")).titles).sort()).toEqual(["bob", P.toLowerCase()]);
    const naf = readJ(join(deps.stateDir, "naf-games.json")).coaches;
    expect(naf["1001"]).toBeUndefined();
    expect(naf["2002"].games[0].coaches).toEqual(["BobNaf", P]);
    expect(readJ(join(deps.stateDir, "replay-moments", "g1.json")).teams.home.coach).toBe(P);
    expect(events).toBeGreaterThanOrEqual(1); // the "coach deleted" event for the derived caches

    // unlinkable: no file anywhere still names Alice, her NAF / display / league / Discord names, email or Discord id;
    // the journal and its key are gone and the audit carries the pseudonym only
    for (const re of [/alice(?!nt)/i, /Ally Example/, /ally_dc/, new RegExp(ALICE_EMAIL), new RegExp(ALICE_DISCORD)])
      expect(filesContaining(root, re), String(re)).toEqual([]);
    expect(listJobs(deps.stateDir)).toEqual([]);
    expect(walkFiles(join(deps.stateDir, "privacy", "keys"))).toEqual([]);
    expect(readAudit(deps.stateDir)).toEqual([{ at: expect.any(String), actor: "self", pseudonym: P, jobId: expect.stringMatching(/^[a-f0-9]{24}$/) }]);
  });

  it("a display name like 'version', 'id' or 'name' deletes cleanly and every store still loads (P1-1)", async () => {
    for (const dn of ["version", "id", "name"]) {
      root = mkdtempSync(join(tmpdir(), "privacy-dn-"));
      roots.push(root);
      process.env.IDENTITIES_FILE = join(root, "identities.json");
      clearFences();
      await seed(root, { aliceDisplayName: dn });
      const deps = depsFor(root);
      expect((await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self")).status).toBe("deleted");
      expect(readJ(join(deps.tournamentsDir, "tournaments.json")).version).toBe(4);
      expect(readJ(join(deps.stateDir, "tournament-results.json")).version).toBe(1);
      expect(Object.keys(readJ(join(deps.stateDir, "tournament-results.json")).results.g2)).toContain("gameId");
      expect(readJ(join(deps.stateDir, "naf-games.json")).version).toBe(1);
      expect(readJ(join(deps.stateDir, "coach-titles.json")).version).toBe(1);
      const n = readJ(walkFiles(join(deps.stateDir, "notifications"))[0]!);
      expect(n.version).toBe(1);
      expect(n.notifications[0].id).toBe("n1");
      const season = readJ(join(deps.stateDir, "leagues", "l1", "seasons", "s1.json"));
      expect(season.id).toBe("s1");
      expect(season.teams[1].name).toBe("Blue Elves");
      expect(new TournamentResultStore(deps.stateDir).list().length).toBeGreaterThan(0);
    }
  });

  it("two accounts that differ only by Unicode form stay apart (P1-4)", async () => {
    await seed(root);
    const deps = depsFor(root);
    expect((await new PrivacyService(deps).deleteCoach(JOSE_NFC, JOSE_NFC, "self")).status).toBe("deleted");
    const g3 = readJ(join(deps.stateDir, "tournament-results.json")).results.g3;
    expect([g3.home.coach, g3.away.coach]).toEqual([P, JOSE_NFD]);
    expect(readIdentities().coaches[JOSE_NFD.toLowerCase()]).toBeDefined();
  });

  it("NAF games are matched per position, and ids only when the deleted coach had one (P2-7)", async () => {
    await seed(root);
    const deps = depsFor(root);
    await new PrivacyService(deps).deleteCoach("Carol", "Carol", "self"); // Carol has no NAF id
    expect(readJ(join(deps.stateDir, "naf-games.json")).coaches["2002"].games[0]).toMatchObject({ coaches: ["BobNaf", "AliceNaf"], coachIds: ["2002", "1001"] });
  });

  it("the deletion fence refuses writes that would recreate the coach (P2-6)", async () => {
    await seed(root);
    const deps = depsFor(root);
    fenceCoachHash(coachKeyHash("Bob")); // as during Bob's job
    expect(() => upsertIdentity({ ...readIdentities().coaches.bob!, note: "late write" })).toThrow(DeletionFenceError);
    expect(() => deleteSave(deps.builderSavesDir, "Bob", "b1")).toThrow(DeletionFenceError);
    await expect(avatarStoreFor(deps.coachAvatarsDir).save("Bob", coachAvatarKey("Bob"), png(), "png")).rejects.toThrow(DeletionFenceError);
    expect(() => createSession("bob", Date.now(), "discord")).toThrow(DeletionFenceError);
    clearFences();
    // after a completed delete the grace period still refuses, and a profile write never creates the record again
    await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    expect(() => upsertIdentity({ ffbCoachId: "Alice", level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "", updatedBy: "" })).toThrow(DeletionFenceError);
    clearFences();
    const deps2 = { linkedFumbblName: () => undefined, discordAvatarUrl, uploadedAvatarUrl: () => undefined };
    expect(() => updateOwnProfile("Alice", { displayName: "Back again" }, deps2 as never)).toThrow(/No account record/);
    expect(readIdentities().coaches.alice).toBeUndefined();
  });

  it("re-pulled fork results are anonymised on write through the deleted-coach map (P2-8)", async () => {
    await seed(root);
    const deps = depsFor(root);
    await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    expect(deletedPseudonymFor(deps.stateDir, "alice")).toBe(P);
    expect(deletedPseudonymFor(deps.stateDir, "bob")).toBeUndefined();
    setResultCoachFilter((c) => deletedPseudonymFor(deps.stateDir, normalizeFfbCoachId(c)));
    const store = new TournamentResultStore(deps.stateDir);
    store.put({ gameId: "g9", pulledAt: "", home: { teamId: "t1", teamName: "Green Orcs", coach: "Alice" }, away: { teamId: "t2", teamName: "Blue Elves", coach: "Bob" }, teams: [] });
    expect(store.get("g9")).toMatchObject({ home: { coach: P }, away: { coach: "Bob" } });
    expect(readFileSync(join(deps.stateDir, "privacy", "deleted-coaches.json"), "utf8")).not.toMatch(/alice/i);
  });

  it("a file the OS will not delete fails its step (only ENOENT is success) and stays pending (P2-14)", async () => {
    await seed(root);
    const deps = depsFor(root);
    // a directory where Alice's notification file is: unlink refuses (EPERM / EISDIR)
    const { notificationFileName } = await import("../src/notifications.js");
    const f = join(deps.stateDir, "notifications", notificationFileName("alice"));
    rmSync(f);
    mkdirSync(f);
    const out = await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    expect(out.pending).toEqual(["notifications"]);
    expect(listJobs(deps.stateDir)).toHaveLength(1);
  });

  it("the journal holds no names in the clear; after the retry cap the job is abandoned for the admin (P2-15)", async () => {
    await seed(root);
    const deps = depsFor(root);
    let t = Date.parse("2026-11-01T00:00:00Z");
    const svc = new PrivacyService({ ...deps, disableForkAccount: async () => { throw new Error("connect ECONNREFUSED"); } }, () => t);
    expect((await svc.deleteCoach("Alice", "Alice", "self")).pending).toEqual(["fork-account"]);
    const [jobId] = listJobs(deps.stateDir);
    const journal = readFileSync(join(deps.stateDir, "privacy", "jobs", `${jobId}.jsonl`), "utf8");
    for (const re of [/alice/i, /Ally/, /1001/, new RegExp(ALICE_DISCORD)]) expect(journal).not.toMatch(re);
    expect(svc.jobs().open).toEqual([{ jobId, pseudonym: P, pending: ["fork-account"], startedAt: expect.any(String) }]);
    t += (JOB_RETRY_DAYS - 1) * 86_400_000;
    expect(await svc.resumeAll()).toEqual([jobId]);
    t += 2 * 86_400_000;
    expect(await svc.resumeAll()).toEqual([]);
    expect(listJobs(deps.stateDir)).toEqual([]);
    expect(walkFiles(join(deps.stateDir, "privacy", "keys"))).toEqual([]);
    expect(svc.jobs()).toEqual({ open: [], failed: [{ jobId, pseudonym: P, pending: ["fork-account"], startedAt: expect.any(String), abandonedAt: expect.any(String) }] });
    expect(readAudit(deps.stateDir)).toEqual([]);
  });

  it("the fork step stays pending while the fork is unreachable; the audit is written once even if it already exists (P2-16)", async () => {
    await seed(root);
    const deps = depsFor(root);
    let up = false;
    const calls: string[] = [];
    const svc = new PrivacyService({ ...deps, disableForkAccount: async (coach) => { calls.push(coach); if (!up) throw new Error("connect ECONNREFUSED"); } });
    const out = await svc.deleteCoach("Alice", "Alice", "self");
    expect(out.pending).toEqual(["fork-account"]);
    expect(readIdentities().coaches.alice).toBeUndefined(); // the rest of the job went ahead
    const [jobId] = listJobs(deps.stateDir);
    expect(readJournal(deps.stateDir, jobId!).filter((l) => l.type === "step" && l.status === "failed").map((l) => (l as { step: string }).step)).toEqual(["fork-account"]);
    expect(await svc.resumeAll()).toEqual([jobId]);
    // a crash after the audit line but before the complete marker: the resumed job must not audit twice
    appendAudit(deps.stateDir, { at: "x", actor: "self", pseudonym: P, jobId });
    up = true;
    expect(await svc.resumeAll()).toEqual([]);
    expect(calls).toEqual(["Alice", "Alice", "Alice"]);
    expect(listJobs(deps.stateDir)).toEqual([]);
    expect(readAudit(deps.stateDir).filter((a) => a.jobId === jobId)).toHaveLength(1);
  });

  it("a job a crash interrupted resumes idempotently from its sealed journal", async () => {
    await seed(root);
    const deps = depsFor(root);
    const plan = buildPlan(deps, {
      sessionCoach: "Alice", jobId: "0123456789abcdef01234567", pseudonym: "Deleted coach #9", actor: "self", now: new Date(),
      blockHashOf: (id) => blocklistHash(deps.stateDir, id), discordAvatarUrl,
    });
    const { stored, secrets } = splitPlan(plan);
    appendJournal(deps.stateDir, plan.jobId, { type: "plan", ...stored, sealed: sealForJob(deps.stateDir, plan.jobId, secrets) });
    const ctx = deleteContext(deps, plan);
    for (const step of DELETE_STEPS.slice(0, 6)) {
      await step.run(ctx);
      appendJournal(deps.stateDir, plan.jobId, { type: "step", step: step.id, status: "done", at: "" });
    }
    await DELETE_STEPS[6]!.run(ctx); // done but never journaled
    appendFileSync(join(deps.stateDir, "privacy", "jobs", `${plan.jobId}.jsonl`), '{"type":"step","step":"libr');
    expect(readIdentities().coaches.alice).toBeDefined();
    expect(await new PrivacyService(deps).resumeAll()).toEqual([]);
    expect(readIdentities().coaches.alice).toBeUndefined();
    expect(readJ(join(deps.stateDir, "tournament-results.json")).results.g1.home.coach).toBe("Deleted coach #9");
    expect(listJobs(deps.stateDir)).toEqual([]);
    expect(readAudit(deps.stateDir).map((a) => a.pseudonym)).toEqual(["Deleted coach #9"]);
  });

  it("pseudonyms are stable within a run and new for the next deletion", async () => {
    await seed(root);
    const svc = new PrivacyService(depsFor(root));
    await svc.deleteCoach("Alice", "Alice", "self");
    expect((await svc.deleteCoach("Bob", "Bob", "self")).status).toBe("blocked"); // Bob owns the league
    const out = await svc.deleteCoach("Carol", "Carol", "self");
    expect(out.pseudonym).toBe("Deleted coach #2");
    const r = readJ(join(depsFor(root).stateDir, "tournament-results.json")).results;
    expect([r.g1.home.coach, r.g1.away.coach, r.g2.away.coach]).toEqual([P, "Bob", "Deleted coach #2"]);
  });

  it("a banned coach's Discord id stays blocked as a salted hash", async () => {
    await seed(root, { aliceBanned: true });
    const deps = depsFor(root);
    const svc = new PrivacyService({ ...deps, env: { PRIVACY_BLOCKLIST_SALT: "" } });
    await svc.deleteCoach("Alice", "Alice", "self");
    expect(isDiscordBlocked(deps.stateDir, ALICE_DISCORD)).toBe(true);
    expect(isDiscordBlocked(deps.stateDir, BOB_DISCORD)).toBe(false);
    expect(filesContaining(root, new RegExp(ALICE_DISCORD))).toEqual([]);
    expect(existsSync(join(deps.stateDir, "privacy", "blocklist-salt"))).toBe(true);
    expect((await svc.deleteCoach("Carol", "Carol", "self")).status).toBe("deleted");
    expect(isDiscordBlocked(deps.stateDir, "900000000000000003")).toBe(false);
    expect(readJ(join(deps.stateDir, "privacy", "blocklist.json")).hashes).toHaveLength(1);
  });
});
