import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { generateTournamentPairings } from "../src/tournaments/pairing.js";
import { migrateTournamentData, TournamentStore } from "../src/tournaments/store.js";
import {
  checkTournamentSubmission, UNCHECKABLE_LIBRARY, UNCHECKABLE_SECRET_LEAGUE, type SubmissionCheckDeps,
} from "../src/tournaments/submissionCheck.js";
import { createSave } from "../src/teamBuilderSaves.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord, TournamentRecord, TournamentSubmission } from "../src/tournaments/types.js";

// Review fixes on the phase 2/3 tournament routes: per-tournament read scope, redaction, one package-aware
// submission path, ruleset changes voiding checks, unlock and override rules, standby entrants in standings.

const roots: string[] = [];
const now = new Date("2026-10-29T12:00:00.000Z");
const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const otherTo: TournamentApiIdentity = { coach: "Thrawn", organizer: true, admin: false };
const coach = (name: string): TournamentApiIdentity => ({ coach: name, organizer: false, admin: false });

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tmp = (prefix: string): string => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };

const NAMES = ["Alice", "Bob", "Cy", "Dee"];
function stubValidate(coachName: string, ref: string, packageName: string, at: Date): TournamentSubmission {
  const ok = ref !== "save:bad";
  return {
    saveId: ref, revision: "r1", submittedAt: at.toISOString(), teamName: `${coachName} XI`,
    snapshot: { rosterId: "orc", picks: [] },
    validation: { ok, problems: ok ? [] : ["Too many big guys."], checkedAt: at.toISOString(), packageName },
  };
}
function deps(store: TournamentStore, over: Partial<TournamentApiDeps> = {}): TournamentApiDeps {
  return {
    store,
    packageExists: (name) => name === "Rules" || name === "Rules2",
    teamOwner: (teamId) => NAMES.find((n) => `team-${n.toLowerCase()}` === teamId),
    teamBuild: (teamId) => ({ teamName: `${teamId} live`, race: "Orc" }),
    validateSubmission: stubValidate,
    registeredCoach: (id) => [...NAMES, "Veers", "Thrawn"].find((n) => n.toLowerCase() === id.trim().toLowerCase()),
    coachRating: (name) => ({ Alice: 1700, Bob: 1600, Cy: 1500, Dee: 1400 })[name],
    now: () => now,
    ...over,
  };
}
const call = (store: TournamentStore, method: string, path: string, auth?: TournamentApiIdentity, body?: unknown, over: Partial<TournamentApiDeps> = {}) =>
  tournamentApi(method, path, new URLSearchParams(), auth, body, deps(store, over));

function event(store: TournamentStore, ownerCoach = "Veers", names = NAMES): TournamentRecord {
  const t = store.createTournament({ name: `${ownerCoach} Open`, packageName: "Rules", maxPlayers: 8, format: "swiss", organizerCoachId: ownerCoach, roundCount: 3 }, now);
  for (const name of names) {
    store.registerEntrant(t.id, { coachId: name, ffbCoachId: name, discordUserId: `discord-${name.toLowerCase()}`, verifiedAt: now.toISOString() }, `team-${name.toLowerCase()}`, now);
  }
  return store.tournament(t.id)!;
}
const entrantOf = (store: TournamentStore, id: string, name: string) => store.entrants(id).find((e) => e.coach.ffbCoachId === name)!;
const buildPath = (t: TournamentRecord, e: TournamentEntrantRecord) => `/api/tournaments/${t.id}/entrants/${encodeURIComponent(e.id)}/build`;

async function startedWithRound(store: TournamentStore, ownerCoach = "Veers") {
  const t = event(store, ownerCoach);
  const as = { coach: ownerCoach, organizer: true, admin: false };
  await call(store, "POST", `/api/tournaments/${t.id}/submissions`, coach("Alice"), { saveId: "save:bad" });
  await call(store, "POST", `/api/tournaments/${t.id}/start`, as, { force: true });
  await call(store, "POST", `/api/tournaments/${t.id}/rounds`, as, {});
  return store.tournament(t.id)!;
}

describe("build read scope and redaction", () => {
  it("the global organiser flag does not open another tournament's rosters", async () => {
    const store = new TournamentStore(tmp("bbtv-v4r-"));
    const mine = await startedWithRound(store, "Thrawn");
    const theirs = await startedWithRound(store, "Veers");
    // Thrawn organises his own event and may read it; Veers's event stays closed to him.
    expect((await call(store, "GET", buildPath(mine, entrantOf(store, mine.id, "Cy")), otherTo))?.status).toBe(200);
    expect(await call(store, "GET", buildPath(theirs, entrantOf(store, theirs.id, "Cy")), otherTo)).toMatchObject({ status: 403 });
    expect((await call(store, "GET", buildPath(theirs, entrantOf(store, theirs.id, "Cy")), owner))?.status).toBe(200);
  });

  it("the opponent gets validity only; the coach and managers get the problems list", async () => {
    const store = new TournamentStore(tmp("bbtv-v4r-"));
    const t = await startedWithRound(store);
    // Elo seeding: Alice 1, Bob 2, Cy 3, Dee 4 -> Alice-Cy, Bob-Dee.
    const alice = entrantOf(store, t.id, "Alice");
    const asOpponent = (await call(store, "GET", buildPath(t, alice), coach("Cy")))!;
    expect(asOpponent.status).toBe(200);
    expect((asOpponent.body as { submission: Record<string, unknown> }).submission).toMatchObject({ valid: false });
    expect((asOpponent.body as { submission: Record<string, unknown> }).submission).not.toHaveProperty("problems");
    expect(JSON.stringify(asOpponent.body)).not.toContain("Too many big guys.");
    expect((await call(store, "GET", buildPath(t, alice), coach("Alice")))?.body).toMatchObject({ submission: { problems: ["Too many big guys."] } });
    expect((await call(store, "GET", buildPath(t, alice), owner))?.body).toMatchObject({ submission: { problems: ["Too many big guys."] } });
  });

  it("mixed-case coach ids: the opponent and the coach are matched case-insensitively", async () => {
    const store = new TournamentStore(tmp("bbtv-v4r-"));
    const t = await startedWithRound(store);
    expect((await call(store, "GET", buildPath(t, entrantOf(store, t.id, "Alice")), coach("cY")))?.status).toBe(200);
    expect((await call(store, "GET", buildPath(t, entrantOf(store, t.id, "Alice")), coach("ALICE")))?.status).toBe(200);
    expect(await call(store, "GET", buildPath(t, entrantOf(store, t.id, "Alice")), coach("bob"))).toMatchObject({ status: 403 });
  });

  it("a previous round's opponent may no longer read the team", async () => {
    const store = new TournamentStore(tmp("bbtv-v4r-"));
    const t = await startedWithRound(store);
    for (const m of store.matches(t.id)) store.recordResult(m.id, { expectedRevision: m.revision, homeScore: 1, awayScore: 0 }, now);
    await call(store, "POST", `/api/tournaments/${t.id}/rounds`, owner, {});
    const alice = entrantOf(store, t.id, "Alice");
    const r2 = store.matches(t.id).find((m) => m.roundNumber === 2 && (m.home.entrantId === alice.id || m.away?.entrantId === alice.id))!;
    const now2 = r2.home.entrantId === alice.id ? r2.away!.coach.ffbCoachId : r2.home.coach.ffbCoachId;
    expect(now2).not.toBe("Cy");
    expect(await call(store, "GET", buildPath(t, alice), coach("Cy"))).toMatchObject({ status: 403 });
    expect((await call(store, "GET", buildPath(t, alice), coach(now2)))?.status).toBe(200);
  });

  it("fixtures the viewer does not play in carry no Discord ids, launch or challenge data", async () => {
    const store = new TournamentStore(tmp("bbtv-v4r-"));
    const t = await startedWithRound(store);
    const body = (await call(store, "GET", `/api/tournaments/${t.id}`, coach("Alice")))!.body as { scheduledMatches: Array<Record<string, unknown>> };
    expect(body.scheduledMatches).toHaveLength(2);
    const other = body.scheduledMatches.find((m) => (m.home as { coach: { ffbCoachId: string } }).coach.ffbCoachId === "Bob")!;
    const text = JSON.stringify(other);
    expect(text).not.toContain("discord");
    for (const key of ["launch", "challenger", "routeMetadata", "waitingCoachIds", "canLaunch"]) expect(other).not.toHaveProperty(key);
    expect(other).toMatchObject({ roundNumber: 1, status: "scheduled", away: { coach: { ffbCoachId: "Dee" } } });
    const own = body.scheduledMatches.find((m) => m !== other)!;
    expect(own).toHaveProperty("canLaunch");
  });
});

describe("one package-aware submission path (real check, no stub)", () => {
  const coachName = "Alice";
  function checkDeps(savesDir: string, calls: string[] = []): SubmissionCheckDeps {
    return {
      savesDir,
      libraryOwner: (teamId) => (teamId.startsWith("team-alice") ? "alice" : undefined),
      libraryTeam: (teamId) => ({ teamName: `${teamId} name`, race: "Orc", teamValue: 1000 }),
      packageRevision: () => "rev-7",
      isSecretLeague: (id) => /^\d+$/.test(id),
      validateBody: (body, packageName) => { calls.push(`${String(body.packageName)}|${packageName}`); return { ok: true, problems: [] }; },
    };
  }

  it("a library team without a Team Builder sheet is stored as cannot be checked", () => {
    const dir = tmp("bbtv-v4r-saves-");
    const result = checkTournamentSubmission(checkDeps(dir), coachName, "library:team-alice", "Rules", now);
    expect(result).toMatchObject({ saveId: "library:team-alice", validation: { ok: false, problems: [UNCHECKABLE_LIBRARY], packageName: "Rules", packageRevision: "rev-7" } });
    expect(checkTournamentSubmission(checkDeps(dir), coachName, "library:team-bob", "Rules", now)).toMatchObject({ status: 400 });
  });

  it("a Secret League sheet is never budget-checked from its own body: unverified, the validator is not run", () => {
    const dir = tmp("bbtv-v4r-saves-");
    const calls: string[] = [];
    const sl = createSave({ dir, raceNameFor: () => "Snotlings" }, coachName, { name: "SL team", body: { rosterId: "4021", coach: coachName, teamName: "SL team", picks: [], budget: 5_000_000 } });
    expect(sl.ok).toBe(true);
    const id = (sl as { save: { id: string } }).save.id;
    const result = checkTournamentSubmission(checkDeps(dir, calls), coachName, `save:${id}`, "Rules", now);
    expect(result).toMatchObject({ saveId: `save:${id}`, validation: { ok: false, problems: [UNCHECKABLE_SECRET_LEAGUE] } });
    expect(calls).toEqual([]);
  });

  it("a base-roster sheet is validated against the tournament's package, not the one it was built for", () => {
    const dir = tmp("bbtv-v4r-saves-");
    const calls: string[] = [];
    const save = createSave({ dir, raceNameFor: () => "Orc" }, coachName, { name: "Orcs", body: { rosterId: "orc", packageName: "Other", coach: coachName, teamName: "Orcs", picks: [] } });
    const id = (save as { save: { id: string } }).save.id;
    expect(checkTournamentSubmission(checkDeps(dir, calls), coachName, `save:${id}`, "Rules", now)).toMatchObject({ validation: { ok: true, packageName: "Rules" } });
    expect(calls).toEqual(["Rules|Rules"]);
    // Another coach cannot reach Alice's save.
    expect(checkTournamentSubmission(checkDeps(dir), "Bob", `save:${id}`, "Rules", now)).toMatchObject({ status: 404 });
  });
});

describe("lock, start and ruleset changes", () => {
  it("a throwing validator leaves nothing locked (lock and start)", async () => {
    const store = new TournamentStore(tmp("bbtv-v4r-"));
    const t = event(store);
    const boom = { validateSubmission: () => { throw new Error("compose exploded"); } };
    expect(await call(store, "POST", `/api/tournaments/${t.id}/lock-rosters`, owner, undefined, boom)).toMatchObject({ status: 503 });
    expect(await call(store, "POST", `/api/tournaments/${t.id}/start`, owner, { force: true }, boom)).toMatchObject({ status: 503 });
    expect(store.tournament(t.id)).toMatchObject({ status: "draft" });
    expect(store.tournament(t.id)!.rostersLockedAt).toBeUndefined();
    expect(store.entrants(t.id).every((e) => !e.flags?.frozen && !e.submission)).toBe(true);
  });

  it("changing the ruleset after a lock voids every check and the lock; Start then re-checks", async () => {
    const store = new TournamentStore(tmp("bbtv-v4r-"));
    const t = event(store, "Veers", ["Alice", "Bob"]);
    await call(store, "POST", `/api/tournaments/${t.id}/lock-rosters`, owner);
    const alice = entrantOf(store, t.id, "Alice");
    await call(store, "PATCH", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(alice.id)}`, owner, { flags: { rosterVerified: true } });
    expect(await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { packageName: "Rules2" })).toMatchObject({ status: 200 });
    expect(store.tournament(t.id)!.rostersLockedAt).toBeUndefined();
    const after = entrantOf(store, t.id, "Alice");
    expect(after.rosterVerifiedOverride).toBeUndefined();
    expect(after.flags).toMatchObject({ rosterVerified: false, frozen: false });
    expect(after.submission?.validation.problems[0]).toContain("ruleset changed");
    // Start takes a fresh snapshot against Rules2 (the stub passes) and starts.
    expect(await call(store, "POST", `/api/tournaments/${t.id}/start`, owner, {})).toMatchObject({ status: 200 });
    expect(entrantOf(store, t.id, "Alice").submission?.validation.packageName).toBe("Rules2");
  });

  it("a package file edited after the lock (revision moved) blocks Start without force", async () => {
    const store = new TournamentStore(tmp("bbtv-v4r-"));
    const t = event(store, "Veers", ["Alice", "Bob"]);
    const v1 = { validateSubmission: (c: string, r: string, p: string, at: Date) => ({ ...stubValidate(c, r, p, at), validation: { ...stubValidate(c, r, p, at).validation, packageRevision: "v1" } }), packageRevision: () => "v1" };
    await call(store, "POST", `/api/tournaments/${t.id}/lock-rosters`, owner, undefined, v1);
    const refused = await call(store, "POST", `/api/tournaments/${t.id}/start`, owner, {}, { ...v1, packageRevision: () => "v2" });
    expect(refused?.status).toBe(409);
    expect(JSON.stringify(refused?.body)).toContain("The ruleset changed after this roster was checked");
    expect(store.tournament(t.id)).toMatchObject({ status: "draft" });
    expect(await call(store, "POST", `/api/tournaments/${t.id}/start`, owner, {}, v1)).toMatchObject({ status: 409 });
    expect(await call(store, "POST", `/api/tournaments/${t.id}/start`, owner, { force: true }, { ...v1, packageRevision: () => "v2" })).toMatchObject({ status: 200 });
  });

  it("unlock is refused once the tournament has started, even before round 1", async () => {
    const store = new TournamentStore(tmp("bbtv-v4r-"));
    const t = event(store, "Veers", ["Alice", "Bob"]);
    await call(store, "POST", `/api/tournaments/${t.id}/start`, owner, {});
    expect(store.rounds(t.id)).toHaveLength(0);
    expect(await call(store, "POST", `/api/tournaments/${t.id}/unlock-rosters`, owner)).toMatchObject({ status: 409 });
    expect(store.tournament(t.id)!.rostersLockedAt).toBeTruthy();
  });

  it("a resubmitted roster clears the hand verification, so an invalid team cannot start without force", async () => {
    const store = new TournamentStore(tmp("bbtv-v4r-"));
    const t = event(store, "Veers", ["Alice", "Bob"]);
    const alice = entrantOf(store, t.id, "Alice");
    await call(store, "POST", `/api/tournaments/${t.id}/submissions`, coach("Alice"), { saveId: "save:bad" });
    await call(store, "PATCH", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(alice.id)}`, owner, { flags: { rosterVerified: true } });
    expect(entrantOf(store, t.id, "Alice").flags?.rosterVerified).toBe(true);
    await call(store, "POST", `/api/tournaments/${t.id}/submissions`, coach("Alice"), { saveId: "save:bad" });
    expect(entrantOf(store, t.id, "Alice").rosterVerifiedOverride).toBeUndefined();
    expect(entrantOf(store, t.id, "Alice").flags?.rosterVerified).toBe(false);
    expect(await call(store, "POST", `/api/tournaments/${t.id}/start`, owner, {})).toMatchObject({ status: 409 });
  });
});

describe("migration keeps a fully populated v3 file", () => {
  it("every v3 value survives the v4 migration unchanged; only the v4 defaults are added", () => {
    const at = "2026-09-01T10:00:00.000Z";
    const c = (n: string) => ({ coachId: n.toLowerCase(), ffbCoachId: n, discordUserId: `d-${n}`, verifiedAt: at });
    const v3 = {
      version: 3,
      tournaments: {
        cup: {
          id: "cup", name: "Full Cup", status: "active", format: "swiss", packageName: "Rules", maxPlayers: 4, roundCount: 2, roundCountExplicit: true,
          currentRound: 1, tiebreakers: ["sonnebornBerger", "touchdownDifferential", "casualtyDifferential"], points: { win: 2, draw: 1, loss: 0, bye: 2 },
          startsAt: "2026-09-02T10:00:00Z", turnTimer: { enforced: "required", seconds: 180 }, inducementOptIns: ["canopicJar"],
          organizerCoachId: "Veers", createdAt: at, updatedAt: at,
        },
      },
      entrants: {
        "cup:entrant:1": { id: "cup:entrant:1", tournamentId: "cup", seed: 1, coach: c("Alice"), teamId: "t-a", registeredAt: at },
        "cup:entrant:2": { id: "cup:entrant:2", tournamentId: "cup", seed: 2, coach: c("Bob"), teamId: "t-b", registeredAt: at, droppedAt: at },
      },
      rounds: { "cup:round:1": { id: "cup:round:1", tournamentId: "cup", number: 1, status: "completed", scheduledMatchIds: ["cup:round:1:match:1"], createdAt: at, completedAt: at } },
      standings: { cup: { tournamentId: "cup", matchRevision: "x", rows: [], calculatedAt: at } },
      scheduledMatches: {
        "cup:round:1:match:1": {
          id: "cup:round:1:match:1", tournamentId: "cup", roundId: "cup:round:1", roundNumber: 1,
          home: { entrantId: "cup:entrant:1", coach: c("Alice"), teamId: "t-a" }, away: { entrantId: "cup:entrant:2", coach: c("Bob"), teamId: "t-b" },
          status: "completed", revision: 3,
          launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", gameName: "g", gameId: "77", lastAttemptAt: at, launchedAt: at, retryCount: 1 },
          result: { homeScore: 2, awayScore: 1, homeCasualties: 1, awayCasualties: 0, reportedAt: at, opId: "op-1" }, createdAt: at, updatedAt: at,
        },
      },
      waitingPresence: { "k": { scheduledMatchId: "cup:round:1:match:1", coachId: "Alice", renewedAt: at, expiresAt: at } },
    };
    const before = structuredClone(v3);
    const migrated = migrateTournamentData(v3) as unknown as Record<string, unknown>;
    expect(v3).toEqual(before); // the input object is not mutated
    const subset = (orig: unknown, got: unknown, path: string): void => {
      if (orig && typeof orig === "object" && !Array.isArray(orig)) {
        for (const [key, value] of Object.entries(orig)) {
          if (path === "" && key === "version") continue;
          subset(value, (got as Record<string, unknown>)?.[key], `${path}.${key}`);
        }
      } else {
        expect(got, path).toEqual(orig);
      }
    };
    subset(v3, migrated, "");
    expect(migrated.version).toBe(4);
    const t = (migrated.tournaments as Record<string, TournamentRecord>).cup!;
    expect(t).toMatchObject({ ownerCoachId: "Veers", organizerCoachIds: [], pairingSystem: "eloSeeded", seedingMode: "elo" });
  });
});

describe("pairing edge cases", () => {
  const points = { win: 3, draw: 1, loss: 0, bye: 3 };
  const e = (i: number, over: Partial<TournamentEntrantRecord> = {}): TournamentEntrantRecord => ({
    id: `e${i}`, tournamentId: "cup", seed: i, coach: { coachId: `c${i}`, ffbCoachId: `C${i}`, verifiedAt: now.toISOString() },
    teamId: `t${i}`, registeredAt: now.toISOString(), ...over,
  });
  const done = (home: number, away: number, hs: number, as: number): ScheduledMatchRecord => ({
    id: `m${home}${away}`, tournamentId: "cup", roundId: "r1", roundNumber: 1,
    home: { entrantId: `e${home}`, coach: e(home).coach, teamId: `t${home}` }, away: { entrantId: `e${away}`, coach: e(away).coach, teamId: `t${away}` },
    status: "completed", revision: 2, launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
    result: { homeScore: hs, awayScore: as, reportedAt: now.toISOString() }, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  });

  it("a standby entrant keeps their opponents' results in the pairing standings (every system)", () => {
    const field = [1, 2, 3, 4].map((i) => e(i));
    const r1 = [done(1, 2, 2, 0), done(3, 4, 1, 0)];
    const eligible = (x: TournamentEntrantRecord) => x.id !== "e2";
    for (const system of ["eloSeeded", "dutch", "monrad"] as const) {
      const pairs = generateTournamentPairings("swiss", 2, field, r1, points, ["touchdownDifferential"], { system, eligible });
      const text = pairs.map((p) => (p.awayEntrantId ? [p.homeEntrantId, p.awayEntrantId].sort().join("-") : `${p.homeEntrantId}:bye`));
      // e1 kept the win over the standby e2 (3 points) and meets the other winner, e3; e4 takes the bye.
      expect(text, system).toContain("e1-e3");
      expect(text, system).toContain("e4:bye");
      expect(text.join(" "), system).not.toContain("e2");
    }
  });

  it("0, 1 and 2 entrants pair cleanly in every system", () => {
    for (const system of ["eloSeeded", "dutch", "monrad"] as const) {
      expect(generateTournamentPairings("swiss", 1, [], [], points, ["seed"], { system }), system).toEqual([]);
      expect(generateTournamentPairings("swiss", 1, [e(1)], [], points, ["seed"], { system }), system).toEqual([{ homeEntrantId: "e1" }]);
      expect(generateTournamentPairings("swiss", 1, [e(1), e(2)], [], points, ["seed"], { system }), system).toEqual([{ homeEntrantId: "e1", awayEntrantId: "e2" }]);
    }
  });
});
