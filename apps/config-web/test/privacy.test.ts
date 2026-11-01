import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnonymiser } from "../src/privacy/anonymise.js";
import { buildPlan, collectExport, DELETE_STEPS, INVENTORY_ROWS, KNOWN_STORES, STORE_COLLECTORS } from "../src/privacy/collectors.js";
import { INVENTORY } from "../spa/src/privacy/inventory";
import { PrivacyService } from "../src/privacy/service.js";
import {
  appendJournal, blocklistHash, isDiscordBlocked, listJobs, readAudit, readJournal,
} from "../src/privacy/state.js";
import { createSession, getSession } from "../src/auth/session.js";
import { readIdentities } from "../src/auth/identitiesStore.js";
import { avatarStoreFor } from "../src/teamAvatars.js";
import { coachAvatarKey } from "../src/coachAvatars.js";
import { discordAvatarUrl, PendingSsoStore } from "../src/auth/discordSso.js";
import {
  ALICE_DISCORD, ALICE_EMAIL, BOB_DISCORD, BOB_EMAIL, depsFor, filesContaining, seed, SHARE, walkFiles,
} from "./privacyFixture.js";

// Privacy spec 2026-10-31 §2 (export) and §3 (delete, anonymise don't erase): the collector registry, the export per
// store, every delete step, anonymisation, the journal and its resume, the fork retry and the banned-coach blocklist.

const roots: string[] = [];
const prevIdentities = process.env.IDENTITIES_FILE;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "privacy-"));
  roots.push(root);
  process.env.IDENTITIES_FILE = join(root, "identities.json");
});
afterEach(() => { if (prevIdentities === undefined) delete process.env.IDENTITIES_FILE; else process.env.IDENTITIES_FILE = prevIdentities; });
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const readJ = <T = any>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

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
  const an = createAnonymiser(["Alice", "AliceNaf"], "Deleted coach #7");
  it("replaces coach values and keys, lower-case for folded values, drops re-identifying siblings, leaves free text", () => {
    const r = an.apply({ coach: "alice", coachId: "Alice", nafUser: "AliceNaf", discordUserId: "1", teamName: "Alice", title: "Alice wins", map: { Alice: 1, alice: 2 }, list: ["Bob", "ALICE"] });
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ coach: "deleted coach #7", coachId: "Deleted coach #7", teamName: "Alice", title: "Alice wins", map: { "Deleted coach #7": 1, "deleted coach #7": 2 }, list: ["Bob", "Deleted coach #7"] });
  });
  it("text replacement respects word boundaries", () => {
    expect(an.text("Alice met Alicent and alice.")).toBe("Deleted coach #7 met Alicent and Deleted coach #7.");
  });
  it("reports no change on unrelated data", () => {
    expect(an.apply({ coach: "Bob" }).changed).toBe(false);
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
    expect(leagues[0].seasons[0].honours).toHaveLength(1);
    expect(JSON.parse(text("tabletop-matches.json")).matches[0].events).toHaveLength(2);
    const results = JSON.parse(text("results.json"));
    expect(results.results.map((r: { gameId: string }) => r.gameId)).toEqual(["g1"]);
    expect(results.title.title).toBe("Star");
    expect(results.nafRecord.nafId).toBe("1001");
    expect(JSON.parse(text("notifications.json"))[0].title).toBe("From Bob");
    expect(JSON.parse(text("bug-reports-index.json")).map((r: { description: string }) => r.description)).toEqual(["Crash"]);
    expect(text("README.txt")).toMatch(/account\.json/);
    // nothing private of other coaches, no secrets
    const all = [...files.values()].map((c) => (typeof c === "string" ? c : c.toString("latin1"))).join("\n");
    expect(all).not.toContain(BOB_EMAIL);
    expect(all).not.toContain(BOB_DISCORD);
    expect(all).not.toContain(SHARE);
    expect(all).not.toContain("webhooks");
    expect(all).not.toContain("Bob crash");
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
    let reloaded = 0;
    const svc = new PrivacyService({ ...deps, pendingSso: sso, afterAnonymise: () => { reloaded += 1; } });
    const out = await svc.deleteCoach("alice", "Alice", "self");
    expect(out).toMatchObject({ status: "deleted", pending: [], pseudonym: "Deleted coach #1" });
    const P = "Deleted coach #1";

    // 1 identity, sessions, SSO
    expect(readIdentities().coaches.alice).toBeUndefined();
    expect(readIdentities().coaches.bob).toBeDefined();
    expect(getSession(token)).toBeUndefined();
    expect(getSession(bobSession)?.coach).toBe("Bob");
    expect(sso.get(bobToken)).toBeDefined();
    expect(readFileSync(join(root, "sso-pending.json"), "utf8")).not.toContain(ALICE_DISCORD);
    // 2 avatars + logos
    expect(avatarStoreFor(deps.coachAvatarsDir).find(coachAvatarKey("Alice"))).toBeUndefined();
    expect(avatarStoreFor(deps.coachAvatarsDir).find(coachAvatarKey("Bob"))).toBeDefined();
    expect(walkFiles(join(deps.coachAvatarsDir, "proxy-cache"))).toEqual([]);
    expect(avatarStoreFor(deps.teamAvatarsDir).find("save:s1")).toBeUndefined();
    expect(avatarStoreFor(deps.teamAvatarsDir).find("library:t1")).toBeUndefined();
    expect(avatarStoreFor(deps.teamAvatarsDir).find("save:b1")).toBeDefined();
    // 3 saves + share links, library
    expect(existsSync(join(deps.builderSavesDir, "shares", `${SHARE}.json`))).toBe(false);
    expect(walkFiles(deps.builderSavesDir)).toHaveLength(1);
    expect(existsSync(join(deps.libraryDir, "alice.json"))).toBe(false);
    expect(existsSync(join(deps.libraryDir, "bob.json"))).toBe(true);
    // 4 notifications, bug reports
    expect(walkFiles(join(deps.stateDir, "notifications"))).toHaveLength(1);
    const bobN = readJ(walkFiles(join(deps.stateDir, "notifications"))[0]!).notifications[0];
    expect(bobN).toMatchObject({ from: P, title: `${P} proposed a time`, body: `${P} says hi; Alicent is someone else` });
    expect(walkFiles(deps.bugReportsDir).map((p) => p.includes("Bob"))).toEqual([true]);
    // 6 organiser roles
    expect(readJ(join(root, "organizers.json")).organizers).toEqual(["Bob"]);
    const tf = readJ(join(deps.tournamentsDir, "tournaments.json"));
    expect(tf.tournaments.t1.organizerCoachIds).toEqual([]);
    expect(readJ(join(deps.stateDir, "leagues", "l1", "league.json")).organisers).toEqual(["Bob"]);
    // 5 anonymised history
    expect(tf.entrants.e1.coach).toEqual({ coachId: P, ffbCoachId: P, verifiedAt: "2026-10-01T00:00:00Z" });
    expect(tf.entrants.e2.coach.discordUserId).toBe(BOB_DISCORD);
    expect(tf.tournaments.t2.ownerCoachId).toBe(P); // a completed tournament keeps its record
    expect(tf.standings.t1.rows[0].coachId).toBe(P);
    const season = readJ(join(deps.stateDir, "leagues", "l1", "seasons", "s1.json"));
    expect(season.teams[0]).toMatchObject({ id: "green-orcs", name: "Green Orcs", coach: P, coachId: P });
    expect(season.teams[0].nafUser).toBeUndefined();
    expect(season.teams[1]).toMatchObject({ coach: "BobNaf", nafUser: "BobNaf" });
    expect(season.fixtures[0].home.coach).toBe(P);
    expect(season.honours[0].rows[0].coach).toBe(P);
    expect(season.news[0].by).toBe(P);
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
    expect(reloaded).toBe(1);
    const naf = readJ(join(deps.stateDir, "naf-games.json")).coaches;
    expect(naf["1001"]).toBeUndefined();
    expect(naf["2002"].games[0].coaches).toEqual(["BobNaf", P]);
    expect(readJ(join(deps.stateDir, "replay-moments", "g1.json")).teams.home.coach).toBe(P);

    // unlinkable: no file anywhere still names Alice, her NAF / display / Discord names, email or Discord id;
    // the journal is gone and the audit carries the pseudonym only
    for (const re of [/alice(?!nt)/i, /Ally Example/, /ally_dc/, new RegExp(ALICE_EMAIL), new RegExp(ALICE_DISCORD)])
      expect(filesContaining(root, re), String(re)).toEqual([]);
    expect(listJobs(deps.stateDir)).toEqual([]);
    expect(readAudit(deps.stateDir)).toEqual([{ at: expect.any(String), actor: "self", pseudonym: P }]);
  });

  it("pseudonyms are stable within a run and new for the next deletion", async () => {
    await seed(root);
    const svc = new PrivacyService(depsFor(root));
    await svc.deleteCoach("Alice", "Alice", "self");
    expect((await svc.deleteCoach("Bob", "Bob", "self")).status).toBe("blocked"); // Bob owns the league
    const out = await svc.deleteCoach("Carol", "Carol", "self");
    expect(out.pseudonym).toBe("Deleted coach #2");
    const r = readJ(join(depsFor(root).stateDir, "tournament-results.json")).results;
    expect([r.g1.home.coach, r.g1.away.coach, r.g2.away.coach]).toEqual(["Deleted coach #1", "Bob", "Deleted coach #2"]);
  });

  it("the fork step stays pending while the fork is unreachable and is retried until it succeeds", async () => {
    await seed(root);
    const deps = depsFor(root);
    let up = false;
    const calls: string[] = [];
    const svc = new PrivacyService({ ...deps, disableForkAccount: async (coach) => { calls.push(coach); if (!up) throw new Error("connect ECONNREFUSED"); } });
    const out = await svc.deleteCoach("Alice", "Alice", "self");
    expect(out.pending).toEqual(["fork-account"]);
    expect(readIdentities().coaches.alice).toBeUndefined(); // the rest of the job went ahead
    const [jobId] = listJobs(deps.stateDir);
    expect(jobId).toBeDefined();
    expect(readJournal(deps.stateDir, jobId!).filter((l) => l.type === "step" && l.status === "failed").map((l) => (l as { step: string }).step)).toEqual(["fork-account"]);
    expect(readAudit(deps.stateDir)).toEqual([]);
    expect(await svc.resumeAll()).toEqual([jobId]); // still down
    up = true;
    expect(await svc.resumeAll()).toEqual([]);
    expect(calls).toEqual(["Alice", "Alice", "Alice"]);
    expect(listJobs(deps.stateDir)).toEqual([]);
    expect(readAudit(deps.stateDir).map((a) => a.pseudonym)).toEqual(["Deleted coach #1"]);
  });

  it("a job a crash interrupted resumes idempotently from its journal", async () => {
    await seed(root);
    const deps = depsFor(root);
    const plan = buildPlan(deps, {
      sessionCoach: "Alice", jobId: "0123456789abcdef01234567", pseudonym: "Deleted coach #9", actor: "self", now: new Date(),
      blockHashOf: (id) => blocklistHash(deps.stateDir, id), discordAvatarUrl,
    });
    appendJournal(deps.stateDir, plan.jobId, { type: "plan", ...plan });
    // the crash happened after the first steps, and in the middle of writing the next journal line
    const svc = new PrivacyService(deps);
    const ctxSteps = DELETE_STEPS.slice(0, 6);
    const { deleteContext } = await import("../src/privacy/collectors.js");
    const ctx = deleteContext(deps, plan);
    for (const step of ctxSteps) {
      await step.run(ctx);
      appendJournal(deps.stateDir, plan.jobId, { type: "step", step: step.id, status: "done", at: "" });
    }
    await DELETE_STEPS[6]!.run(ctx); // done but never journaled
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(deps.stateDir, "privacy", "jobs", `${plan.jobId}.jsonl`), '{"type":"step","step":"libr');
    expect(readIdentities().coaches.alice).toBeDefined();
    expect(await svc.resumeAll()).toEqual([]);
    expect(readIdentities().coaches.alice).toBeUndefined();
    expect(readJ(join(deps.stateDir, "tournament-results.json")).results.g1.home.coach).toBe("Deleted coach #9");
    expect(listJobs(deps.stateDir)).toEqual([]);
    expect(readAudit(deps.stateDir).map((a) => a.pseudonym)).toEqual(["Deleted coach #9"]);
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
    // a coach who was not banned leaves no blocklist entry
    expect((await svc.deleteCoach("Carol", "Carol", "self")).status).toBe("deleted");
    expect(isDiscordBlocked(deps.stateDir, "900000000000000003")).toBe(false);
    expect(readJ(join(deps.stateDir, "privacy", "blocklist.json")).hashes).toHaveLength(1);
  });
});
