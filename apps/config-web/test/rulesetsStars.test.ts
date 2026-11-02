// Creation wizards v2, lane 2 (rulesets + stars): custom stars in the package (Creator round trip, the validator treats
// them like stars, coaches can't change them, no added skills), the ruleset summary content, the required change message
// (400 without it, every coach notified with stub transports, re-validation and "needs changes" notes, the after-start
// confirmation), and the BB2025 matched play package. Isolated state dirs per test (laws §C14); no live data.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeTeam, customStarPositions, findRoster, loadPackage, resolveTeamConfig, validate, withCustomStars,
  type CustomStar, type TeamPick, type TournamentPackage,
} from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { PackageFiles } from "../src/data.js";
import { packagesApi } from "../src/packagesApi.js";
import { rulesetSummary } from "../src/rulesetSummary.js";
import { parseHouseRules } from "../src/competition/houseRules.js";
import { CHANGE_MESSAGE_MAX, parseChangeMessage, rulesChangeDiff } from "../src/competition/rulesChange.js";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";
import type { TournamentSubmission } from "../src/tournaments/types.js";
import type { NotificationInput } from "../src/notifications.js";
import { actionDmText } from "../src/mail/actionMessages.js";
import { createTournamentCreator } from "../spa/src/tournaments/creator";
import { customStarError, customStarPosition, stepStat, blankCustomStar } from "../spa/src/tournaments/customStars";
import { sanitizeSummary, summaryPdfDoc } from "../spa/src/tournaments/rulesetSummary";
import matchedPlayJson from "../../../tournament-packages/bb2025-matched-play.json";
import "../public/team-builder.js";
import "../public/sheet-pdf.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = (p: string) => { const r = mkdtempSync(join(tmpdir(), p)); roots.push(r); return r; };

const HOUND: CustomStar = {
  id: "grim-hound", name: "Grim Hound", sprite: "/sprites/stars/griffoberwald.png", cost: 150_000, MA: 7, ST: 3, AG: 3, PA: null, AV: 9,
  skills: ["Loner (4+)", "Dodge", "Sure Feet"],
  specialRules: [
    { kind: "trait", name: "Fog Walker", description: "Once per half, ignore one tackle zone when dodging." },
    { kind: "rule", name: "Crowd Favourite", description: "Gains a free Team Mascot while on the pitch." },
  ],
};
const basePkg = (extra: Record<string, unknown> = {}) =>
  loadPackage({ name: "Hound Cup", goldBudget: 1_300_000, skillAllotment: { skillPointBudget: 0 }, starPlayers: { allowed: true, maxCount: 1, maxCombinedCost: null }, customStars: [HOUND], ...extra } as never).pkg;

/** A fork roster XML synthesised from the dataset (positionId = index), no stars of its own. */
function forkXml(race: string): string {
  const r = findRoster(bb2025, race)!;
  const n = (t: string) => (/^(\d+)\+$/.exec(t)?.[1] ?? "0");
  const positions = r.positions.map((p, i) =>
    `<position id="${i + 1}"><quantity>${p.max}</quantity><name>${p.name}</name><type>Regular</type><gender>male</gender>` +
    `<cost>${p.cost}</cost><movement>${p.MA}</movement><strength>${p.ST}</strength><agility>${n(p.AG)}</agility>` +
    `<passing>${n(p.PA)}</passing><armour>${n(p.AV)}</armour><skillList></skillList></position>`);
  return `<roster id="${race.toLowerCase()}.bb2025"><name>${r.name}</name><reRollCost>${r.reRollCost}</reRollCost><maxReRolls>8</maxReRolls>` +
    `<apothecary>true</apothecary><positions>${positions.join("")}</positions></roster>`;
}
function team(pkg: TournamentPackage, picks: TeamPick[]) {
  return composeTeam({ forkRosterXml: forkXml("Human"), coach: "Ann", teamName: "Hounds", picks, reRolls: 2, apothecary: false, extraStars: customStarPositions(pkg.customStars ?? []) }, bb2025);
}
const linemen: TeamPick = { positionId: "1", count: 11 };

describe("custom stars in the ruleset package", () => {
  it("the Creator's star dialog saves into the package and round-trips through the server save", async () => {
    const creator = createTournamentCreator({ api: (async () => { throw new Error("offline"); }) as never });
    creator.newBlank();
    creator.setField("name", "Hound Cup");
    const id = creator.saveCustomStar({ ...HOUND, id: "" });
    expect(id).toBe("grim-hound");
    expect(creator.serialize().customStars).toEqual([HOUND]);
    // edit keeps the id; remove drops the list
    creator.saveCustomStar({ ...HOUND, cost: 160_000 });
    expect((creator.serialize().customStars as CustomStar[])[0]!.cost).toBe(160_000);

    const files = new PackageFiles(tmp("bbtv-cs-pkg-"));
    const doc = { ...creator.serialize(), customStars: [HOUND] };
    const saved = packagesApi(files, "POST", "/api/packages", new URLSearchParams(), doc);
    expect(saved?.status, JSON.stringify(saved?.body)).toBe(200);
    const read = packagesApi(files, "GET", "/api/packages/Hound%20Cup", new URLSearchParams());
    expect((read?.body as { pkg: TournamentPackage }).pkg.customStars).toEqual([HOUND]);
    creator.removeCustomStar("grim-hound");
    expect(creator.serialize().customStars).toBeUndefined();
  });

  it("the save refuses a custom star named like a BB2025 star, unknown skills and bad stats", () => {
    const files = new PackageFiles(tmp("bbtv-cs-bad-"));
    const post = (star: Record<string, unknown>) => packagesApi(files, "POST", "/api/packages", new URLSearchParams(), { name: "Bad", skillAllotment: { skillPointBudget: 0 }, customStars: [{ ...HOUND, ...star }] });
    expect(JSON.stringify(post({ name: "Griff Oberwald" })?.body)).toContain("name of a BB2025 Star Player");
    expect(JSON.stringify(post({ skills: ["Laser Eyes"] })?.body)).toContain("unknown skill");
    expect(post({ AG: 9 })?.status).toBe(422);
    expect(post({ cost: 150_500 })?.status).toBe(422);
    expect(post({ sprite: "https://example.com/x.png" })?.status).toBe(422);
  });

  it("the validator treats a custom star like a star: price counted, star limits apply, eligible for every team", () => {
    const pkg = basePkg();
    const ok = validate(team(pkg, [linemen, { positionId: "cs-grim-hound", count: 1 }]).roster, pkg, bb2025);
    expect(ok.errors, JSON.stringify(ok.errors)).toEqual([]);
    expect(ok.recomputedSummary.starsCost).toBe(150_000);
    // stars not allowed -> refused like any star
    const noStars = basePkg({ starPlayers: { allowed: false, maxCount: null, maxCombinedCost: null } });
    expect(validate(team(noStars, [linemen, { positionId: "cs-grim-hound", count: 1 }]).roster, noStars, bb2025).errors.map((e) => e.ruleId)).toContain("star-players");
    // a banned custom star is refused
    const banned = basePkg({ bannedStars: ["Grim Hound"] });
    expect(validate(team(banned, [linemen, { positionId: "cs-grim-hound", count: 1 }]).roster, banned, bb2025).errors.map((e) => e.message).join()).toContain("banned");
    // the combined-cost cap counts it
    const capped = basePkg({ starPlayers: { allowed: true, maxCount: 2, maxCombinedCost: 100_000 } });
    expect(validate(team(capped, [linemen, { positionId: "cs-grim-hound", count: 1 }]).roster, capped, bb2025).errors.map((e) => e.ruleId)).toContain("star-players");
    // the dataset copy carries it for the star rules, a package without custom stars is untouched
    expect(withCustomStars(bb2025, pkg).stars.some((s) => s.name === "Grim Hound" && s.teams.length === 0)).toBe(true);
    expect(withCustomStars(bb2025, basePkg({ customStars: [] }))).toBe(bb2025);
  });

  it("coaches can't change a custom star and stars never add skills", () => {
    const pkg = basePkg();
    // the composer refuses chosen skills or stat increases on a star pick
    expect(() => team(pkg, [linemen, { positionId: "cs-grim-hound", count: 1, chosenSkills: ["Block"] }])).toThrow(/cannot take chosen skills/);
    expect(() => team(pkg, [linemen, { positionId: "cs-grim-hound", count: 1, chosenStatIncreases: ["MA"] }])).toThrow(/characteristic increases/);
    // a hand-edited sheet: an added skill, a cheaper price, a better stat are all refused
    const composed = team(pkg, [linemen, { positionId: "cs-grim-hound", count: 1 }]).roster;
    const star = composed.players.find((p) => p.positionName === "Grim Hound")!;
    const tamper = (patch: Record<string, unknown>) => ({ ...composed, players: composed.players.map((p) => (p === star ? { ...p, ...patch } : p)) });
    expect(validate(tamper({ skills: [...star.skills, "Block"] }), pkg, bb2025).errors.map((e) => e.ruleId)).toContain("star-skills");
    expect(validate(tamper({ cost: 50_000 }), pkg, bb2025).errors.map((e) => e.ruleId)).toContain("custom-stars");
    expect(validate(tamper({ MA: 9 }), pkg, bb2025).errors.map((e) => e.ruleId)).toContain("custom-stars");
    // the composed star carries exactly the organiser's line
    expect(star).toMatchObject({ MA: 7, ST: 3, AG: "3+", PA: "-", AV: "9+", cost: 150_000, skills: HOUND.skills });
  });

  it("the Roster Builder position and the sheet model / PDF print the special rules below the skills", () => {
    const position = customStarPosition({ ...HOUND, specialRules: HOUND.specialRules! });
    expect(position).toMatchObject({ positionId: "cs-grim-hound", isStar: true, max: 1, playsFor: [] });
    const core = (globalThis as unknown as { TeamBuilderCore: { rosterSheetModel(i: unknown): { rows: Array<Record<string, unknown>> } } }).TeamBuilderCore;
    const model = core.rosterSheetModel({ raceName: "Human", players: [{ position, chosenSkills: [], chosenStatIncreases: [] }], staff: {}, inducements: [], specialRules: [], costs: {} });
    expect(model.rows[0]!.specialRules).toEqual(HOUND.specialRules);
    const pdf = (globalThis as unknown as { SheetPdf: { buildSheetDocDefinition(m: unknown, o: unknown): unknown } }).SheetPdf;
    const doc = JSON.stringify(pdf.buildSheetDocDefinition({ ...model, raceName: "Human", coach: "Ann", teamName: "Hounds", rulesetName: "Hound Cup", sideline: [], inducements: [], specialRules: [], summary: [], keywords: [] }, { gold: (v: unknown) => String(v), generatedOn: new Date("2026-11-02") }));
    expect(doc).toContain("SPECIAL RULES");
    expect(doc).toContain("Fog Walker");
    expect(doc).toContain("Once per half, ignore one tackle zone when dodging.");
  });

  it("the dialog's helpers: free stat steps (PA down to no passing), names checked against the dataset", () => {
    let s = blankCustomStar();
    for (let i = 0; i < 3; i++) s = stepStat(s, "PA", -1);
    expect(s.PA).toBeNull();
    expect(stepStat(s, "PA", 1).PA).toBe(6);
    expect(stepStat({ ...s, MA: 15 }, "MA", 1).MA).toBe(16); // no BB2025 cap for the organiser
    expect(customStarError({ ...s, name: "Griff Oberwald" }, [], ["Griff Oberwald"])).toContain("BB2025 Star Player");
    expect(customStarError({ ...s, name: "Ok", specialRules: [{ kind: "rule", name: "X", description: "" }] }, [])).toContain("description");
  });
});

describe("ruleset summary (export)", () => {
  it("carries limits, the tier table, the skill-access matrix, bans, inducements with house-rule costs, house rules, progression and custom stars", () => {
    const pkg = basePkg({ bannedStars: ["Morg 'n' Thorg"], special: { bannedSkills: ["Dodge"], minPlayers: 11 } });
    const houseRules = parseHouseRules({ prayers: { mode: "cost", costK: 25 }, progression: { enabled: true, spp: true, injuries: false, treasury: false } }, "tournament");
    const s = rulesetSummary(pkg, bb2025, { competition: { kind: "tournament", id: "t1", name: "Hound Open", houseRules } });
    expect(s.limits.find((l) => l.k === "Team budget")!.v).toBe("1,300k");
    expect(s.overview.groups.length).toBeGreaterThan(0);
    const blitzer = s.skillAccess.rows.find((r) => r.race === "Human" && r.position === "Human Blitzer")!;
    expect(blitzer.cells[s.skillAccess.categories.indexOf("General")]).toBe("P");
    expect(s.bans).toEqual({ stars: ["Morg 'n' Thorg"], skills: ["Dodge"] });
    expect(s.inducements.find((i) => i.name === "Prayers to Nuffle")).toMatchObject({ price: 25_000, houseRule: true });
    expect(s.houseRules!.find((r) => r.k === "Prayers to Nuffle")!.v).toBe("Costs 25k");
    expect(s.progression!.v).toContain("SPP");
    expect(s.customStars[0]).toMatchObject({ name: "Grim Hound", PA: "-", specialRules: HOUND.specialRules });
    // a banned PtN leaves the list; the SPA model and its PDF carry the same sections
    const banned = rulesetSummary(pkg, bb2025, { competition: { kind: "tournament", id: "t1", name: "x", houseRules: parseHouseRules({ prayers: { mode: "banned" } }, "tournament") } });
    expect(banned.inducements.some((i) => i.name === "Prayers to Nuffle")).toBe(false);
    const view = sanitizeSummary({ summary: s })!;
    const doc = JSON.stringify(summaryPdfDoc(view, new Date("2026-11-02")));
    for (const heading of ["BUDGET AND ROSTER LIMITS", "SKILL ACCESS", "BANS", "INDUCEMENTS", "HOUSE RULES AND PROGRESSION", "CUSTOM STARS", "Fog Walker", "Hound Open"]) expect(doc).toContain(heading);
  });
});

// ---- the required change message (tournaments) ----
const now = new Date("2026-11-02T12:00:00.000Z");
const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const TEAMS: Record<string, string> = { "team-alice": "Alice", "team-bob": "Bob", "team-cara": "Cara" };
function changeDeps(store: TournamentStore, sent: Array<{ coach: string; input: NotificationInput }>, invalidUnder: string): TournamentApiDeps {
  const note = (coach: string, input: NotificationInput) => void sent.push({ coach, input });
  return {
    store, now: () => now, packageExists: (n) => n === "Rules" || n === "Rules2", teamOwner: (id) => TEAMS[id],
    teamBuild: (id) => (TEAMS[id] ? { teamName: `${TEAMS[id]} XI`, race: "Orc" } : undefined), registeredCoach: (n) => n,
    // Bob's roster fails under `invalidUnder`; everyone else passes.
    validateSubmission: (coach, ref, packageName, at): TournamentSubmission => ({
      saveId: ref, revision: "r1", submittedAt: at.toISOString(), teamName: `${coach} XI`, race: "Orc", snapshot: { coach },
      validation: { ok: !(coach === "Bob" && packageName === invalidUnder), problems: coach === "Bob" && packageName === invalidUnder ? ["Too many Blitzers."] : [], checkedAt: at.toISOString(), packageName },
    }),
    notify: { coach: note, managers: () => undefined, entrants: () => undefined },
  };
}
function eventWithEntries() {
  const store = new TournamentStore(tmp("bbtv-rc-"));
  const t = store.createTournament({ name: "Spike Open", packageName: "Rules", maxPlayers: 8, format: "swiss", organizerCoachId: "Veers", roundCount: 3 }, now);
  for (const name of ["Alice", "Bob", "Cara"]) store.registerEntrant(t.id, { coachId: name, ffbCoachId: name, verifiedAt: now.toISOString() }, `team-${name.toLowerCase()}`, now);
  return { store, id: t.id };
}

describe("ruleset change after registration", () => {
  it("the message is required server-side: a PATCH without it (or too short / too long) is a 400 and changes nothing", async () => {
    const { store, id } = eventWithEntries();
    const sent: Array<{ coach: string; input: NotificationInput }> = [];
    const patch = (body: unknown) => tournamentApi("PATCH", `/api/tournaments/${id}`, new URLSearchParams(), owner, body, changeDeps(store, sent, ""));
    expect(await patch({ packageName: "Rules2" })).toMatchObject({ status: 400, body: { field: "changeMessage", changes: ["Ruleset: Rules → Rules2"], coaches: 3 } });
    expect((await patch({ packageName: "Rules2", changeMessage: "too short" }))?.status).toBe(400);
    expect((await patch({ packageName: "Rules2", changeMessage: "x".repeat(CHANGE_MESSAGE_MAX + 1) }))?.status).toBe(400);
    expect((await patch({ houseRules: { brawlingBrutes: "on" } }))?.status).toBe(400);
    expect(store.tournament(id)!.packageName).toBe("Rules");
    expect(sent).toEqual([]);
    expect(() => parseChangeMessage("   ten chars! ")).not.toThrow();
  });

  it("every registered coach is notified (inbox + DM text), the news logs it, rosters are re-checked and invalid ones need changes", async () => {
    const { store, id } = eventWithEntries();
    for (const name of ["Alice", "Bob", "Cara"]) {
      const e = store.entrants(id).find((x) => x.coach.ffbCoachId === name)!;
      store.submitTeam(id, e.id, { saveId: `save:${name}`, revision: "r0", submittedAt: now.toISOString(), snapshot: null, validation: { ok: true, problems: [], checkedAt: now.toISOString(), packageName: "Rules" } }, now);
    }
    const sent: Array<{ coach: string; input: NotificationInput }> = [];
    const res = await tournamentApi("PATCH", `/api/tournaments/${id}`, new URLSearchParams(), owner,
      { packageName: "Rules2", houseRules: { prayers: { mode: "banned" } }, changeMessage: "We switched to Rules2 and banned Prayers." }, changeDeps(store, sent, "Rules2"));
    expect(res?.status, JSON.stringify(res?.body)).toBe(200);
    const changes = rulesChangeDiff("tournament", { packageName: "Rules", houseRules: parseHouseRules({}, "tournament") }, { packageName: "Rules2", houseRules: parseHouseRules({ prayers: { mode: "banned" } }, "tournament") });
    expect((res!.body as { changes: string[] }).changes).toEqual(changes);
    const notes = sent.filter((s) => s.input.type === "ruleset-change");
    expect(notes.map((n) => n.coach).sort()).toEqual(["Alice", "Bob", "Cara"]);
    expect(notes[0]!.input.body).toContain("We switched to Rules2 and banned Prayers.");
    expect(notes[0]!.input.body).toContain("What changed:\n- Ruleset: Rules → Rules2\n- Prayers to Nuffle: As the ruleset says → Banned");
    // the Discord DM queue takes it (actionable, with the link)
    expect(actionDmText({ record: { type: "ruleset-change", from: "Veers", title: notes[0]!.input.title, link: notes[0]!.input.link }, subject: notes[0]!.input.subject, action: true, url: "https://site.example.test/x" })!.plain).toContain("The rules of Spike Open changed");
    // re-validated at once: Bob needs changes (chip from submission.valid false) and is told so
    const bob = store.entrants(id).find((e) => e.coach.ffbCoachId === "Bob")!;
    expect(bob.submission!.validation).toMatchObject({ ok: false, packageName: "Rules2", problems: ["Too many Blitzers."] });
    expect(store.entrants(id).find((e) => e.coach.ffbCoachId === "Alice")!.submission!.validation.ok).toBe(true);
    const problems = sent.filter((s) => s.input.type === "roster-problems");
    expect(problems.map((p) => p.coach)).toEqual(["Bob"]);
    expect(problems[0]!.input).toMatchObject({ title: "Spike Open: your roster needs changes", action: true });
    expect(actionDmText({ record: { type: "roster-problems", from: "", title: "", link: "/x" }, subject: "Spike Open", action: true, url: "u" })!.plain).toContain("needs changes");
    expect(store.tournament(id)!.news![0]).toMatchObject({ title: "Rules changed", by: "Veers" });
    expect(store.tournament(id)!.news![0]!.body).toContain("What changed:");
  });

  it("after round 1 the change also needs the 'Are you sure?' confirmation (409 without it) and is logged as a change during play", async () => {
    const { store, id } = eventWithEntries();
    const sent: Array<{ coach: string; input: NotificationInput }> = [];
    const d = changeDeps(store, sent, "");
    await tournamentApi("POST", `/api/tournaments/${id}/start`, new URLSearchParams(), owner, {}, d);
    store.generateNextRound(id, now);
    const patch = (body: unknown) => tournamentApi("PATCH", `/api/tournaments/${id}`, new URLSearchParams(), owner, body, d);
    expect((await patch({ houseRules: { maxStatIncreasesTeam: 1 } }))?.status).toBe(400);
    expect(await patch({ houseRules: { maxStatIncreasesTeam: 1 }, changeMessage: "One stat increase per team from now on." })).toMatchObject({ status: 409, body: { confirmRequired: true } });
    expect(store.tournament(id)!.news ?? []).toEqual([]);
    expect((await patch({ houseRules: { maxStatIncreasesTeam: 1 }, changeMessage: "One stat increase per team from now on.", confirmAfterStart: true }))?.status).toBe(200);
    expect(store.tournament(id)!.news![0]!.title).toBe("Rules changed during play");
    expect(sent.filter((s) => s.input.type === "ruleset-change")).toHaveLength(3);
  });

  it("a change with nobody registered before the start needs no message", async () => {
    const store = new TournamentStore(tmp("bbtv-rc-empty-"));
    const t = store.createTournament({ name: "Empty", packageName: "Rules", maxPlayers: 8, format: "swiss", organizerCoachId: "Veers", roundCount: 3 }, now);
    const res = await tournamentApi("PATCH", `/api/tournaments/${t.id}`, new URLSearchParams(), owner, { packageName: "Rules2" }, changeDeps(store, [], ""));
    expect(res?.status).toBe(200);
    expect(store.tournament(t.id)!.news ?? []).toEqual([]);
  });
});

describe("BB2025 matched play package", () => {
  const { pkg, problems } = loadPackage(matchedPlayJson as unknown as Partial<TournamentPackage>);
  it("loads clean: four tiers of 6/8/9/10 SP, 1,150k, Primary 1 / Secondary 2, one skill per player, 4 Elite, 2 stars and 1 Mega-star", () => {
    expect(problems).toEqual([]);
    expect(pkg.name).toBe("BB2025 Matched Play");
    expect(pkg.goldBudget).toBe(1_150_000);
    expect(pkg.tiers!.map((t) => t.skillPackages![0]!.skillPointBudget)).toEqual([6, 8, 9, 10]);
    expect(pkg.skillAllotment).toMatchObject({ primaryCostSP: 1, secondaryMultiplier: 2, eliteSurchargeSP: 0, maxPerPlayer: 1, eliteMaxTotal: 4 });
    expect(pkg.starPlayers.maxCount).toBe(2);
    expect(pkg.starPacks!.find((p) => p.id === "mega")).toMatchObject({ max: 1 });
    expect(pkg.starPacks!.find((p) => p.id === "mega")!.stars).toContain("Morg 'n' Thorg");
    // every star in the dataset sits in exactly one pack, priced 2 SP (Mega 4; a pair's partner 0 so the pair is one 2 SP pick)
    const all = pkg.starPacks!.flatMap((p) => p.stars);
    expect(new Set(all).size).toBe(bb2025.stars.length);
    expect(pkg.starPlayers.spCostByTier!["Griff Oberwald"]).toEqual([4, 4, 4, 4]);
    expect(pkg.starPlayers.spCostByTier!["Grak"]![0]! + pkg.starPlayers.spCostByTier!["Crumbleberry"]![0]!).toBe(2);
    // every team on the May 2026 list is placed once, dataset-canonical
    const placed = pkg.tiers!.flatMap((t) => t.rosters);
    expect(placed).toHaveLength(30);
    expect(new Set(placed).size).toBe(30);
    for (const r of placed) expect(findRoster(bb2025, r), r).toBeDefined();
    expect(resolveTeamConfig(pkg, "Snotling").tierNumber).toBe(4);
    expect(resolveTeamConfig(pkg, "Amazon").tierNumber).toBe(1);
    expect(pkg.dataNote).toContain("Hand-check");
  });
  it("is in the Featured row of the shared ruleset picker", async () => {
    const { rulesetCards } = await import("../spa/src/shared/competition");
    const cards = rulesetCards([{ name: "BB2025 Default" }, { name: "BB2025 Matched Play" }], "tournament");
    expect(cards.featured.map((c) => c.label)).toEqual(["BB2025", "BB2025 matched play"]);
  });
  it("a clean Tier 2 roster validates under the package", () => {
    const xml = forkXml("Human");
    const ok = composeTeam({ forkRosterXml: xml, coach: "Ann", teamName: "MP", picks: [{ positionId: "1", count: 11 }], reRolls: 2, apothecary: false }, bb2025);
    // Human is Tier 2 (8 SP): a clean 11-lineman team fits
    expect(validate(ok.roster, pkg, bb2025).errors, JSON.stringify(validate(ok.roster, pkg, bb2025).errors)).toEqual([]);
  });
});
