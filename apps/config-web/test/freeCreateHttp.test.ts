import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeTeam, findPosition, findRoster, loadPackage, skillAccess, validate, type TeamPick } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { createSession, onboardedCoaches } from "./onboardedFixture.js";
import { FREE_CREATE_BUILD_PACKAGE, resolveBuilderPackage } from "../src/teamBuilderPackage.js";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createTournamentBuilder, FREE_CREATE_PACKAGE } from "../spa/src/teams/builder";

// Free Create against the real server (owner 10-31, Sol 6.1 review): the fork build path validates with Free Create's
// own build profile, and the public share view prices a Free Create team exactly as the Roster Builder does.
/* eslint-disable @typescript-eslint/no-explicit-any */
const root = mkdtempSync(join(tmpdir(), "free-create-http-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const num = (t: string) => (/^(\d+)\+$/.exec(t)?.[1] ?? "0");
/** A base fork roster XML synthesised from the dataset (positionId = <prefix><index>); `stars` are appended as Star positions. */
function rosterXml(race: string, id: string, prefix: string, stars: Array<{ id: string; name: string }> = []): string {
  const r = findRoster(bb2025, race)!;
  const positions = r.positions.map(
    (p, i) =>
      `<position id="${prefix}${i + 1}"><quantity>${p.max}</quantity><name>${p.name}</name><type>Regular</type><gender>male</gender>` +
      `<cost>${p.cost}</cost><movement>${p.MA}</movement><strength>${p.ST}</strength><agility>${num(p.AG)}</agility>` +
      `<passing>${num(p.PA)}</passing><armour>${num(p.AV)}</armour><skillList>${p.skills.map((s) => `<skill>${s}</skill>`).join("")}</skillList></position>`,
  );
  const starXml = stars.map((s) => `<position id="${s.id}"><quantity>1</quantity><name>${s.name}</name><type>Star</type><gender>male</gender><cost>200000</cost>`
    + `<movement>6</movement><strength>4</strength><agility>3</agility><passing>4</passing><armour>9</armour><skillList></skillList></position>`);
  return `<roster id="${id}"><name>${r.name}</name><reRollCost>60000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>${positions.join("")}${starXml.join("")}</roster>\n<!-- Time: 0.01 -->`;
}
const DWARF = findRoster(bb2025, "Dwarf")!;
const dwarfIndex = (name: string) => DWARF.positions.findIndex((p) => p.name === name) + 1;
const BLOCKER = `d${DWARF.positions.findIndex((p) => /blocker/i.test(p.name)) + 1}`;

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1", HOST: "127.0.0.1", PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"), ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"), FORK_BUILDER_SAVES_DIR: join(root, "saves"), FORK_TEAMS_DIR: join(root, "teams"),
    FORK_STATE_DIR: join(root, "state"), PACKAGES_DIR: join(root, "packages"), TOURNAMENTS_DIR: join(root, "tournaments"), FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const d of ["library", "teams", "rosters", "packages", "tournaments", "log", "state", "saves"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8"); // trips reloadFork's busy guard: no live fork is touched
  // The second roster carries a star the Dwarf roster does not list (the Ignore in-game limits pool).
  writeFileSync(join(root, "rosters", "dwarf.xml"), rosterXml("Dwarf", "dwarf.bb2025", "d"), "utf8");
  writeFileSync(join(root, "rosters", "human.xml"), rosterXml("Human", "human.bb2025", "h", [{ id: "s900", name: "Griff Oberwald" }]), "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: onboardedCoaches("Alice") }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});

const alice = createSession("Alice");
/** The SPA's fetcher shape, against the real server as Alice. */
const fetcher = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const res = await fetch(`${origin}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${alice.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, String((data as any)?.error ?? res.status), data);
  return data;
}) as Fetcher;

describe("Free Create build profile", () => {
  it("validates with no gold cap, no SP budget and characteristic increases; the race's position limits still hold", () => {
    expect(resolveBuilderPackage(new Map() as any, { name: "Baseline" } as any, "free-create")).toEqual({ pkg: FREE_CREATE_BUILD_PACKAGE, free: true });
    const xml = rosterXml("Dwarf", "dwarf.bb2025", "d");
    const blocker = findPosition(DWARF, DWARF.positions[Number(BLOCKER.slice(1)) - 1]!.name)!;
    const primary = Object.keys(bb2025.skills).find((k) => !bb2025.skills[k]!.trait && !blocker.skills.includes(k) && skillAccess(bb2025, blocker, k) === "primary")!;
    const picks: TeamPick[] = [
      { positionId: BLOCKER, count: 1, chosenSkills: [primary], chosenStatIncreases: ["AV"] },
      { positionId: BLOCKER, count: 10 },
      { positionId: `d${dwarfIndex(DWARF.positions.find((p) => /slayer/i.test(p.name))!.name)}`, count: 2 },
      { positionId: `d${dwarfIndex(DWARF.positions.find((p) => /deathroller/i.test(p.name))!.name)}`, count: 1 },
    ];
    const composed = composeTeam({ forkRosterXml: xml, coach: "Alice", teamName: "Big Beards", reRolls: 2, apothecary: true, picks }, bb2025, 1);
    const free = validate(composed.roster, FREE_CREATE_BUILD_PACKAGE, bb2025);
    expect(free.errors.map((e: any) => e.message)).toEqual([]);
    // The old profile (the standalone 1,000k baseline) refused this team: SP budget 0, no increases, over the cap.
    const baseline = loadPackage({ name: "Team Builder Baseline", goldBudget: 1_000_000, eligibleRosters: ["*"], special: { insignificantTraitConstraint: false } }).pkg;
    expect(validate(composed.roster, baseline, bb2025).valid).toBe(false);
    // Over a position's max is still refused (the race's roster limits).
    const over = composeTeam({ forkRosterXml: xml.replace(/<quantity>\d+<\/quantity>/g, "<quantity>16</quantity>"), coach: "Alice", teamName: "Too Many", reRolls: 0, apothecary: false, picks: [{ positionId: `d${dwarfIndex(DWARF.positions.find((p) => /deathroller/i.test(p.name))!.name)}`, count: 2 }, { positionId: BLOCKER, count: 10 }] }, bb2025, 1);
    expect(validate(over.roster, FREE_CREATE_BUILD_PACKAGE, bb2025).valid).toBe(false);
  });
});

describe("Free Create over HTTP", () => {
  it("builder total == share total (primary, secondary, elite and off-access skills, a stat increase, a foreign star); off-access reads secondary", async () => {
    const b = createTournamentBuilder({ api: fetcher, coach: () => "Alice", previewDelay: 0, origin: () => origin, clipboard: async () => undefined });
    expect(await b.init({ packageName: FREE_CREATE_PACKAGE, race: "dwarf.bb2025" })).toBe("roster");
    b.setTeamName("Parity Beards");
    await b.setIgnoreLimits(true);
    for (let i = 0; i < 4; i++) b.addPosition(BLOCKER);
    b.stepStaff("reRolls", 2);
    b.stepStaff("apothecary", 1);
    expect(await b.openSkills(0)).toBe("");
    const sections = b.pickerSections(0)!;
    const pickFrom = (label: string, elite: boolean | null) => sections.find((s) => s.label === label)!.groups.flatMap((g) => g.skills).find((k) => !k.innate && (elite === null || k.elite === elite))!.skill;
    const chosen = [pickFrom("Primary", false), pickFrom("Secondary", false), [...sections.flatMap((s) => s.groups.flatMap((g) => g.skills))].find((k) => k.elite && !k.innate)!.skill, pickFrom("Other skills", null)];
    for (const k of new Set(chosen)) expect(b.addSkill(0, k)).toBe("");
    expect(b.addStat(1, "AV")).toBe("");
    const star = b.starChoices().find((c) => c.label === "Griff Oberwald")!;
    expect(b.addStar(star.key)).toBe(true);
    const other = chosen[3]!;
    expect(b.accessOf(BLOCKER, other)).toBe("secondary");
    expect(await b.saveTeam()).toBe(true);
    expect(await b.share()).toBe(true);
    const token = b.state.shareUrl.split("/t/")[1]!;
    const shared = (await (await fetch(`${origin}/api/fork/team-builder/shared/${token}`)).json()) as any;
    const t = b.totals();
    expect(shared.team.ruleset).toEqual({ name: "Free Create", tierLabel: null });
    expect(shared.team.players.map((p: any) => p.position)).toContain("Griff Oberwald");
    expect(shared.team.players[0].added.find((s: any) => s.name === other)).toMatchObject({ access: "secondary" });
    expect(shared.team.summary.skillsCost).toBe(t.skillsCost);
    expect(shared.team.summary.total).toBe(t.used);
    expect(shared.team.summary.cap).toBeNull();
    expect(shared.team.validity.findings).toEqual([]);
  });

  it("a saved sheet the composer refuses still shares (players shown, the dropped part flagged)", async () => {
    // Increases past a characteristic cap (AV 10+ raised five times), stored by hand: the client blocks them now.
    const body = { rosterId: "dwarf.bb2025", teamName: "Old Save", packageName: FREE_CREATE_PACKAGE, ignoreLimits: true,
      picks: [{ positionId: BLOCKER, count: 11, chosenStatIncreases: ["AV", "AV", "AV", "AV", "AV"] }] };
    const created = (await fetcher("/api/fork/team-builder/saves", { method: "POST", body: { name: "Old Save", body } })) as any;
    const shareRes = (await fetcher(`/api/fork/team-builder/saves/${created.save.id}/share`, { method: "POST" })) as any;
    const shared = (await (await fetch(`${origin}/api/fork/team-builder/shared/${shareRes.shareToken}`)).json()) as any;
    expect(shared.team.players).toHaveLength(11);
    expect(shared.team.validity.findings).toEqual(["Characteristic increases could not be shown."]);
  });

  it("Create team on Fork runs the real build path with the Free Create profile: over 1,000k with skills and an increase builds", async () => {
    const slayer = `d${dwarfIndex(DWARF.positions.find((p) => /slayer/i.test(p.name))!.name)}`;
    const roller = `d${dwarfIndex(DWARF.positions.find((p) => /deathroller/i.test(p.name))!.name)}`;
    const blocker = findPosition(DWARF, DWARF.positions[Number(BLOCKER.slice(1)) - 1]!.name)!;
    const primary = Object.keys(bb2025.skills).find((k) => !bb2025.skills[k]!.trait && !blocker.skills.includes(k) && skillAccess(bb2025, blocker, k) === "primary")!;
    const res = await fetch(`${origin}/api/fork/team-builder/build`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        rosterId: "dwarf.bb2025", teamName: "Free Build Beards", packageName: FREE_CREATE_PACKAGE, reRolls: 2, apothecary: true,
        picks: [{ positionId: BLOCKER, count: 1, chosenSkills: [primary], chosenStatIncreases: ["AV"] }, { positionId: BLOCKER, count: 10 }, { positionId: slayer, count: 2 }, { positionId: roller, count: 1 }],
      }),
    });
    const payload = (await res.json()) as any;
    expect(payload.errors ?? []).toEqual([]);
    expect(payload.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(typeof payload.teamId).toBe("string");
  });
});
