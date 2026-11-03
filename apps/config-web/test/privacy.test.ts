import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnonymiser, createTextReplacer, textAliases } from "../src/privacy/anonymise.js";
import {
  buildPlan, collectExport, deleteContext, DELETE_STEPS, INVENTORY_ROWS, KNOWN_STORES, splitPlan, STORE_COLLECTORS,
} from "../src/privacy/collectors.js";
import { INVENTORY } from "../spa/src/privacy/inventory";
import { JOB_RETRY_DAYS, PrivacyService } from "../src/privacy/service.js";
import {
  appendAudit, appendJournal, blocklistHash, deletedPseudonymFor, destroyJobKey, isDiscordBlocked, isRecentlyDeleted, listJobs, readAudit, readJournal, sealForJob,
} from "../src/privacy/state.js";
import { NafRecordStore, setNafIdFilter } from "../src/nafRecords.js";
import { MailWorker, Outbox } from "../src/mail/outbox.js";
import { MailPrefsStore } from "../src/mail/stores.js";
import { ReplayMomentStore, setReplayCoachFilter } from "../src/replay/store.js";
import {
  clearFences, coachKey, DeletionFenceError, fenceCoachHash, coachKeyHash, isCoachFenced, isReservedCoachName, legacyCoachKeyHash, ReservedNameError,
} from "../src/privacy/fence.js";
import { createSession, getSession } from "../src/auth/session.js";
import { normalizeFfbCoachId, readIdentities, upsertIdentity } from "../src/auth/identitiesStore.js";
import { updateOwnProfile } from "../src/accountProfile.js";
import { deleteSave } from "../src/teamBuilderSaves.js";
import { avatarStoreFor } from "../src/teamAvatars.js";
import { coachAvatarKey } from "../src/coachAvatars.js";
import { setResultCoachFilter, TournamentResultStore } from "../src/tournamentResults.js";
import { honoursView } from "../src/leagues/awards.js";
import { applyDraftTeam } from "../src/leagues/redraft.js";
import { discordAvatarUrl, PendingSsoStore } from "../src/auth/discordSso.js";
import {
  ALICE_DISCORD, ALICE_EMAIL, BOB_DISCORD, BOB_EMAIL, depsFor, filesContaining, JOSE_NFC, JOSE_NFD, png, seed, SHARE, TEST_MAP_KEY, walkFiles,
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
  setNafIdFilter(undefined);
  setReplayCoachFilter(undefined);
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
  it("free text: case-sensitive whole words, longer names first, pseudonyms never rewritten again (P3)", () => {
    const tx = createTextReplacer(["Alice", "Alice Smith", "Deleted"], "Deleted coach #7");
    const once = tx.text("Alice Smith met Alicent and alice; Alice too.");
    expect(once).toBe("Deleted coach #7 met Alicent and alice; Deleted coach #7 too.");
    expect(tx.text(once)).toBe(once);
  });
  it("free-text aliases: at least 3 characters, no common words, never another coach's name", () => {
    expect(textAliases(["Alice", "Al", "version", "The", "Bob", "Alice Smith", "Deleted coach #2"], new Set(["bob"]))).toEqual(["Alice", "Alice Smith"]);
  });
  it("matches with the identity store's key only: a different Unicode form is a different coach", () => {
    const j = createAnonymiser([JOSE_NFC], "D");
    expect(j.matches(JOSE_NFC.toUpperCase())).toBe(true);
    expect(j.matches(JOSE_NFD)).toBe(false);
  });
});

describe("round 3 regressions", () => {
  it("1: an alias inside another coach's longer name is left alone; NFC and combining marks", () => {
    const tx = createTextReplacer(["Alice"], P, ["alice smith", "bob"]);
    expect(tx.text("Alice Smith won; Alice lost")).toBe(`Alice Smith won; ${P} lost`);
    const jose = createTextReplacer(["Jose"], P);
    expect(jose.text("Jose\u0301 won")).toBe("Jose\u0301 won"); // decomposed José is not Jose
    expect(createTextReplacer(["Jos\u00e9"], P).text("Jose\u0301 won")).toBe(`${P} won`); // compared in NFC
  });

  it("2: an unreadable identities store refuses the plan (no job, nothing deleted)", async () => {
    await seed(root);
    const fs = await import("node:fs");
    const good = fs.readFileSync(join(root, "identities.json"), "utf8");
    fs.writeFileSync(join(root, "identities.json"), "{ not json");
    const deps = depsFor(root);
    await expect(new PrivacyService(deps).deleteCoach("Alice", "Alice", "self")).rejects.toThrow();
    expect(listJobs(deps.stateDir)).toEqual([]);
    fs.writeFileSync(join(root, "identities.json"), good);
    expect(readIdentities().coaches.alice).toBeDefined();
  });

  it("3: without PRIVACY_MAP_KEY a resumed job runs no step; a failed step halts the job", async () => {
    await seed(root);
    const deps = depsFor(root);
    const failing = { ...deps, disableForkAccount: async () => { throw new Error("connect ECONNREFUSED"); } };
    await new PrivacyService(failing).deleteCoach("Alice", "Alice", "self");
    const [jobId] = listJobs(deps.stateDir);
    const lines = readJournal(deps.stateDir, jobId!);
    expect(lines.filter((l) => l.type === "step").map((l) => (l as { step: string }).step).at(-1)).toBe("fork-account"); // nothing after it
    const noKey = new PrivacyService({ ...failing, mapKey: undefined, disableForkAccount: async () => undefined });
    expect(await noKey.resumeAll()).toEqual([jobId]);
    expect(readJournal(deps.stateDir, jobId!)).toHaveLength(lines.length); // no step ran
    expect(readIdentities().coaches.alice).toBeUndefined(); // everything before the (last) fork step was done
  });

  it("4: the fence folds NFC like the avatar store: a decomposed spelling fences the composed one", async () => {
    await seed(root);
    fenceCoachHash(coachKeyHash(JOSE_NFD));
    expect(() => createSession(JOSE_NFC, Date.now(), "discord")).toThrow(DeletionFenceError);
    await expect(avatarStoreFor(depsFor(root).coachAvatarsDir).save(JOSE_NFC.toLowerCase(), coachAvatarKey(JOSE_NFC), png(), "png")).rejects.toThrow(DeletionFenceError);
  });

  it("6: an unreadable deleted-coach map fails the step; the write filters keep the last good map or fail closed", async () => {
    await seed(root);
    const deps = depsFor(root);
    await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    expect(deletedPseudonymFor(deps.stateDir, TEST_MAP_KEY, "alice")).toBe(P); // read once: the last good copy
    const fs = await import("node:fs");
    const mapPath = join(deps.stateDir, "privacy", "deleted-coaches.json");
    fs.writeFileSync(mapPath, "{ broken");
    expect(deletedPseudonymFor(deps.stateDir, TEST_MAP_KEY, "alice")).toBe(P); // never an empty map
    const { recordDeletedCoach } = await import("../src/privacy/state.js");
    expect(() => recordDeletedCoach(deps.stateDir, TEST_MAP_KEY, ["carol"], "Deleted coach #2")).toThrow();
    expect(fs.readFileSync(mapPath, "utf8")).toBe("{ broken"); // previous mappings never overwritten
    const out = await new PrivacyService(deps).deleteCoach("Carol", "Carol", "self");
    expect(out.pending).toEqual(["deleted-map"]);
    expect(readIdentities().coaches.carol).toBeDefined();
  });

  it("7: a fork step pending when the fork config disappears stays pending; a job planned without a fork skips it", async () => {
    await seed(root);
    const deps = depsFor(root);
    await new PrivacyService({ ...deps, disableForkAccount: async () => { throw new Error("connect ECONNREFUSED"); } }).deleteCoach("Alice", "Alice", "self");
    const [jobId] = listJobs(deps.stateDir);
    expect(await new PrivacyService(deps).resumeAll()).toEqual([jobId]); // restarted without FORK_DB_HOST: still pending
    expect(readAudit(deps.stateDir)).toEqual([]);
    expect(readJournal(deps.stateDir, jobId!).some((l) => l.type === "step" && (l as { step: string; status: string }).step === "fork-account" && (l as { status: string }).status === "skipped")).toBe(false);
    expect(await new PrivacyService({ ...deps, disableForkAccount: async () => undefined }).resumeAll()).toEqual([]);
    expect(listJobs(deps.stateDir)).toEqual([]);
    // a job planned on a host without a fork: the step is skipped
    expect((await new PrivacyService(deps).deleteCoach("Carol", "Carol", "self")).pending).toEqual([]);
  });
});

describe("round 4 regressions", () => {
  it("a stuck job can be retried by an admin once the fork is back", async () => {
    await seed(root);
    const deps = depsFor(root);
    let t = Date.parse("2026-11-01T00:00:00Z");
    let up = false;
    const svc = new PrivacyService({ ...deps, disableForkAccount: async () => { if (!up) throw new Error("connect ECONNREFUSED"); } }, () => t);
    await svc.deleteCoach("Alice", "Alice", "self");
    const [jobId] = listJobs(deps.stateDir);
    t += (JOB_RETRY_DAYS + 1) * 86_400_000;
    await svc.resumeAll();
    expect(svc.jobs().open[0]!.stuck).toBe(true);
    up = true;
    expect(await svc.resumeAll()).toEqual([jobId]); // a stuck job never runs by itself
    expect(await svc.retryJob(jobId!)).toEqual([]);
    expect(listJobs(deps.stateDir)).toEqual([]);
    expect(readAudit(deps.stateDir).map((a) => a.actor)).toEqual(["self"]);
  });

  it("the mail worker never sends to a coach whose deletion is running", async () => {
    await seed(root);
    const deps = depsFor(root);
    const outbox = new Outbox(join(deps.stateDir, "mail"));
    const msg = (to: string) => ({ to, subject: "League news", text: "Hello", html: "<p>Hello</p>", template: "league-message" });
    outbox.enqueue([
      { key: "k1", message: msg(ALICE_EMAIL), recipient: { coach: "Alice", leagueId: "l1" }, leagueId: "l1" },
      { key: "k2", message: msg(BOB_EMAIL), recipient: { coach: "Bob", leagueId: "l1" }, leagueId: "l1" },
    ]);
    const sent: string[] = [];
    const worker = new MailWorker({ outbox, transport: { send: async (m: { to: string }) => { sent.push(m.to); } } as never });
    fenceCoachHash(coachKeyHash("Alice"));
    await worker.drain();
    expect(sent).toEqual([BOB_EMAIL]);
    expect(outbox.forCoach("Alice")[0]).toMatchObject({ status: "dead", error: "account deleted" });
  });

  it("a journal written with the pre-NFC fence hash still fences, in both spellings", async () => {
    await seed(root);
    const deps = depsFor(root);
    fenceCoachHash(legacyCoachKeyHash("Alice"));
    expect(isCoachFenced("alice")).toBe(true);
    clearFences();
    // a legacy journal for the decomposed spelling: resuming fences the NFC form too
    const plan = buildPlan(deps, {
      sessionCoach: JOSE_NFD, jobId: "0123456789abcdef0123abcd", pseudonym: "Deleted coach #5", actor: "self", now: new Date(), mapKey: TEST_MAP_KEY,
      blockHashOf: (id) => blocklistHash(deps.stateDir, id), discordAvatarUrl,
    });
    const { stored, secrets } = splitPlan(plan);
    appendJournal(deps.stateDir, plan.jobId, { type: "plan", ...stored, coachHash: legacyCoachKeyHash(JOSE_NFD), sealed: sealForJob(deps.stateDir, plan.jobId, secrets) });
    appendJournal(deps.stateDir, plan.jobId, { type: "step", step: "sessions", status: "done", at: "" });
    await new PrivacyService({ ...deps, disableForkAccount: async () => { throw new Error("down"); } }).resumeAll();
    expect(isCoachFenced(JOSE_NFD)).toBe(true);
    expect(isCoachFenced(JOSE_NFC)).toBe(true);
  });
});

describe("round 5 regressions (admin Close)", () => {
  it("Close is refused while the account still exists (any step but the fork step and the final sweep unfinished)", async () => {
    await seed(root);
    const deps = depsFor(root);
    mkdirSync(join(root, "sessions.json"), { recursive: true }); // the very first step fails: nothing is deleted yet
    let t = Date.parse("2026-11-01T00:00:00Z");
    const svc = new PrivacyService(deps, () => t);
    expect((await svc.deleteCoach("Alice", "Alice", "self")).pending).toEqual(["sessions"]);
    const [jobId] = listJobs(deps.stateDir);
    t += (JOB_RETRY_DAYS + 1) * 86_400_000;
    await svc.resumeAll();
    expect(svc.jobs().open[0]!.stuck).toBe(true);
    const r = await svc.closeJob(jobId!, "Root");
    expect(r).toMatchObject({ ok: false, reason: "unfinished" });
    expect((r as { pending: string[] }).pending).toEqual(expect.arrayContaining(["sessions", "identity"]));
    expect(listJobs(deps.stateDir)).toEqual([jobId]); // journal kept
    expect(isCoachFenced("Alice")).toBe(true); // fence kept
    expect(readIdentities().coaches.alice).toBeDefined();
    expect(readAudit(deps.stateDir)).toEqual([]);
  });

  it("Close after the key is lost releases every fence hash the job journaled (legacy and NFC)", async () => {
    await seed(root);
    const deps = depsFor(root);
    const past = Date.now() - 3_600_000; // releases land in the past, so a released fence is gone at once
    const plan = buildPlan(deps, {
      sessionCoach: JOSE_NFD, jobId: "0123456789abcdef0123cdef", pseudonym: "Deleted coach #6", actor: "self", now: new Date(past), mapKey: TEST_MAP_KEY,
      blockHashOf: (id) => blocklistHash(deps.stateDir, id), discordAvatarUrl,
    });
    const { stored, secrets } = splitPlan(plan);
    appendJournal(deps.stateDir, plan.jobId, { type: "plan", ...stored, coachHash: legacyCoachKeyHash(JOSE_NFD), sealed: sealForJob(deps.stateDir, plan.jobId, secrets) });
    const svc = new PrivacyService({ ...deps, disableForkAccount: async () => { throw new Error("down"); } }, () => past);
    expect(await svc.resumeAll()).toEqual([plan.jobId]); // everything up to the fork step done; the NFC hash journaled
    expect(readJournal(deps.stateDir, plan.jobId).some((l) => l.type === "fence")).toBe(true);
    expect(isCoachFenced(JOSE_NFC)).toBe(true);
    destroyJobKey(deps.stateDir, plan.jobId); // the key is lost
    expect(await svc.closeJob(plan.jobId, "Root")).toEqual({ ok: true });
    expect(isCoachFenced(JOSE_NFC)).toBe(false);
    expect(isCoachFenced(JOSE_NFD)).toBe(false);
    expect(listJobs(deps.stateDir)).toEqual([]);
  });
});

describe("portal mail store", () => {
  it("exports the coach's mail prefs and deliveries; deletion drops them, keeps Bob's, anonymises the audit sender", async () => {
    await seed(root);
    const deps = depsFor(root);
    const mailDir = join(deps.stateDir, "mail");
    const outbox = new Outbox(mailDir);
    const prefs = new MailPrefsStore(mailDir);
    const msg = (to: string) => ({ to, subject: "League news", text: "Hello", html: "<p>Hello</p>", template: "league-message" });
    outbox.enqueue([
      { key: "k1", message: msg(ALICE_EMAIL), recipient: { coach: "Alice", leagueId: "l1" }, leagueId: "l1" },
      { key: "k2", message: msg(BOB_EMAIL), recipient: { coach: "Bob", leagueId: "l1" }, leagueId: "l1" },
    ]);
    prefs.update("Alice", () => ({ email: { address: ALICE_EMAIL, verifiedAt: "2026-10-01T00:00:00Z" } }));
    prefs.update("Bob", () => ({ email: { address: BOB_EMAIL, verifiedAt: "2026-10-01T00:00:00Z" } }));
    (await import("node:fs")).appendFileSync(join(mailDir, "audit.jsonl"), `${JSON.stringify({ id: "a1", leagueId: "l1", sender: "Alice", at: "", scope: "all", notified: 2, queued: 2, skipped: { noConsent: 0, unverified: 0, suppressed: 0 } })}\n`);
    const mailDeps = { exportFor: (c: string) => ({ prefs: prefs.get(c), deliveries: outbox.forCoach(c).map((e) => ({ to: e.message?.to })) }), forgetCoach: (c: string) => { prefs.remove(c); outbox.forgetCoach(c); } };
    const files = new Map((await collectExport({ ...deps, mail: mailDeps }, "Alice")).map((f) => [f.name, String(f.content)]));
    const exported = JSON.parse(files.get("mail.json")!);
    expect(exported.prefs.email.address).toBe(ALICE_EMAIL);
    expect(exported.deliveries).toEqual([{ to: ALICE_EMAIL }]);
    expect(files.get("mail.json")).not.toContain(BOB_EMAIL);
    expect((await new PrivacyService({ ...deps, mail: mailDeps }).deleteCoach("Alice", "Alice", "self")).pending).toEqual([]);
    expect(prefs.get("Alice")).toEqual({});
    expect(prefs.get("Bob").email?.address).toBe(BOB_EMAIL);
    expect(outbox.forCoach("Alice")).toEqual([]);
    expect(outbox.forCoach("Bob")).toHaveLength(1);
    expect(readFileSync(join(mailDir, "audit.jsonl"), "utf8")).toContain(`"sender":"${P}"`);
    for (const re of [new RegExp(ALICE_EMAIL), /"Alice"/]) expect(filesContaining(mailDir, re), String(re)).toEqual([]);
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
      "organiser-requests.json", "results.json", "tabletop-matches.json", "team-library.json", "team-logos/library_t1.png", "team-logos/save_s1.png", "tournament-entries.json",
    ]);
    const text = (n: string) => String(files.get(n));
    const account = JSON.parse(text("account.json"));
    expect(account.identities.email).toBe(ALICE_EMAIL);
    expect(account.contact.phones).toEqual(["+00 0000 0001"]); // onboarding fields ride along (whole record)
    expect(account.consent.privacy.acceptedVersion).toBe("2026-10-31");
    expect(account.legacyOrganiser).toBe(true);
    // her own organiser requests only, without who decided (Bob's request, decided by her, is not hers)
    expect(JSON.parse(text("organiser-requests.json")).map((r: { id: string; decidedBy?: string }) => [r.id, r.decidedBy])).toEqual([["or000000000001", undefined], ["or000000000003", undefined]]);
    expect(account.sessions.length).toBeGreaterThan(0);
    expect(JSON.stringify(account.sessions)).not.toMatch(/[a-f0-9]{64}/);
    expect(JSON.parse(text("builder-saves.json"))).toEqual([{ id: "s1", name: "Green Orcs", sharedAt: "2026-10-01T00:00:00Z", body: {}, shared: true }]);
    expect(JSON.parse(text("team-library.json")).map((t: { teamId: string }) => t.teamId).sort()).toEqual(["t1", "t7"]); // own rows of a shared file too
    const t = JSON.parse(text("tournament-entries.json"));
    expect(t.entries.map((e: { id: string }) => e.id)).toEqual(["e1"]);
    expect(t.entries[0].nafNumber).toBe("1001"); // the NAF answer given at registration
    expect(account.consent.sharing).toEqual({ "tournament:t1": { fields: ["email"], at: "2026-10-01T00:00:00Z", version: "2026-10-31" } });
    expect(t.matches).toHaveLength(1);
    expect(t.managed.map((m: { id: string; role: string }) => `${m.id}:${m.role}`).sort()).toEqual(["t1:organiser", "t2:owner"]);
    // Tournament Series she created or co-organises (never another coach's series)
    expect(t.series.map((s: { id: string; role: string }) => `${s.id}:${s.role}`).sort()).toEqual(["sr1:creator", "sr2:organiser"]);
    expect(t.series[0].tournaments).toEqual([{ id: "t1", name: "Autumn Open" }]);
    // Result edits she made as an organiser (the activity log), never Bob's
    expect(t.resultEdits.map((e: { id: string; tournament: string; admin: boolean }) => `${e.id}:${e.tournament}:${e.admin}`)).toEqual(["ra1:Autumn Open:true"]);
    // Tournament awards to her or given by her (never one between two other coaches)
    expect(t.awards.map((a: { id: string; tournament: string }) => `${a.id}:${a.tournament}`)).toEqual(["ta1:Autumn Open", "ta2:Autumn Open"]);
    const leagues = JSON.parse(text("league-teams.json"));
    expect(leagues[0].role).toBe("organiser");
    expect(leagues[0].seasons[0].teams.map((x: { id: string }) => x.id)).toEqual(["green-orcs"]);
    // the result-override marker is the actor's own export only, never part of the fixture rows
    expect(leagues[0].seasons[0].fixtures[0].resultEdit).toBeUndefined();
    expect(leagues[0].seasons[0].resultEdits).toEqual([{ fixture: "f1", home: "Green Orcs", away: "Blue Elves", at: "2026-10-30T00:00:00.000Z" }]);
    // awards to Alice's account and by her, and the Hall of Fame entries she pinned; never the others'
    expect(leagues[0].awards.map((x: { id: string }) => x.id)).toEqual(["a-1", "a-2"]);
    expect(leagues[0].hallOfFame.map((x: { id: string }) => x.id)).toEqual(["p-1"]);
    expect(JSON.parse(text("tabletop-matches.json")).matches[0].events).toHaveLength(3);
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
    // organiser requests: hers stays for the audit under the pseudonym with every free-text field cleared; Bob's keeps
    // its text with her name replaced, and her name as the deciding admin becomes the pseudonym
    const orq = readJ(join(deps.stateDir, "organiser-requests.json")).requests;
    expect(orq[0]).toEqual({ id: "or000000000001", coach: P, run: "league", competition: "", region: "", note: "", links: [], status: "pending", createdAt: "2026-11-01T00:00:00.000Z" });
    expect(orq[2]).toMatchObject({ coach: P, decidedBy: P, note: "" }); // self-decided: both fields anonymised
    expect(orq[1]).toMatchObject({ coach: "Bob", decidedBy: P, note: `${P} can vouch for me.`, reason: `Ask ${P} again later.`, competition: "Bob Open" });
    const tf = readJ(join(deps.tournamentsDir, "tournaments.json"));
    expect(tf.version).toBe(4);
    expect(tf.tournaments.t1.organizerCoachIds).toEqual([]);
    // Tournament Series: her organiser seats go, the creator becomes the pseudonym, free text loses her name
    expect(tf.series.sr1).toMatchObject({ createdBy: P, organisers: ["Bob"], name: `${P} Cup Series`, description: `Run by ${P} for the valley.` });
    expect(tf.series.sr2).toMatchObject({ createdBy: "Bob", organisers: ["Bob"] });
    expect(tf.series.sr3).toMatchObject({ createdBy: "Carol", organisers: ["Carol"], name: "Carol Circuit" });
    expect(readJ(join(deps.stateDir, "leagues", "l1", "league.json")).organisers).toEqual(["Bob"]);
    // league awards and Hall of Fame pins: recipient account + display and the giver become the pseudonym; free text too
    const lgFile = readJ(join(deps.stateDir, "leagues", "l1", "league.json"));
    expect(lgFile.awards[0]).toMatchObject({ toCoach: P, toCoachId: P, toTeam: "Green Orcs", by: "Bob", note: `${P} never missed a deadline` });
    expect(lgFile.awards[1]).toMatchObject({ toCoach: "BobNaf", toCoachId: "Bob", by: P });
    expect(lgFile.awards[2]).toMatchObject({ toCoach: "Carol", by: "Bob" });
    expect(lgFile.hallOfFame[0]).toMatchObject({ by: P, text: `Most TDs in a season: ${P}, 31` });
    expect(lgFile.hallOfFame[1]).toMatchObject({ by: "Bob", awardId: "a-3" });
    // the pin to Alice's podium award still resolves after her deletion, now showing the pseudonym
    const seasonsNow = [readJ(join(deps.stateDir, "leagues", "l1", "seasons", "s1.json"))];
    const pinned = honoursView(lgFile, seasonsNow, undefined).pins.find((p) => p.id === "p-3")!;
    expect(pinned.resolved).toMatchObject({ title: "Overall Champion", team: "Green Orcs", coach: P });
    expect(seasonsNow[0].awards[0]).toMatchObject({ coach: P, coachId: P });
    // anonymised history (explicit fields; Discord ids dropped; the waiting-room lease dropped, never renamed)
    expect(tf.entrants.e1.coach).toEqual({ coachId: P, ffbCoachId: P, verifiedAt: "2026-10-01T00:00:00Z" });
    expect(tf.entrants.e2.coach.discordUserId).toBe(BOB_DISCORD);
    // The coach's NAF answer goes with the entry's identity; another coach's flag stays.
    expect(tf.entrants.e1.nafNumber).toBeUndefined();
    expect(tf.entrants.e1.nafSnapshot).toBeUndefined();
    expect(tf.entrants.e2.notNafMember).toBe(true);
    expect(tf.scheduledMatches.m1.home.coach.ffbCoachId).toBe(P);
    expect(tf.scheduledMatches.m1.away.coach.discordUserId).toBe(BOB_DISCORD);
    expect(tf.tournaments.t2.ownerCoachId).toBe(P); // a completed tournament keeps its record
    expect(tf.standings.t1.rows[0].coachId).toBe(P);
    expect(tf.tournaments.t1.news[0].body).toBe(`${P} wins the opener; well played Alicent.`);
    // Tournament awards: recipient and giver accounts become the pseudonym; free text loses her name; others untouched.
    expect(tf.tournaments.t1.awards[0]).toMatchObject({ toCoach: P, by: "Bob", toTeam: "Green Orcs", note: `${P} never complained` });
    expect(tf.tournaments.t1.awards[1]).toMatchObject({ toCoach: "Bob", by: P });
    expect(tf.tournaments.t1.awards[2]).toMatchObject({ toCoach: "Carol", by: "Bob" });
    // Organiser result edits: the acting account becomes the pseudonym and the reason loses her name; Bob's stay.
    expect(tf.tournaments.t1.activity[0]).toMatchObject({ by: P, reason: `${P} fixed a typo`, admin: true });
    expect(tf.tournaments.t1.activity[1]).toMatchObject({ by: "Bob" });
    expect(tf.scheduledMatches.m1.edited).toMatchObject({ byCoachId: P, reason: `Agreed with ${P} and Bob`, previous: { homeScore: 1, awayScore: 1 } });
    expect(Object.keys(tf.waitingPresence)).toEqual(["m1\u0000bob"]);
    const season = readJ(join(deps.stateDir, "leagues", "l1", "seasons", "s1.json"));
    expect(season.teams[0]).toMatchObject({ id: "green-orcs", name: "Green Orcs", coach: P, coachId: P });
    expect(season.teams[0].nafUser).toBeUndefined();
    expect(season.teams[1]).toMatchObject({ coach: "BobNaf", nafUser: "BobNaf" });
    expect(season.fixtures[0].home.coach).toBe(P);
    expect(season.fixtures[0].resultEdit.by).toBe(P);
    expect(season.participants[0].coach).toBe(P); // linked through the coach's team
    expect(season.phases[0].standings[0].coach).toBe(P); // unlinked row: display name learned from the linked team row
    expect(season.honours[0].rows[0]).toMatchObject({ name: "Grub", coach: P });
    expect(season.honours[1].rows.map((r: { name: string }) => r.name)).toEqual([P, "BobNaf"]); // a coach honour's name is the coach
    expect(season.news[0].by).toBe(P);
    expect(season.participants[1]).toMatchObject({ coach: "BobNaf", paid: true, flagsUpdated: { by: P } }); // Participants tab: who set the flags
    expect(season.podium).toMatchObject({ by: P, final: { champion: "green-orcs" } }); // who finished the season; team refs stay
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
    expect(naf["2002"].games[0].coachIds).toEqual(["2002", null]); // only Alice's slot; Bob keeps his link
    expect(new NafRecordStore(deps.stateDir).get("2002")!.games[0]!.coachIds).toEqual(["2002", null]);
    expect(readJ(join(deps.stateDir, "replay-moments", "g1.json")).teams.home.coach).toBe(P);
    expect(events).toBeGreaterThanOrEqual(1); // the "coach deleted" event for the derived caches
    expect(season.fixtures[0].fork.teams.home.coach).toBe(P);
    expect(season.fixtures[0].fork.generatedBy).toBe(P);
    expect(season.fixtures[0].fork.log[0]).toMatchObject({ by: P, text: `${P} generated the game for Bob` });
    expect(season.redraft.teams[0]).toMatchObject({ coach: P, coachId: P, submittedBy: P, rest: { by: P }, override: { by: "Bob" } });
    expect(season.redraft.teams[0].draft.team.coach).toBe(P);
    // Team page v2: status author, history (author and text) and injury authors, on the team and in every draft snapshot;
    // a draft applied after the deletion carries none of her name into the next season.
    expect(season.teams[0].statusChanged.by).toBe(P);
    expect(season.teams[0].history[0]).toMatchObject({ by: P, changes: [{ from: P, to: "Bob" }] });
    expect(season.teams[0].history[0].changes[0].what).not.toContain("Alice");
    expect(season.teams[0].players[0].injuries[0].by).toBe(P);
    for (const t of season.redraft.teams) {
      expect(t.draft.team.statusChanged.by).toBe(P);
      expect(t.draft.team.history[0].by).toBe(P);
      expect(JSON.stringify(t.draft.team)).not.toContain("Alice");
    }
    const next = { teams: [], participants: [] } as unknown as import("../src/leagues/types").SeasonRecord;
    for (const t of season.redraft.teams) applyDraftTeam(next, t.draft.team);
    expect(next.teams).toHaveLength(2);
    expect(JSON.stringify(next)).not.toContain("Alice");
    expect(season.redraft.log[0].text).toBe(`${P} submitted a draft`);
    expect(readFileSync(join(deps.tabletopDir, "events", "tm1.ndjson"), "utf8").split("\n")[0]).toContain(`"home":{"coach":"${P}"}`);
    expect(readJ(join(deps.tabletopDir, "journals", "tm1.json")).homeChain.target.coach).toBe(P);
    expect(readJ(join(deps.libraryDir, "shared.json")).map((t: { teamId: string }) => t.teamId)).toEqual(["t8"]);

    // running the anonymisation steps again changes nothing (idempotent; pseudonyms are never rewritten)
    const snapshot = walkFiles(root).filter((f) => f.endsWith(".json") || f.endsWith(".ndjson")).map((f) => [f, readFileSync(f, "utf8")] as const);
    const ctx = deleteContext(deps, { ...(await import("../src/privacy/collectors.js")).splitPlan({ jobId: "x".repeat(24), coachHash: "", coach: "Alice", coachNames: ["Alice"], displays: ["Alice Smith", "AliceNaf"], nafId: "1001", pseudonym: P, teamKeys: [], proxyKeys: [], actor: "self", at: "" } as never).stored, coach: "Alice", coachNames: ["Alice"], displays: ["Alice Smith", "AliceNaf"], nafId: "1001" } as never);
    for (const step of DELETE_STEPS.filter((x) => x.id.startsWith("anonymise-"))) await step.run(ctx);
    for (const [f, before] of snapshot) expect(readFileSync(f, "utf8"), f).toBe(before);

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

  it("two accounts that differ only by Unicode form: matching keeps them apart, and their shared avatar slot blocks the delete (P1-4)", async () => {
    await seed(root);
    const deps = depsFor(root);
    expect((await new PrivacyService(deps).deleteCoach(JOSE_NFC, JOSE_NFC, "self")).status).toBe("conflict");
    expect(readIdentities().coaches[JOSE_NFC.toLowerCase()]).toBeDefined();
    expect((await collectExport(deps, JOSE_NFC)).some((f) => f.name.startsWith("avatar."))).toBe(false);
    // without the colliding account the delete runs, and the other spelling's history is untouched
    const raw = readJ(join(root, "identities.json"));
    delete raw.coaches[JOSE_NFD.toLowerCase()];
    (await import("node:fs")).writeFileSync(join(root, "identities.json"), JSON.stringify(raw));
    expect((await new PrivacyService(deps).deleteCoach(JOSE_NFC, JOSE_NFC, "self")).status).toBe("deleted");
    const g3 = readJ(join(deps.stateDir, "tournament-results.json")).results.g3;
    expect([g3.home.coach, g3.away.coach]).toEqual([P, JOSE_NFD]);
  });

  it("NAF data is touched only through a VERIFIED NAF id; an editable nafId pointing at Bob deletes nothing of his", async () => {
    await seed(root);
    const deps = depsFor(root);
    await new PrivacyService(deps).deleteCoach("Carol", "Carol", "self"); // Carol has no NAF id
    expect(readJ(join(deps.stateDir, "naf-games.json")).coaches["2002"].games[0]).toMatchObject({ coaches: ["BobNaf", "AliceNaf"], coachIds: ["2002", "1001"] });
    const raw = readJ(join(root, "identities.json"));
    raw.coaches.alice.identities.nafId = "2002"; // edited, so the verified connection no longer matches
    (await import("node:fs")).writeFileSync(join(root, "identities.json"), JSON.stringify(raw));
    await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    const naf = readJ(join(deps.stateDir, "naf-games.json")).coaches;
    expect(naf["2002"]).toBeDefined();
    expect(naf["1001"]).toBeDefined(); // no verified link: the NAF cache is left alone
  });

  it("a display / NAF name equal to another account never touches that account's records (P1)", async () => {
    await seed(root, { aliceDisplayName: "Eve", aliceNafName: "Eve" });
    const deps = depsFor(root);
    const bobN = walkFiles(join(deps.stateDir, "notifications")).find((p) => p.endsWith("bob.json"))!;
    const n = readJ(bobN);
    n.notifications.push({ id: "n2", type: "organiser-message", title: "Eve beat Bob", body: "Eve won", link: "/app/", at: "2026-10-01T00:00:00.000Z", from: "Eve" });
    (await import("node:fs")).writeFileSync(bobN, JSON.stringify(n));
    await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    expect(readJ(join(deps.stateDir, "tournament-results.json")).results.g4.home.coach).toBe("Eve");
    expect(existsSync(join(deps.libraryDir, "eve.json"))).toBe(true);
    expect(readJ(bobN).notifications[1]).toMatchObject({ from: "Eve", title: "Eve beat Bob", body: "Eve won" });
  });

  it("removing the identity keeps every other record exactly as stored, unknown fields included", async () => {
    await seed(root);
    await new PrivacyService(depsFor(root)).deleteCoach("Alice", "Alice", "self");
    const raw = readJ(join(root, "identities.json"));
    expect(raw.coaches.alice).toBeUndefined();
    expect(raw.coaches.bob.contact).toEqual({ email: BOB_EMAIL, phones: ["+00 0000 0002"] });
    expect(raw.coaches.bob.consent.privacy.acceptedVersion).toBe("2026-10-31");
  });

  it("a shared library file loses only the coach's rows; a corrupt file or an unwritable sessions store fails the step", async () => {
    await seed(root);
    const deps = depsFor(root);
    // a store file that cannot be parsed: the plan cannot tell whose it is, so the delete does not start
    const fs = await import("node:fs");
    fs.writeFileSync(join(deps.builderSavesDir, "corrupt.json"), "{ not json");
    await expect(new PrivacyService(deps).deleteCoach("Alice", "Alice", "self")).rejects.toThrow();
    expect(readIdentities().coaches.alice).toBeDefined();
    fs.rmSync(join(deps.builderSavesDir, "corrupt.json"));
    mkdirSync(join(root, "sessions.json"), { recursive: true }); // the sessions store cannot be written
    const out = await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    expect(out.pending).toEqual(["sessions"]); // the first step failed: nothing after it ran
    expect(readJ(join(deps.libraryDir, "shared.json")).map((t: { teamId: string }) => t.teamId)).toEqual(["t7", "t8"]);
    fs.rmSync(join(root, "sessions.json"), { recursive: true });
    expect(await new PrivacyService(deps).resumeAll()).toEqual([]);
    expect(readJ(join(deps.libraryDir, "shared.json")).map((t: { teamId: string }) => t.teamId)).toEqual(["t8"]);
  });

  it("a deleted Discord account is refused at sign-in for 24 h; the map is keyed by the operator key only", async () => {
    await seed(root);
    const deps = depsFor(root);
    await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    expect(isRecentlyDeleted(deps.stateDir, TEST_MAP_KEY, ALICE_DISCORD)).toBe(true);
    expect(isRecentlyDeleted(deps.stateDir, TEST_MAP_KEY, BOB_DISCORD)).toBe(false);
    expect(isRecentlyDeleted(deps.stateDir, TEST_MAP_KEY, ALICE_DISCORD, Date.now() + 25 * 3_600_000)).toBe(false);
    expect(deletedPseudonymFor(deps.stateDir, "another-key-0123456789abcdef0123456789", "alice")).toBeUndefined();
    expect((await new PrivacyService({ ...deps, mapKey: undefined }).deleteCoach("Bob", "Bob", "self")).status).toBe("unavailable");
  });

  it("NAF and replay writers store a deleted coach under the pseudonym", async () => {
    await seed(root);
    const deps = depsFor(root);
    await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    const { deletedPseudonymForNaf } = await import("../src/privacy/state.js");
    setNafIdFilter((id) => deletedPseudonymForNaf(deps.stateDir, TEST_MAP_KEY, id));
    new NafRecordStore(deps.stateDir).put("2002", "BobNaf", [{ date: "2026-02-01", tournament: "Y", variant: "BB", coaches: ["BobNaf", "AliceNaf"], coachIds: ["2002", "1001"], races: ["Elf", "Orc"], score: [0, 1] }]);
    new NafRecordStore(deps.stateDir).put("1001", "AliceNaf", []);
    const naf = readJ(join(deps.stateDir, "naf-games.json")).coaches;
    expect(naf["2002"].games[0].coaches).toEqual(["BobNaf", P]);
    expect(naf["1001"]).toBeUndefined();
    setReplayCoachFilter((c) => deletedPseudonymFor(deps.stateDir, TEST_MAP_KEY, normalizeFfbCoachId(c)));
    new ReplayMomentStore(deps.stateDir).put({ gameId: "77", status: "ready", readAt: "", commands: 0, truncated: false, teams: { home: { teamId: "t1", name: "Green Orcs", coach: "Alice" }, away: { teamId: "t2", name: "Blue Elves", coach: "Bob" } }, moments: [] } as never);
    expect(readJ(join(deps.stateDir, "replay-moments", "77.json")).teams.home.coach).toBe(P);
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
    expect(deletedPseudonymFor(deps.stateDir, TEST_MAP_KEY, "alice")).toBe(P);
    expect(deletedPseudonymFor(deps.stateDir, TEST_MAP_KEY, "bob")).toBeUndefined();
    setResultCoachFilter((c) => deletedPseudonymFor(deps.stateDir, TEST_MAP_KEY, normalizeFfbCoachId(c)));
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
    expect(out.pending).toEqual(["notifications"]); // halted there
    expect(readIdentities().coaches.alice).toBeDefined();
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
    expect(svc.jobs().open).toEqual([{ jobId, pseudonym: P, pending: ["fork-account", "final-sweep"], startedAt: expect.any(String), stuck: false }]);
    t += (JOB_RETRY_DAYS - 1) * 86_400_000;
    expect(await svc.resumeAll()).toEqual([jobId]);
    t += 2 * 86_400_000;
    // out of retries: STUCK. Never retried automatically, but the journal, key and fence stay until an admin acts
    expect(await svc.resumeAll()).toEqual([jobId]);
    expect(listJobs(deps.stateDir)).toEqual([jobId]);
    expect(walkFiles(join(deps.stateDir, "privacy", "keys"))).toHaveLength(1);
    expect(isCoachFenced("Alice")).toBe(true);
    expect(svc.jobs().open).toEqual([{ jobId, pseudonym: P, pending: ["fork-account", "final-sweep"], startedAt: expect.any(String), stuck: true }]);
    expect(svc.jobs().failed).toEqual([{ jobId, pseudonym: P, pending: ["fork-account", "final-sweep"], startedAt: expect.any(String), abandonedAt: expect.any(String) }]);
    expect(await svc.resumeAll()).toEqual([jobId]); // still stuck, nothing ran
    expect(readAudit(deps.stateDir)).toEqual([]);
    // the admin closes it after removing the fork account by hand: now the journal, key and fence go, audited
    expect(await svc.closeJob(jobId!, "Root")).toEqual({ ok: true });
    expect(listJobs(deps.stateDir)).toEqual([]);
    expect(walkFiles(join(deps.stateDir, "privacy", "keys"))).toEqual([]);
    expect(readAudit(deps.stateDir)).toEqual([{ at: expect.any(String), actor: "self; closed by admin:Root", pseudonym: P, jobId }]);
  });

  it("the fork step stays pending while the fork is unreachable; the audit is written once even if it already exists (P2-16)", async () => {
    await seed(root);
    const deps = depsFor(root);
    let up = false;
    const calls: string[] = [];
    const svc = new PrivacyService({ ...deps, disableForkAccount: async (coach) => { calls.push(coach); if (!up) throw new Error("connect ECONNREFUSED"); } });
    const out = await svc.deleteCoach("Alice", "Alice", "self");
    expect(out.pending).toEqual(["fork-account"]);
    expect(readIdentities().coaches.alice).toBeUndefined(); // the fork step is last: nothing else waits on it
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
      sessionCoach: "Alice", jobId: "0123456789abcdef01234567", pseudonym: "Deleted coach #9", actor: "self", now: new Date(), mapKey: TEST_MAP_KEY,
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
