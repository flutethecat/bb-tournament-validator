// Creation wizards v2, review fixes (Sol P2s): enforced house-rule changes make roster checks stale (like a package
// change) and /start refuses a check made under other house rules; the stat caps run as an extra validator rule, so a
// zero cap holds against the package's default allowance and a cap never loosens an inherited limit. Isolated state
// dirs per test (laws §C14).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPosition, findRoster, ALL_RULES } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { houseRulesStamp, parseHouseRules, type HouseRules } from "../src/competition/houseRules.js";
import { applyHouseRulesToPackage, HOUSE_RULE_STAT_RULE_ID, houseRuleStatRule, houseRuleValidatorRules } from "../src/competition/packageOverlay.js";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { RulesChangeCoalescer } from "../src/competition/rulesChange.js";
import { HOUSE_RULES_CHANGED_PROBLEM, TournamentStore } from "../src/tournaments/store.js";
import type { TournamentSubmission } from "../src/tournaments/types.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const now = new Date("2026-11-02T12:00:00.000Z");
const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const TEAMS: Record<string, string> = { "team-alice": "Alice", "team-bob": "Bob" };

/** The validator stub: every roster passes; it stamps the house rules it was given unless `ignoreHouseRules`. */
function deps(store: TournamentStore, ignoreHouseRules = false): TournamentApiDeps {
  return {
    store, now: () => now, packageExists: (n) => n === "Rules", teamOwner: (id) => TEAMS[id],
    teamBuild: (id) => (TEAMS[id] ? { teamName: `${TEAMS[id]} XI`, race: "Orc" } : undefined),
    registeredCoach: (n) => n,
    revalidateSubmission: (_coach, submission, packageName, at, houseRules) => ({
      ...submission,
      validation: { ok: true, problems: [], checkedAt: at.toISOString(), packageName, ...(!ignoreHouseRules && houseRulesStamp(houseRules) ? { houseRulesKey: houseRulesStamp(houseRules) } : {}) },
    }),
    rulesNotices: new RulesChangeCoalescer(0, () => undefined),
    validateSubmission: (coach, ref, packageName, at, houseRules): TournamentSubmission => ({
      saveId: ref, revision: "r1", submittedAt: at.toISOString(), teamName: `${coach} XI`, race: "Orc", snapshot: { coach },
      validation: {
        ok: true, problems: [], checkedAt: at.toISOString(), packageName,
        ...(!ignoreHouseRules && houseRulesStamp(houseRules) ? { houseRulesKey: houseRulesStamp(houseRules) } : {}),
      },
    }),
  };
}
const call = (store: TournamentStore, method: string, path: string, body?: unknown, ignore = false) =>
  tournamentApi(method, path, new URLSearchParams(), owner, body, deps(store, ignore));

function draftWithEntries(houseRules?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "bbtv-hr-fix-"));
  roots.push(root);
  const store = new TournamentStore(root);
  const t = store.createTournament({
    name: "Spike Open", packageName: "Rules", maxPlayers: 8, format: "swiss", organizerCoachId: "Veers", roundCount: 3,
    ...(houseRules ? { settings: { houseRules: parseHouseRules(houseRules, "tournament") } } : {}),
  }, now);
  for (const name of ["Alice", "Bob"]) store.registerEntrant(t.id, { coachId: name, ffbCoachId: name, verifiedAt: now.toISOString() }, `team-${name.toLowerCase()}`, now);
  return { store, id: t.id };
}

describe("house-rule changes and roster approval", () => {
  it("banning Prayers to Nuffle after the lock lifts the lock and re-checks every roster at once (creation wizards v2)", async () => {
    const { store, id } = draftWithEntries();
    expect((await call(store, "POST", `/api/tournaments/${id}/lock-rosters`))?.status).toBe(200);
    expect(store.tournament(id)!.rostersLockedAt).toBeDefined();
    expect(store.entrants(id).every((e) => e.flags?.rosterVerified)).toBe(true);
    // Registered coaches: the change needs the organiser's message.
    expect((await call(store, "PATCH", `/api/tournaments/${id}`, { houseRules: { prayers: { mode: "banned" } } }))?.status).toBe(400);
    const res = await call(store, "PATCH", `/api/tournaments/${id}`, { houseRules: { prayers: { mode: "banned" } }, changeMessage: "Prayers to Nuffle are banned now." });
    expect(res?.status, JSON.stringify(res?.body)).toBe(200);
    expect(store.tournament(id)!.rostersLockedAt).toBeUndefined();
    const stamp = houseRulesStamp(parseHouseRules({ prayers: { mode: "banned" } }, "tournament"));
    for (const e of store.entrants(id)) {
      // Re-validated straight away under the new house rules (never left on the "changed" placeholder).
      expect(e.submission?.validation.problems).not.toContain(HOUSE_RULES_CHANGED_PROBLEM);
      expect(e.submission?.validation.houseRulesKey).toBe(stamp);
    }
    // A fresh start re-checks under the new house rules (the stamp now matches) and goes through.
    const started = await call(store, "POST", `/api/tournaments/${id}/start`, {});
    expect(started?.status, JSON.stringify(started?.body)).toBe(200);
    expect(store.entrants(id)[0]!.submission?.validation.houseRulesKey).toBe(houseRulesStamp(parseHouseRules({ prayers: { mode: "banned" } }, "tournament")));
  });
  it("a display-only change (Brawling Brutes, a PtN cost) keeps the lock and the checks", async () => {
    const { store, id } = draftWithEntries();
    await call(store, "POST", `/api/tournaments/${id}/lock-rosters`);
    await call(store, "PATCH", `/api/tournaments/${id}`, { houseRules: { brawlingBrutes: "off", prayers: { mode: "cost", costK: 50 } }, changeMessage: "Brutes off and Prayers cost 50k." });
    expect(store.tournament(id)!.rostersLockedAt).toBeDefined();
    expect(store.entrants(id).every((e) => e.submission?.validation.ok)).toBe(true);
  });
  it("/start refuses (without force) a check made under other enforced house rules", async () => {
    const { store, id } = draftWithEntries({ maxStatIncreasesPlayer: 0 });
    // The checks were made without the house rules (a stale stamp): the start must not take them as valid.
    expect((await call(store, "POST", `/api/tournaments/${id}/lock-rosters`, undefined, true))?.status).toBe(200);
    const refused = await call(store, "POST", `/api/tournaments/${id}/start`, {});
    expect(refused?.status).toBe(409);
    expect(store.tournament(id)!.status).toBe("draft");
    expect((await call(store, "POST", `/api/tournaments/${id}/start`, { force: true }))?.status).toBe(200);
  });
  it("enforced house rules lock with the ruleset once rounds exist; display-only ones stay editable", async () => {
    const { store, id } = draftWithEntries();
    await call(store, "POST", `/api/tournaments/${id}/start`, {});
    store.generateNextRound(id, now);
    // After round 1: the message (400 without it) AND the "Are you sure?" confirmation (409 without it) are required.
    expect((await call(store, "PATCH", `/api/tournaments/${id}`, { houseRules: { maxStatIncreasesTeam: 2 } }))?.status).toBe(400);
    expect((await call(store, "PATCH", `/api/tournaments/${id}`, { houseRules: { maxStatIncreasesTeam: 2 }, changeMessage: "Two stat increases per team." }))?.status).toBe(409);
    expect((await call(store, "PATCH", `/api/tournaments/${id}`, { houseRules: { maxStatIncreasesTeam: 2 }, changeMessage: "Two stat increases per team.", confirmAfterStart: true }))?.status).toBe(200);
    expect((await call(store, "PATCH", `/api/tournaments/${id}`, { houseRules: { brawlingBrutes: "on" }, changeMessage: "Brawling Brutes are on.", confirmAfterStart: true }))?.status).toBe(200);
    expect(store.tournament(id)!.news?.map((n) => n.title)).toEqual(["Rules changed during play", "Rules changed during play"]);
  });
});

// ---- stat caps as an extra validator rule ----
const human = findRoster(bb2025, "Human")!;
const lineman = findPosition(human, "Lineman")!;
const player = (number: number, maMore: number, stMore = 0) => ({
  player: { number, positionName: lineman.name, MA: lineman.MA + maMore, ST: lineman.ST + stMore, AG: lineman.AG, PA: lineman.PA, AV: lineman.AV, skills: [], keywords: [], cost: 50_000 },
  position: lineman, addedSkills: [], access: [],
});
const run = (rules: HouseRules, players: ReturnType<typeof player>[]) =>
  houseRuleStatRule(rules)!.check({ players, data: bb2025 } as never);

describe("house-rule stat caps (only ever tighten)", () => {
  it("a zero per-player cap refuses any increase, whatever default allowance the package would give", () => {
    const zero = parseHouseRules({ maxStatIncreasesPlayer: 0 }, "tournament");
    const findings = run(zero, [player(1, 1), player(2, 0)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: HOUSE_RULE_STAT_RULE_ID, severity: "error", playerRef: 1 });
    expect(findings[0]!.message).toContain("the limit is 0 per player");
  });
  it("a looser house cap never lifts a stricter package limit: the package's own rule still runs", () => {
    const loose = parseHouseRules({ maxStatIncreasesPlayer: 2 }, "tournament");
    // Two increases are within the house cap of 2, so the house rule is silent...
    expect(run(loose, [player(1, 1, 1)])).toEqual([]);
    // ...and the package's own stat-increases rule (flat cap 1 + team rules) is still in the list, unchanged.
    const rules = houseRuleValidatorRules(loose);
    expect(rules.length).toBe(ALL_RULES.length + 1);
    expect(rules.slice(0, ALL_RULES.length)).toEqual(ALL_RULES);
    // The package is never rewritten for a stat cap, so no level's maxPerPlayer can be raised.
    const pkg = { statIncreases: { maxPerPlayer: 1 }, teamRules: [{ team: "Human", statIncreases: { allowed: ["MA"] } }], special: { statIncreasesAllowed: true } };
    expect(applyHouseRulesToPackage(pkg, loose)).toBe(pkg);
  });
  it("counts the per-team cap over the whole roster; no cap set = no extra rule", () => {
    const team = parseHouseRules({ maxStatIncreasesTeam: 2 }, "tournament");
    expect(run(team, [player(1, 1), player(2, 1)])).toEqual([]);
    expect(run(team, [player(1, 1), player(2, 1), player(3, 0, 1)])[0]!.message).toContain("the team has 3 stat increases; the limit is 2 per team");
    expect(houseRuleStatRule(parseHouseRules({ prayers: { mode: "banned" } }, "tournament"))).toBeUndefined();
    expect(houseRuleValidatorRules(undefined)).toBe(ALL_RULES);
  });
});
