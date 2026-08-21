import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bb2025 } from "@bb/validator/dataset";
import { readLibrary, upsertLibraryTeam } from "@bb/fork-ops";
import type { SkillCategory } from "@bb/validator";
import type { SessionIdentity } from "./auth/requireSession.js";

export type AdvancementMethod = "randomPrimary" | "chosenPrimary" | "chosenSecondary" | "characteristic";
export type Characteristic = "MA" | "ST" | "AG" | "PA" | "AV";

export interface AdvancementCosts {
  randomPrimary: number;
  chosenPrimary: number;
  chosenSecondary: number;
  characteristic: number;
}

export interface PlayerProgression {
  earnedSpp: number;
  advancements: number;
  rank: string;
  costs: AdvancementCosts | null;
  primaryCategories: SkillCategory[];
  secondaryCategories: SkillCategory[];
  primarySkills: string[];
  secondarySkills: string[];
  characteristics: Record<Characteristic, number | null>;
  currentValue: number;
}

export interface AdvancementDeps {
  libraryDir: string;
  teamsDir?: string;
  tokenSecret: string;
  now?: () => number;
  randomIndex?: (length: number) => number;
}

export type AdvancementAction =
  | { action: "applySkill"; playerId: string; revision: string; method: "chosenPrimary" | "chosenSecondary"; skill: string }
  | { action: "rollRandomPrimary"; playerId: string; revision: string; category: SkillCategory }
  | { action: "rollCharacteristic"; playerId: string; revision: string }
  | { action: "commitRoll"; playerId: string; revision: string; token: string; choice: { type: "skill"; skill: string; access?: "primary" | "secondary" } | { type: "characteristic"; characteristic: Characteristic } };

export type AdvancementEndpointResult =
  | { status: 200; body: { pending: { token: string; method: "randomPrimary" | "characteristic"; cost: number; choices: string[]; roll?: number } } }
  | { status: 200; body: { ok: true; revision: string; playerId: string; spentSpp: number; valueIncrease: number } }
  | { status: 400 | 401 | 404 | 409 | 422 | 500 | 503; body: { error: string } };

const ADVANCEMENT_ROWS: ReadonlyArray<{ rank: string; costs: AdvancementCosts }> = [
  { rank: "Experienced", costs: { randomPrimary: 3, chosenPrimary: 6, chosenSecondary: 10, characteristic: 14 } },
  { rank: "Veteran", costs: { randomPrimary: 4, chosenPrimary: 8, chosenSecondary: 12, characteristic: 16 } },
  { rank: "Emerging Star", costs: { randomPrimary: 6, chosenPrimary: 12, chosenSecondary: 16, characteristic: 20 } },
  { rank: "Star", costs: { randomPrimary: 8, chosenPrimary: 16, chosenSecondary: 20, characteristic: 24 } },
  { rank: "Superstar", costs: { randomPrimary: 10, chosenPrimary: 20, chosenSecondary: 24, characteristic: 28 } },
  { rank: "Legend", costs: { randomPrimary: 15, chosenPrimary: 30, chosenSecondary: 34, characteristic: 38 } },
];

const CHARACTERISTIC_VALUE: Record<Characteristic, number> = { AV: 10_000, MA: 20_000, PA: 20_000, AG: 30_000, ST: 60_000 };
const CHARACTERISTIC_MAX: Record<Characteristic, number> = { MA: 9, ST: 8, AG: 1, PA: 1, AV: 11 };
const TOKEN_TTL_MS = 10 * 60 * 1000;

const attr = (scope: string, name: string): string | undefined => scope.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1];
const decodeXml = (value: string): string => value.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const encodeXml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const element = (scope: string, tag: string): string | undefined => {
  const match = scope.match(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`, "i"));
  return match ? decodeXml(match[1]!).trim() : undefined;
};
const numberElement = (scope: string, tag: string): number | undefined => {
  const parsed = Number(element(scope, tag));
  return Number.isFinite(parsed) ? parsed : undefined;
};
const safePart = (value: string): string => value.replace(/[^\w.-]+/g, "_") || "unknown";
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const coachNamesEqual = (left: string, right: string): boolean => left.trim().toLowerCase() === right.trim().toLowerCase();
const skillNames = (scope: string): string[] => [...scope.matchAll(/<skill\b[^>]*>([^<]*)<\/skill>/gi)].map((match) => decodeXml(match[1]!).trim()).filter(Boolean);
export const teamRevision = (xml: string): string => createHash("sha256").update(xml).digest("hex");

function teamFile(teamsDir: string, teamId: string): { path: string; xml: string } | undefined {
  if (!existsSync(teamsDir)) return undefined;
  const suffix = `_${safePart(teamId)}.xml`;
  for (const file of readdirSync(teamsDir)) {
    if (!file.startsWith("team_") || !file.endsWith(suffix)) continue;
    const path = join(teamsDir, file);
    const xml = readFileSync(path, "utf8");
    if (decodeXml(attr(xml.match(/<team\b[^>]*>/i)?.[0] ?? "", "id") ?? "") === teamId) return { path, xml };
  }
  return undefined;
}

function rosterXml(teamsDir: string, teamId: string): string | undefined {
  const path = join(dirname(teamsDir), "rosters", `roster_team_${safePart(teamId)}.xml`);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function playerBlock(xml: string, playerId: string): string | undefined {
  const match = xml.match(new RegExp(`<player\\b[^>]*\\bid="${escapeRe(playerId)}"[^>]*>[\\s\\S]*?</player>`, "i"));
  return match?.[0];
}

function positionBlock(xml: string | undefined, positionId: string): string | undefined {
  if (!xml) return undefined;
  return xml.match(new RegExp(`<position\\b[^>]*\\bid="${escapeRe(positionId)}"[^>]*>[\\s\\S]*?</position>`, "i"))?.[0];
}

function categoryList(position: string, kind: "normal" | "double"): SkillCategory[] {
  const list = position.match(/<skillCategoryList\b[^>]*>([\s\S]*?)<\/skillCategoryList>/i)?.[1] ?? "";
  const valid = new Set<SkillCategory>(["General", "Agility", "Strength", "Passing", "Mutation", "Devious"]);
  return [...list.matchAll(new RegExp(`<${kind}>([^<]*)</${kind}>`, "gi"))]
    .map((match) => decodeXml(match[1]!).trim() as SkillCategory)
    .filter((category) => valid.has(category));
}

function currentSpp(player: string): number {
  const stats = player.match(/<playerStatistics\b([^>]*)>/i)?.[1];
  const fromStats = Number(stats ? attr(stats, "currentSpps") : Number.NaN);
  if (Number.isFinite(fromStats)) return fromStats;
  const points = player.match(/<starPlayerPoints\b([^>]*)>/i)?.[1];
  const fromPoints = Number(points ? attr(points, "current") : Number.NaN);
  return Number.isFinite(fromPoints) ? fromPoints : (numberElement(player, "spp") ?? 0);
}

function earnedSpp(player: string): number {
  const stats = player.match(/<playerStatistics\b([^>]*)>/i)?.[1];
  const fromStats = Number(stats ? attr(stats, "earnedSpps") : Number.NaN);
  if (Number.isFinite(fromStats)) return fromStats;
  const points = player.match(/<starPlayerPoints\b([^>]*)>/i)?.[1];
  const fromPoints = Number(points ? attr(points, "earned") : Number.NaN);
  return Number.isFinite(fromPoints) ? fromPoints : (numberElement(player, "earnedSpp") ?? 0);
}

function statValue(scope: string, stat: Characteristic): number | undefined {
  const tag: Record<Characteristic, string> = { MA: "movement", ST: "strength", AG: "agility", PA: "passing", AV: "armour" };
  return numberElement(scope, tag[stat]);
}

function statImprovements(player: string, position: string | undefined): Record<Characteristic, number> {
  const out: Record<Characteristic, number> = { MA: 0, ST: 0, AG: 0, PA: 0, AV: 0 };
  if (!position) return out;
  for (const stat of Object.keys(out) as Characteristic[]) {
    const base = statValue(position, stat);
    const current = statValue(player, stat) ?? base;
    if (base === undefined || current === undefined) continue;
    out[stat] = stat === "AG" || stat === "PA" ? Math.max(0, base - current) : Math.max(0, current - base);
  }
  return out;
}

function advancementCount(player: string, position: string | undefined): number {
  const advancementSkills = skillNames(player).filter((skill) => {
    const meta = Object.entries(bb2025.skills).find(([name]) => name.toLowerCase() === skill.toLowerCase())?.[1];
    return Boolean(meta?.category && !meta.trait);
  });
  const derived = advancementSkills.length + Object.values(statImprovements(player, position)).reduce((sum, n) => sum + n, 0);
  const recorded = [...player.matchAll(/<advancement\b/gi)].length;
  return Math.max(derived, recorded);
}

function legalSkills(categories: readonly SkillCategory[], owned: readonly string[]): string[] {
  const ownedSet = new Set(owned.map((skill) => skill.toLowerCase()));
  return Object.entries(bb2025.skills)
    .filter(([name, meta]) => meta.category && categories.includes(meta.category) && !meta.trait && !ownedSet.has(name.toLowerCase()))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

export function playerProgression(player: string, roster: string | undefined): PlayerProgression {
  const positionId = element(player, "positionId") ?? attr(player.match(/<player\b[^>]*>/i)?.[0] ?? "", "positionId") ?? "";
  const position = positionBlock(roster, positionId);
  const primaryCategories = position ? categoryList(position, "normal") : [];
  const secondaryCategories = position ? categoryList(position, "double") : [];
  const owned = [...skillNames(position ?? ""), ...skillNames(player)];
  const advancements = advancementCount(player, position);
  const row = ADVANCEMENT_ROWS[advancements];
  const ineligible = position ? /<type>\s*(?:star|mercenary)\s*<\/type>/i.test(position) : true;
  const characteristics = Object.fromEntries((['MA', 'ST', 'AG', 'PA', 'AV'] as Characteristic[]).map((stat) => [stat, statValue(player, stat) ?? statValue(position ?? '', stat) ?? null])) as Record<Characteristic, number | null>;
  const addedSkillValue = skillNames(player).reduce((sum, skill) => {
    const found = Object.entries(bb2025.skills).find(([name]) => name.toLowerCase() === skill.toLowerCase());
    if (!found?.[1].category || found[1].trait) return sum;
    const base = secondaryCategories.includes(found[1].category) ? 40_000 : 20_000;
    return sum + base + (found[1].elite ? 10_000 : 0);
  }, 0);
  const characteristicValue = Object.entries(statImprovements(player, position)).reduce((sum, [stat, count]) => sum + CHARACTERISTIC_VALUE[stat as Characteristic] * count, 0);
  return {
    earnedSpp: earnedSpp(player),
    advancements,
    rank: ineligible ? "Ineligible" : (row?.rank ?? "Legend"),
    costs: !ineligible && row ? { ...row.costs } : null,
    primaryCategories,
    secondaryCategories,
    primarySkills: legalSkills(primaryCategories, owned),
    secondarySkills: legalSkills(secondaryCategories, owned),
    characteristics,
    currentValue: (numberElement(position ?? '', 'cost') ?? 0) + addedSkillValue + characteristicValue,
  };
}

interface RollClaim {
  coach: string;
  teamId: string;
  playerId: string;
  revision: string;
  method: "randomPrimary" | "characteristic";
  cost: number;
  choices: string[];
  expiresAt: number;
}

function signClaim(claim: RollClaim, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readClaim(token: string, secret: string): RollClaim | undefined {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return undefined;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let provided: Buffer;
  try { provided = Buffer.from(signature, "base64url"); } catch { return undefined; }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RollClaim; } catch { return undefined; }
}

function characteristicChoices(roll: number, player: string, position: string): Characteristic[] {
  const byRoll: Record<number, Characteristic[]> = {
    1: ["AV"], 2: ["AV", "PA"], 3: ["AV", "MA", "PA"], 4: ["AV", "MA", "PA"],
    5: ["MA", "PA"], 6: ["AG", "MA"], 7: ["AG", "ST"], 8: ["MA", "ST", "AG", "PA", "AV"],
  };
  const improvements = statImprovements(player, position);
  return byRoll[roll]!.filter((stat) => {
    if (improvements[stat] >= 2) return false;
    const base = statValue(position, stat);
    const current = statValue(player, stat) ?? base;
    if (current === undefined || (stat === "PA" && current <= 0)) return false;
    return stat === "AG" || stat === "PA" ? current > CHARACTERISTIC_MAX[stat] : current < CHARACTERISTIC_MAX[stat];
  });
}

function setCurrentSpp(player: string, spp: number): string {
  if (/<playerStatistics\b[^>]*\bcurrentSpps="[^"]*"/i.test(player)) {
    return player.replace(/(<playerStatistics\b[^>]*\bcurrentSpps=")[^"]*(")/i, `$1${spp}$2`);
  }
  if (/<playerStatistics\b/i.test(player)) return player.replace(/<playerStatistics\b/i, `<playerStatistics currentSpps="${spp}"`);
  if (/<starPlayerPoints\b[^>]*\bcurrent="[^"]*"/i.test(player)) return player.replace(/(<starPlayerPoints\b[^>]*\bcurrent=")[^"]*(")/i, `$1${spp}$2`);
  return player.replace(/<skillList\b/i, `<playerStatistics currentSpps="${spp}"></playerStatistics><skillList`);
}

function appendSkill(player: string, skill: string): string {
  const entry = `<skill>${encodeXml(skill)}</skill>`;
  if (/<skillList\s*\/>/i.test(player)) return player.replace(/<skillList\s*\/>/i, `<skillList>${entry}</skillList>`);
  if (/<\/skillList>/i.test(player)) return player.replace(/<\/skillList>/i, `${entry}</skillList>`);
  return player.replace(/<\/player>/i, `<skillList>${entry}</skillList></player>`);
}

function improveCharacteristic(player: string, stat: Characteristic, position: string): string {
  const tags: Record<Characteristic, string> = { MA: "movement", ST: "strength", AG: "agility", PA: "passing", AV: "armour" };
  const tag = tags[stat];
  const base = statValue(position, stat)!;
  const current = statValue(player, stat) ?? base;
  const next = stat === "AG" || stat === "PA" ? current - 1 : current + 1;
  if (new RegExp(`<${tag}>[^<]*</${tag}>`, "i").test(player)) return player.replace(new RegExp(`<${tag}>[^<]*</${tag}>`, "i"), `<${tag}>${next}</${tag}>`);
  return player.replace(/<skillList\b/i, `<${tag}>${next}</${tag}><skillList`);
}

function appendAudit(player: string, attrs: Record<string, string | number>): string {
  const entry = `<advancement ${Object.entries(attrs).map(([key, value]) => `${key}="${encodeXml(String(value))}"`).join(" ")}/>`;
  if (/<advancementList\s*\/>/i.test(player)) return player.replace(/<advancementList\s*\/>/i, `<advancementList>${entry}</advancementList>`);
  if (/<\/advancementList>/i.test(player)) return player.replace(/<\/advancementList>/i, `${entry}</advancementList>`);
  return player.replace(/<\/player>/i, `<advancementList>${entry}</advancementList></player>`);
}

function bumpTeamValues(xml: string, delta: number, currentDelta: number): string {
  const bumps: Array<[string, number]> = [["teamValue", delta], ["currentTeamValue", currentDelta], ["tournamentWeight", delta], ["rating", delta / 10_000], ["strength", delta / 10_000]];
  let out = xml;
  for (const [tag, amount] of bumps) {
    out = out.replace(new RegExp(`(<${tag}>)(-?\\d+(?:\\.\\d+)?)(</${tag}>)`, "i"), (_m, a: string, n: string, b: string) => `${a}${Number(n) + amount}${b}`);
  }
  return out;
}

function atomicWrite(path: string, xml: string): void {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try { writeFileSync(temp, xml, "utf8"); renameSync(temp, path); } finally { if (existsSync(temp)) unlinkSync(temp); }
}

function isMng(player: string): boolean {
  const opening = player.match(/<player\b[^>]*>/i)?.[0] ?? "";
  const status = attr(opening, "status") ?? "";
  const mng = attr(opening, "mng") ?? element(player, "mng") ?? element(player, "missNextGame") ?? "";
  return /^(1|true)$/i.test(mng) || /^(mng|miss[ _-]?next[ _-]?game)$/i.test(status);
}

function endpointError(status: 400 | 401 | 404 | 409 | 422 | 500 | 503, error: string): AdvancementEndpointResult {
  return { status, body: { error } };
}

export function advancementPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/teams\/([^/]+)\/advancement$/);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { return undefined; }
}

export function teamAdvancementEndpoint(auth: SessionIdentity | undefined, teamId: string, action: AdvancementAction | undefined, deps: AdvancementDeps): AdvancementEndpointResult {
  if (!auth) return endpointError(401, "Authentication required.");
  if (!action || typeof action !== "object") return endpointError(400, "An advancement action is required.");
  if (!deps.teamsDir) return endpointError(503, "Fork teams dir not configured on this host (set FORK_TEAMS_DIR).");
  const stored = readLibrary(deps.libraryDir, auth.coach).find((team) => team.teamId === teamId);
  if (!stored || !coachNamesEqual(stored.coach, auth.coach)) return endpointError(404, "Team not found.");
  const found = teamFile(deps.teamsDir, teamId);
  if (!found || !coachNamesEqual(element(found.xml, "coach") ?? "", auth.coach)) return endpointError(404, "Team not found.");
  const revision = teamRevision(found.xml);
  if (action.revision !== revision) return endpointError(409, "The team changed since it was loaded. Refresh and try again.");
  const originalPlayer = playerBlock(found.xml, action.playerId);
  if (!originalPlayer) return endpointError(404, "Player not found.");
  const roster = rosterXml(deps.teamsDir, teamId);
  const positionId = element(originalPlayer, "positionId") ?? "";
  const position = positionBlock(roster, positionId);
  if (!position) return endpointError(422, "This player's advancement access could not be resolved from the stored roster.");
  const progression = playerProgression(originalPlayer, roster);
  if (!progression.costs) return endpointError(422, "This player already has the maximum six advancements.");
  const spp = currentSpp(originalPlayer);
  const now = deps.now?.() ?? Date.now();
  const randomIndex = deps.randomIndex ?? ((length: number) => randomInt(length));

  if (action.action === "rollRandomPrimary") {
    const cost = progression.costs.randomPrimary;
    if (spp < cost) return endpointError(422, `This player needs ${cost} SPP for a random Primary Skill.`);
    if (!progression.primaryCategories.includes(action.category)) return endpointError(422, "That is not a Primary Skill category for this player.");
    const eligible = progression.primarySkills.filter((skill) => bb2025.skills[skill]?.category === action.category);
    if (!eligible.length) return endpointError(422, "No legal random Primary Skills remain in that category.");
    const choices = [eligible[randomIndex(eligible.length) % eligible.length]!, eligible[randomIndex(eligible.length) % eligible.length]!];
    const claim: RollClaim = { coach: auth.coach, teamId, playerId: action.playerId, revision, method: "randomPrimary", cost, choices, expiresAt: now + TOKEN_TTL_MS };
    return { status: 200, body: { pending: { token: signClaim(claim, deps.tokenSecret), method: claim.method, cost, choices } } };
  }

  if (action.action === "rollCharacteristic") {
    const cost = progression.costs.characteristic;
    if (spp < cost) return endpointError(422, `This player needs ${cost} SPP for a Characteristic Improvement.`);
    const roll = (randomIndex(8) % 8) + 1;
    const choices = characteristicChoices(roll, originalPlayer, position);
    const claim: RollClaim = { coach: auth.coach, teamId, playerId: action.playerId, revision, method: "characteristic", cost, choices, expiresAt: now + TOKEN_TTL_MS };
    return { status: 200, body: { pending: { token: signClaim(claim, deps.tokenSecret), method: claim.method, cost, choices, roll } } };
  }

  let method: AdvancementMethod;
  let cost: number;
  let skill: string | undefined;
  let skillAccess: "primary" | "secondary" | undefined;
  let characteristic: Characteristic | undefined;
  if (action.action === "applySkill") {
    method = action.method;
    cost = progression.costs[method];
    skill = action.skill.trim();
    skillAccess = method === "chosenSecondary" ? "secondary" : "primary";
    const eligible = method === "chosenPrimary" ? progression.primarySkills : progression.secondarySkills;
    if (!eligible.includes(skill)) return endpointError(422, `That is not a legal ${method === "chosenPrimary" ? "Primary" : "Secondary"} Skill for this player.`);
  } else {
    const claim = readClaim(action.token, deps.tokenSecret);
    if (!claim || claim.expiresAt < now || !coachNamesEqual(claim.coach, auth.coach) || claim.teamId !== teamId || claim.playerId !== action.playerId || claim.revision !== revision) {
      return endpointError(409, "That roll is invalid, expired, or belongs to an older team revision.");
    }
    method = claim.method;
    cost = claim.cost;
    if (action.choice.type === "characteristic") {
      if (claim.method !== "characteristic" || !claim.choices.includes(action.choice.characteristic)) return endpointError(422, "That Characteristic was not offered by this roll.");
      characteristic = action.choice.characteristic;
    } else {
      skill = action.choice.skill.trim();
      if (claim.method === "randomPrimary") {
        if (!claim.choices.includes(skill)) return endpointError(422, "That Skill was not offered by this random roll.");
        skillAccess = "primary";
      } else {
        skillAccess = action.choice.access === "secondary" ? "secondary" : "primary";
        const eligible = skillAccess === "secondary" ? progression.secondarySkills : progression.primarySkills;
        if (!eligible.includes(skill)) return endpointError(422, "That fallback Skill is not legal for this player.");
      }
    }
  }
  if (spp < cost) return endpointError(422, `This player no longer has the required ${cost} SPP.`);
  const elite = skill ? bb2025.skills[skill]?.elite === true : false;
  const valueIncrease = characteristic ? CHARACTERISTIC_VALUE[characteristic] : (skillAccess === "secondary" ? 40_000 : 20_000) + (elite ? 10_000 : 0);
  let updatedPlayer = setCurrentSpp(originalPlayer, spp - cost);
  if (skill) updatedPlayer = appendSkill(updatedPlayer, skill);
  if (characteristic) updatedPlayer = improveCharacteristic(updatedPlayer, characteristic, position);
  updatedPlayer = appendAudit(updatedPlayer, { method, cost, valueIncrease, ...(skill ? { skill, skillAccess: skillAccess ?? "primary" } : {}), ...(characteristic ? { characteristic } : {}), at: new Date(now).toISOString() });
  let updatedXml = found.xml.replace(originalPlayer, updatedPlayer);
  updatedXml = bumpTeamValues(updatedXml, valueIncrease, isMng(originalPlayer) ? 0 : valueIncrease);
  const lockPath = `${found.path}.advancement.lock`;
  let lock: number;
  try {
    lock = openSync(lockPath, "wx");
  } catch {
    return endpointError(409, "Another team update is in progress. Refresh and try again.");
  }
  let xmlWritten = false;
  try {
    if (teamRevision(readFileSync(found.path, "utf8")) !== revision) {
      return endpointError(409, "The team changed while this advancement was being saved. Refresh and try again.");
    }
    atomicWrite(found.path, updatedXml);
    xmlWritten = true;
    upsertLibraryTeam(deps.libraryDir, auth.coach, { ...stored, teamValue: stored.teamValue + valueIncrease / 1_000 });
  } catch {
    return endpointError(500, xmlWritten
      ? "The team advancement was written, but its library metadata could not be synchronized. Refresh before retrying."
      : "The team advancement could not be saved.");
  } finally {
    closeSync(lock);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
  return { status: 200, body: { ok: true, revision: teamRevision(updatedXml), playerId: action.playerId, spentSpp: cost, valueIncrease } };
}
