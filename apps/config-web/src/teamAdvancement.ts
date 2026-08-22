import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { bb2025 } from "@bb/validator/dataset";
import {
  acknowledgeForkCacheReload,
  acknowledgeRestoredTeamXmlTransaction,
  acquireTeamNameWriteLock,
  acquireTeamWriteLock,
  atomicWriteTextFile,
  beginTeamXmlTransaction,
  commitTeamXmlTransaction,
  markForkCacheReloadRequired,
  parseTeamXmlMeta,
  readLibrary,
  restoreTeamXmlTransaction,
  upsertLibraryTeam,
  type LibraryTeam,
  type ReloadResult,
  type TeamXmlTransactionHandle,
} from "@bb/fork-ops";
import type { SkillCategory } from "@bb/validator";
import type { SessionIdentity } from "./auth/requireSession.js";

type AdvancementIdentity = Pick<SessionIdentity, "coach" | "organizer">;

export type AdvancementMethod = "randomPrimary" | "chosenPrimary" | "chosenSecondary" | "characteristic";
export type Characteristic = "MA" | "ST" | "AG" | "PA" | "AV";

export interface AdvancementCosts {
  randomPrimary: number;
  chosenPrimary: number;
  chosenSecondary: number;
  characteristic: number;
}

export interface PlayerProgression {
  /** Exact lifetime earned SPP when authoritative; null for legacy/imported un-audited progression. */
  earnedSpp: number | null;
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
  isTeamActive?: (teamId: string) => Promise<boolean>;
  reload?: () => Promise<ReloadResult>;
}

export type AdvancementAction =
  | { action: "applySkill"; playerId: string; revision: string; method: "chosenPrimary" | "chosenSecondary"; skill: string }
  | { action: "rollRandomPrimary"; playerId: string; revision: string; category: SkillCategory }
  | { action: "rollCharacteristic"; playerId: string; revision: string }
  | { action: "commitRoll"; playerId: string; revision: string; token: string; choice: { type: "skill"; skill: string; access?: "primary" | "secondary" } | { type: "characteristic"; characteristic: Characteristic } };

export type AdvancementEndpointResult =
  | { status: 200; body: { pending: PendingAdvancementResponse } }
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

export interface PendingAdvancementResponse {
  token: string;
  playerId: string;
  revision: string;
  method: "randomPrimary" | "characteristic";
  cost: number;
  choices: string[];
  primaryFallbacks: string[];
  secondaryFallbacks: string[];
  expiresAt: string;
  roll?: number;
}

const VALID_CATEGORIES = new Set<SkillCategory>(["General", "Agility", "Strength", "Passing", "Mutation", "Devious"]);
const VALID_CHARACTERISTICS = new Set<Characteristic>(["MA", "ST", "AG", "PA", "AV"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => Object.hasOwn(value, key));
};
const boundedString = (value: unknown, max = 256): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function parseAdvancementAction(value: unknown): { ok: true; action: AdvancementAction } | { ok: false; error: string } {
  if (!isRecord(value) || typeof value.action !== "string") return { ok: false, error: "An advancement action is required." };
  const common = boundedString(value.playerId, 128) && boundedString(value.revision, 128);
  if (!common) return { ok: false, error: "playerId and revision must be non-empty strings." };
  if (!/^[a-f0-9]{64}$/.test(value.revision as string)) return { ok: false, error: "revision must be a canonical SHA-256 value." };
  if (value.action === "applySkill") {
    if (!exactKeys(value, ["action", "playerId", "revision", "method", "skill"]) ||
      (value.method !== "chosenPrimary" && value.method !== "chosenSecondary") || !boundedString(value.skill)) {
      return { ok: false, error: "applySkill requires exactly method and skill." };
    }
  } else if (value.action === "rollRandomPrimary") {
    if (!exactKeys(value, ["action", "playerId", "revision", "category"]) || typeof value.category !== "string" || !VALID_CATEGORIES.has(value.category as SkillCategory)) {
      return { ok: false, error: "rollRandomPrimary requires exactly a valid Primary category." };
    }
  } else if (value.action === "rollCharacteristic") {
    if (!exactKeys(value, ["action", "playerId", "revision"])) return { ok: false, error: "rollCharacteristic has unexpected fields." };
  } else if (value.action === "commitRoll") {
    if (!exactKeys(value, ["action", "playerId", "revision", "token", "choice"]) || !boundedString(value.token, 16_384) || !isRecord(value.choice)) {
      return { ok: false, error: "commitRoll requires exactly token and choice." };
    }
    if (value.choice.type === "characteristic") {
      if (!exactKeys(value.choice, ["type", "characteristic"]) || typeof value.choice.characteristic !== "string" || !VALID_CHARACTERISTICS.has(value.choice.characteristic as Characteristic)) {
        return { ok: false, error: "A valid characteristic choice is required." };
      }
    } else if (value.choice.type === "skill") {
      const keys = Object.hasOwn(value.choice, "access") ? ["type", "skill", "access"] : ["type", "skill"];
      if (!exactKeys(value.choice, keys) || !boundedString(value.choice.skill) ||
        (Object.hasOwn(value.choice, "access") && value.choice.access !== "primary" && value.choice.access !== "secondary")) {
        return { ok: false, error: "A valid skill choice is required." };
      }
    } else return { ok: false, error: "Unknown roll choice type." };
  } else return { ok: false, error: "Unknown advancement action." };
  return { ok: true, action: value as unknown as AdvancementAction };
}

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
  const matches: Array<{ path: string; xml: string }> = [];
  for (const file of readdirSync(teamsDir)) {
    if (!file.startsWith("team_") || !file.endsWith(suffix)) continue;
    const path = join(teamsDir, file);
    const xml = readFileSync(path, "utf8");
    if (decodeXml(attr(xml.match(/<team\b[^>]*>/i)?.[0] ?? "", "id") ?? "") === teamId) matches.push({ path, xml });
  }
  return matches.length === 1 ? matches[0] : undefined;
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

function earnedSpp(player: string): number | null {
  const stats = player.match(/<playerStatistics\b([^>]*)>/i)?.[1];
  const fromStats = Number(stats ? attr(stats, "earnedSpps") : Number.NaN);
  if (Number.isFinite(fromStats)) return fromStats;
  const points = player.match(/<starPlayerPoints\b([^>]*)>/i)?.[1];
  const fromPoints = Number(points ? attr(points, "earned") : Number.NaN);
  if (Number.isFinite(fromPoints)) return fromPoints;
  const explicit = numberElement(player, "earnedSpp");
  if (explicit !== undefined) return explicit;
  const audits = [...player.matchAll(/<advancement\b([^>]*)\/?\s*>/gi)];
  const spent = audits.reduce((sum, match) => sum + (Number(attr(match[1]!, "cost")) || 0), 0);
  const reserved = Number(attr(player.match(/<pendingAdvancement\b([^>]*)>/i)?.[1] ?? "", "cost")) || 0;
  const acquiredAdvancements = skillNames(player).filter((skill) => {
    if (/^\+(?:MA|ST|AG|PA|AV)$/i.test(skill)) return true;
    const meta = Object.entries(bb2025.skills).find(([name]) => name.toLowerCase() === skill.toLowerCase())?.[1];
    return Boolean(meta?.category && !meta.trait);
  }).length;
  if (acquiredAdvancements > audits.length) return null;
  return currentSpp(player) + spent + reserved;
}

function statValue(scope: string, stat: Characteristic): number | undefined {
  const tag: Record<Characteristic, string> = { MA: "movement", ST: "strength", AG: "agility", PA: "passing", AV: "armour" };
  return numberElement(scope, tag[stat]);
}

const INJURY_STAT: Record<string, Characteristic> = {
  headinjuryav: "AV",
  smashedkneema: "MA",
  brokenarmpa: "PA",
  dislocatedhipag: "AG",
  dislocatedshoulderst: "ST",
};

function injuryStatCounts(player: string): Record<Characteristic, number> {
  const counts: Record<Characteristic, number> = { MA: 0, ST: 0, AG: 0, PA: 0, AV: 0 };
  for (const match of player.matchAll(/<injury\b[^>]*>([^<]*)<\/injury>/gi)) {
    const key = decodeXml(match[1]!).replace(/[^a-z]/gi, "").toLowerCase();
    const stat = INJURY_STAT[key];
    if (stat) counts[stat] += 1;
  }
  return counts;
}

function effectiveStatValue(player: string, position: string | undefined, stat: Characteristic): number | undefined {
  const base = statValue(player, stat) ?? statValue(position ?? "", stat);
  if (base === undefined) return undefined;
  const tokens = skillNames(player).filter((skill) => skill.toUpperCase() === `+${stat}`).length;
  const injuries = injuryStatCounts(player)[stat];
  return stat === "AG" || stat === "PA" ? base - tokens + injuries : base + tokens - injuries;
}

function statImprovements(player: string, position: string | undefined): Record<Characteristic, number> {
  const out: Record<Characteristic, number> = { MA: 0, ST: 0, AG: 0, PA: 0, AV: 0 };
  if (!position) return out;
  for (const stat of Object.keys(out) as Characteristic[]) {
    const base = statValue(position, stat);
    const current = statValue(player, stat) ?? base;
    if (base === undefined || current === undefined) continue;
    out[stat] = stat === "AG" || stat === "PA" ? Math.max(0, base - current) : Math.max(0, current - base);
    out[stat] = Math.max(out[stat], skillNames(player).filter((skill) => skill.toUpperCase() === `+${stat}`).length);
  }
  return out;
}

function advancementCount(player: string, position: string | undefined): number {
  const advancementSkills = skillNames(player).filter((skill) => {
    if (/^\+(?:MA|ST|AG|PA|AV)$/i.test(skill)) return false;
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
  const characteristics = Object.fromEntries((['MA', 'ST', 'AG', 'PA', 'AV'] as Characteristic[]).map((stat) => [stat, effectiveStatValue(player, position, stat) ?? null])) as Record<Characteristic, number | null>;
  const addedSkillValue = skillNames(player).reduce((sum, skill) => {
    const found = Object.entries(bb2025.skills).find(([name]) => name.toLowerCase() === skill.toLowerCase());
    if (!found?.[1].category || found[1].trait) return sum;
    const base = secondaryCategories.includes(found[1].category) ? 40_000 : 20_000;
    return sum + base + (found[1].elite ? 10_000 : 0);
  }, 0);
  const characteristicValue = Object.entries(statImprovements(player, position)).reduce((sum, [stat, count]) => sum + CHARACTERISTIC_VALUE[stat as Characteristic] * count, 0);
  const primarySkills = legalSkills(primaryCategories, owned).filter((skill) => bb2025.skills[skill]?.elite !== true);
  return {
    earnedSpp: earnedSpp(player),
    advancements,
    rank: ineligible ? "Ineligible" : (row?.rank ?? "Legend"),
    costs: !ineligible && row ? { ...row.costs } : null,
    primaryCategories: primaryCategories.filter((category) => primarySkills.some((skill) => bb2025.skills[skill]?.category === category)),
    secondaryCategories,
    primarySkills,
    secondarySkills: legalSkills(secondaryCategories, owned),
    characteristics,
    currentValue: (numberElement(position ?? '', 'cost') ?? 0) + addedSkillValue + characteristicValue,
  };
}

interface RollClaim {
  nonce: string;
  coach: string;
  teamId: string;
  playerId: string;
  revision: string;
  method: "randomPrimary" | "characteristic";
  cost: number;
  choices: string[];
  primaryFallbacks: string[];
  secondaryFallbacks: string[];
  category?: SkillCategory;
  roll?: number;
  expiresAt: number;
}

function signClaim(claim: RollClaim, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readClaim(token: string, secret: string): RollClaim | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [payload, signature] = parts;
  if (!payload || !signature) return undefined;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let provided: Buffer;
  try { provided = Buffer.from(signature, "base64url"); } catch { return undefined; }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
  try {
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!isRecord(claim) || !boundedString(claim.nonce, 128) || !boundedString(claim.coach) || !boundedString(claim.teamId, 128) ||
      !boundedString(claim.playerId, 128) || !boundedString(claim.revision, 128) || !/^[a-f0-9]{64}$/.test(claim.revision) ||
      (claim.method !== "randomPrimary" && claim.method !== "characteristic") || typeof claim.cost !== "number" || !Number.isSafeInteger(claim.cost) || claim.cost <= 0 || !Number.isFinite(claim.expiresAt) ||
      !Array.isArray(claim.choices) || !claim.choices.every((choice) => boundedString(choice)) ||
      !Array.isArray(claim.primaryFallbacks) || !claim.primaryFallbacks.every((choice) => boundedString(choice)) ||
      !Array.isArray(claim.secondaryFallbacks) || !claim.secondaryFallbacks.every((choice) => boundedString(choice)) ||
      (claim.category !== undefined && (typeof claim.category !== "string" || !VALID_CATEGORIES.has(claim.category as SkillCategory))) ||
      (claim.roll !== undefined && (!Number.isSafeInteger(claim.roll) || typeof claim.roll !== "number" || claim.roll < 1 || claim.roll > 8))) return undefined;
    if (claim.method === "randomPrimary" && (claim.choices.length !== 2 || claim.category === undefined || claim.roll !== undefined || claim.primaryFallbacks.length > 0 || claim.secondaryFallbacks.length > 0)) return undefined;
    if (claim.method === "characteristic" && (claim.category !== undefined || claim.roll === undefined || claim.secondaryFallbacks.length > 0 || claim.choices.some((choice) => !VALID_CHARACTERISTICS.has(choice as Characteristic) || choice === "MA"))) return undefined;
    return claim as unknown as RollClaim;
  } catch { return undefined; }
}

interface StoredPending extends Omit<RollClaim, "coach" | "teamId" | "playerId" | "revision"> {}

function pendingBlock(player: string): string | undefined {
  return player.match(/<pendingAdvancement\b[^>]*>[\s\S]*?<\/pendingAdvancement>/i)?.[0];
}

export function parseStoredPending(player: string): StoredPending | undefined {
  const block = pendingBlock(player);
  if (!block) return undefined;
  const opening = block.match(/<pendingAdvancement\b([^>]*)>/i)?.[1] ?? "";
  const method = attr(opening, "method");
  const category = attr(opening, "category");
  const nonce = attr(opening, "nonce");
  const cost = Number(attr(opening, "cost"));
  const expiresAt = Number(attr(opening, "expiresAt"));
  const rollRaw = attr(opening, "roll");
  const roll = rollRaw === undefined ? undefined : Number(rollRaw);
  if (!boundedString(nonce, 128) || (method !== "randomPrimary" && method !== "characteristic") || !Number.isSafeInteger(cost) || cost <= 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 ||
    (category !== undefined && !VALID_CATEGORIES.has(category as SkillCategory)) || (roll !== undefined && (!Number.isSafeInteger(roll) || roll < 1 || roll > 8))) return undefined;
  const options = [...block.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/gi)].map((match) => ({
    type: attr(match[1]!, "type"), access: attr(match[1]!, "access"), value: decodeXml(match[2]!).trim(),
  }));
  if (options.some((option) => !option.value || (option.type !== "choice" && option.type !== "fallback") ||
    (option.type === "choice" && option.access !== undefined) ||
    (option.type === "fallback" && option.access !== "primary" && option.access !== "secondary"))) return undefined;
  const choices = options.filter((option) => option.type === "choice").map((option) => option.value);
  const primaryFallbacks = options.filter((option) => option.type === "fallback" && option.access === "primary").map((option) => option.value);
  const secondaryFallbacks = options.filter((option) => option.type === "fallback" && option.access === "secondary").map((option) => option.value);
  if (method === "randomPrimary" && (!category || roll !== undefined || choices.length !== 2 || primaryFallbacks.length > 0 || secondaryFallbacks.length > 0)) return undefined;
  if (method === "characteristic" && (category !== undefined || roll === undefined || secondaryFallbacks.length > 0 || choices.some((choice) => !VALID_CHARACTERISTICS.has(choice as Characteristic) || choice === "MA"))) return undefined;
  return {
    nonce,
    method,
    cost,
    choices,
    primaryFallbacks,
    secondaryFallbacks,
    ...(category ? { category: category as SkillCategory } : {}),
    ...(roll !== undefined ? { roll } : {}),
    expiresAt,
  };
}

function serializePending(pending: StoredPending): string {
  const attrs = [
    `nonce="${encodeXml(pending.nonce)}"`, `method="${pending.method}"`, `cost="${pending.cost}"`, `expiresAt="${pending.expiresAt}"`,
    ...(pending.category ? [`category="${encodeXml(pending.category)}"`] : []), ...(pending.roll !== undefined ? [`roll="${pending.roll}"`] : []),
  ].join(" ");
  const options = [
    ...pending.choices.map((value) => `<option type="choice">${encodeXml(value)}</option>`),
    ...pending.primaryFallbacks.map((value) => `<option type="fallback" access="primary">${encodeXml(value)}</option>`),
    ...pending.secondaryFallbacks.map((value) => `<option type="fallback" access="secondary">${encodeXml(value)}</option>`),
  ].join("");
  return `<pendingAdvancement ${attrs}>${options}</pendingAdvancement>`;
}

function setPending(player: string, pending: StoredPending): string {
  const block = pendingBlock(player);
  if (block) return player.replace(block, serializePending(pending));
  return player.replace(/<\/player>/i, `${serializePending(pending)}</player>`);
}

function clearPending(player: string): string {
  const block = pendingBlock(player);
  return block ? player.replace(block, "") : player;
}

function findTeamPending(xml: string): { playerId: string; pending: StoredPending } | undefined {
  for (const match of xml.matchAll(/<player\b[^>]*>[\s\S]*?<\/player>/gi)) {
    const pending = parseStoredPending(match[0]!);
    const playerId = attr(match[0]!.match(/<player\b[^>]*>/i)?.[0] ?? "", "id");
    if (pending && playerId) return { playerId: decodeXml(playerId), pending };
  }
  return undefined;
}

function claimForStored(auth: AdvancementIdentity, teamId: string, playerId: string, revision: string, pending: StoredPending, expiresAt: number): RollClaim {
  return { coach: auth.coach, teamId, playerId, revision, ...pending, expiresAt };
}

function pendingResponse(claim: RollClaim, secret: string): PendingAdvancementResponse {
  return {
    token: signClaim(claim, secret), playerId: claim.playerId, revision: claim.revision, method: claim.method, cost: claim.cost,
    choices: [...claim.choices], primaryFallbacks: [...claim.primaryFallbacks], secondaryFallbacks: [...claim.secondaryFallbacks],
    expiresAt: new Date(claim.expiresAt).toISOString(), ...(claim.roll !== undefined ? { roll: claim.roll } : {}),
  };
}

/** Reissue a transport token for a durable XML reservation without rerolling or re-debiting. */
export function pendingAdvancementForPlayer(
  auth: AdvancementIdentity,
  teamId: string,
  playerId: string,
  revision: string,
  player: string,
  tokenSecret: string,
  now = Date.now(),
): PendingAdvancementResponse | null {
  const pending = parseStoredPending(player);
  if (!pending) return null;
  return pendingResponse(claimForStored(auth, teamId, playerId, revision, pending, now + TOKEN_TTL_MS), tokenSecret);
}

function characteristicChoices(roll: number, player: string, position: string): Characteristic[] {
  const byRoll: Record<number, Characteristic[]> = {
    1: ["AV"], 2: ["AV", "PA"], 3: ["AV", "MA", "PA"], 4: ["AV", "MA", "PA"],
    5: ["MA", "PA"], 6: ["AG", "MA"], 7: ["AG", "ST"], 8: ["MA", "ST", "AG", "PA", "AV"],
  };
  const improvements = statImprovements(player, position);
  return byRoll[roll]!.filter((stat) => {
    if (stat === "MA") return false;
    if (improvements[stat] >= 2) return false;
    const base = statValue(position, stat);
    const current = effectiveStatValue(player, position, stat) ?? base;
    if (current === undefined || (stat === "PA" && current <= 0)) return false;
    return stat === "AG" || stat === "PA" ? current > CHARACTERISTIC_MAX[stat] : current < CHARACTERISTIC_MAX[stat];
  });
}

export function runtimeSafeCharacteristicAvailable(player: string, roster: string | undefined): boolean {
  const positionId = element(player, "positionId") ?? attr(player.match(/<player\b[^>]*>/i)?.[0] ?? "", "positionId") ?? "";
  const position = positionBlock(roster, positionId);
  if (!position) return false;
  return Array.from({ length: 8 }, (_unused, index) => index + 1).some((roll) => characteristicChoices(roll, player, position).length > 0) ||
    playerProgression(player, roster).primarySkills.length > 0;
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
  void position;
  return appendSkill(player, `+${stat}`);
}

function appendAudit(player: string, attrs: Record<string, string | number>): string {
  const entry = `<advancement ${Object.entries(attrs).map(([key, value]) => `${key}="${encodeXml(String(value))}"`).join(" ")}/>`;
  if (/<advancementList\s*\/>/i.test(player)) return player.replace(/<advancementList\s*\/>/i, `<advancementList>${entry}</advancementList>`);
  if (/<\/advancementList>/i.test(player)) return player.replace(/<\/advancementList>/i, `${entry}</advancementList>`);
  return player.replace(/<\/player>/i, `<advancementList>${entry}</advancementList></player>`);
}

function bumpTeamValues(xml: string, delta: number, currentDelta: number): string {
  if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(currentDelta)) throw new Error("advancement TV delta is not a safe integer");
  const bumps: Array<[string, number, "gold" | "units" | "dialect"]> = [
    ["teamValue", delta, "gold"], ["currentTeamValue", currentDelta, "dialect"], ["tournamentWeight", delta, "gold"],
    ["teamRating", delta, "units"], ["teamStrength", currentDelta, "units"], ["rating", delta, "units"], ["strength", currentDelta, "units"],
  ];
  // Aggregate fields precede player blocks in both supported dialects. Limiting replacements to
  // that header prevents the legacy `<strength>` aggregate name from ever touching a player's ST.
  const firstPlayer = xml.search(/<player\b/i);
  let out = firstPlayer === -1 ? xml : xml.slice(0, firstPlayer);
  const tail = firstPlayer === -1 ? "" : xml.slice(firstPlayer);
  const builderDialect = /<(?:teamRating|teamStrength)\b/i.test(out);
  const present = new Set<string>();
  for (const [tag, amount, dialect] of bumps) {
    const occurrences = [...out.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"))];
    if (!occurrences.length) continue;
    present.add(tag);
    if (occurrences.length !== 1) throw new Error(`advancement TV found duplicate ${tag} aggregates`);
    const element = occurrences[0]![0];
    const exact = element.match(new RegExp(`^<${tag}\\b[^>]*>\\s*(\\d+)\\s*</${tag}>$`, "i"));
    if (!exact) throw new Error(`advancement TV found a malformed ${tag} aggregate`);
    const before = Number(exact[1]);
    const applied = dialect === "units" || (dialect === "dialect" && builderDialect) ? amount / 10_000 : amount;
    const next = before + applied;
    if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(applied) || !Number.isSafeInteger(next) || next < 0) {
      throw new Error(`advancement TV cannot safely update ${tag}`);
    }
    out = out.replace(element, element.replace(exact[1]!, String(next)));
  }
  const hasTotal = builderDialect
    ? present.has("teamRating") || present.has("rating")
    : present.has("teamValue") || present.has("tournamentWeight");
  const hasCurrent = present.has("currentTeamValue") || present.has("teamStrength") || present.has("strength");
  if (!hasTotal || !hasCurrent) throw new Error("advancement TV requires one supported total and current aggregate dialect");
  return out + tail;
}

function isMng(player: string): boolean {
  if (/<injury\b[^>]*\brecovering="true"/i.test(player)) return true;
  const opening = player.match(/<player\b[^>]*>/i)?.[0] ?? "";
  const status = attr(opening, "status") ?? "";
  const mng = attr(opening, "mng") ?? element(player, "mng") ?? element(player, "missNextGame") ?? "";
  return /^(1|true)$/i.test(mng) || /^(mng|miss[ _-]?next[ _-]?game)$/i.test(status);
}

function endpointError(status: 400 | 401 | 404 | 409 | 422 | 500 | 503, error: string): AdvancementEndpointResult {
  return { status, body: { error } };
}

function mutationError(error: string): AdvancementEndpointResult {
  if (/activity could not be verified/i.test(error)) return endpointError(503, error);
  if (/game started during/i.test(error)) return endpointError(409, error);
  return endpointError(500, error);
}

export function advancementPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/teams\/([^/]+)\/advancement$/);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { return undefined; }
}

async function persistMutation(
  path: string,
  originalXml: string,
  updatedXml: string,
  deps: AdvancementDeps,
  library?: { coach: string; before: LibraryTeam; after: LibraryTeam },
  durableReservation = false,
  postCheckTeamId?: string,
): Promise<string | undefined> {
  let wroteXml = false;
  let wroteLibrary = false;
  let attemptedReload = false;
  let transaction: TeamXmlTransactionHandle | undefined;
  try {
    if (!durableReservation) {
      transaction = beginTeamXmlTransaction({
        teamsDir: deps.teamsDir!, teamId: postCheckTeamId!, targetPath: path, teamXml: updatedXml,
        ...(library ? { library: { baseDir: deps.libraryDir, coach: library.coach, team: library.after } } : {}),
      });
    }
    if (durableReservation) {
      markForkCacheReloadRequired(deps.teamsDir!, `Pending advancement for team ${postCheckTeamId} requires a fork cache reload.`);
    }
    atomicWriteTextFile(path, updatedXml);
    wroteXml = true;
    if (library) {
      upsertLibraryTeam(deps.libraryDir, library.coach, library.after);
      wroteLibrary = true;
    }
    // Recheck before reload while every game can still only have loaded the prior cache
    // generation. If one started since the precheck, rollback is generation-safe. There
    // remains a narrow reload-window race that requires a fork-visible maintenance lease.
    if (postCheckTeamId && deps.isTeamActive) {
      let active: boolean;
      try { active = await deps.isTeamActive(postCheckTeamId); }
      catch { throw new Error("pre-reload team activity could not be verified"); }
      if (active) throw new Error("a game started during the team update");
    }
    if (deps.reload) {
      attemptedReload = true;
      const reload = await deps.reload();
      if (!reload.reloaded) throw new Error(reload.reason ?? "fork reload did not complete");
    }
    if (durableReservation && deps.reload) acknowledgeForkCacheReload(deps.teamsDir!);
    if (transaction) commitTeamXmlTransaction(transaction);
    return undefined;
  } catch (error) {
    // A server-owned roll must never be discarded after it has been durably written: otherwise a
    // transient reload refusal lets the caller retry for fresh random options. Pending metadata is
    // ignored by the game runtime and active games are excluded, so it remains authoritative on disk
    // and is reissued on the next request/detail read.
    if (durableReservation && wroteXml && !wroteLibrary && !/activity|game started/i.test((error as Error).message)) return undefined;
    try {
      if (transaction) restoreTeamXmlTransaction(transaction);
      else {
        if (wroteXml) atomicWriteTextFile(path, originalXml);
        if (wroteLibrary) upsertLibraryTeam(deps.libraryDir, library!.coach, library!.before);
      }
      // A reload implementation may throw after the fork has observed the new XML. Once disk and
      // metadata are restored, make one best-effort reload of the restored state before returning.
      if (attemptedReload && deps.reload) {
        try {
          const restored = await deps.reload();
          if (!restored.reloaded) throw new Error(restored.reason ?? "restored generation reload refused");
        } catch (reloadError) {
          markForkCacheReloadRequired(deps.teamsDir!, `Advancement rollback could not be loaded: ${(reloadError as Error).message}`);
          return `The team update was rolled back on disk, but the fork cache could not be restored. Mutations are disabled until recovery reloads it: ${(reloadError as Error).message}`;
        }
      }
      if (durableReservation && !attemptedReload) acknowledgeForkCacheReload(deps.teamsDir!);
      if (transaction) acknowledgeRestoredTeamXmlTransaction(transaction);
    } catch (rollbackError) {
      return `The team update failed and rollback also failed: ${(rollbackError as Error).message}`;
    }
    return `The team update was rolled back because it could not be applied coherently: ${(error as Error).message}`;
  }
}

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function claimMatchesPending(claim: RollClaim, pending: StoredPending): boolean {
  return claim.nonce === pending.nonce && claim.method === pending.method && claim.cost === pending.cost &&
    claim.category === pending.category && claim.roll === pending.roll && sameStrings(claim.choices, pending.choices) &&
    sameStrings(claim.primaryFallbacks, pending.primaryFallbacks) && sameStrings(claim.secondaryFallbacks, pending.secondaryFallbacks);
}

export async function teamAdvancementEndpoint(auth: AdvancementIdentity | undefined, teamId: string, rawAction: unknown, deps: AdvancementDeps): Promise<AdvancementEndpointResult> {
  if (!auth) return endpointError(401, "Authentication required.");
  if (!boundedString(teamId, 128)) return endpointError(400, "A valid team id is required.");
  const parsedAction = parseAdvancementAction(rawAction);
  if (!parsedAction.ok) return endpointError(400, parsedAction.error);
  const action = parsedAction.action;
  if (!deps.teamsDir) return endpointError(503, "Fork teams dir not configured on this host (set FORK_TEAMS_DIR).");
  const preStored = readLibrary(deps.libraryDir, auth.coach).find((team) => team.teamId === teamId);
  const preFound = teamFile(deps.teamsDir, teamId);
  if (!preStored || !coachNamesEqual(preStored.coach, auth.coach) || !preFound || !coachNamesEqual(element(preFound.xml, "coach") ?? "", auth.coach)) {
    return endpointError(404, "Team not found.");
  }
  const now = deps.now?.() ?? Date.now();
  const generationLock = acquireTeamNameWriteLock(deps.teamsDir, now);
  if (!generationLock) return endpointError(409, "Another team/cache generation update is in progress. Refresh and try again.");
  const lock = acquireTeamWriteLock(deps.teamsDir, teamId, now);
  if (!lock) {
    generationLock.release();
    return endpointError(409, "Another team update or recovery reload is in progress. Refresh and try again.");
  }
  try {
    const stored = readLibrary(deps.libraryDir, auth.coach).find((team) => team.teamId === teamId);
    if (!stored || !coachNamesEqual(stored.coach, auth.coach)) return endpointError(404, "Team not found.");
    if (stored.retired) return endpointError(409, "Retired teams cannot gain advancements.");
    const found = teamFile(deps.teamsDir, teamId);
    if (!found || !coachNamesEqual(element(found.xml, "coach") ?? "", auth.coach)) return endpointError(404, "Team not found.");
    if (!deps.isTeamActive) return endpointError(503, "Team activity could not be verified; progression is unavailable until the fork admin API is configured.");
    let active: boolean;
    try { active = await deps.isTeamActive(teamId); }
    catch { return endpointError(503, "Team activity could not be verified right now; progression is unavailable."); }
    if (active) return endpointError(409, "This team has a game in progress and cannot be advanced.");
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
    if (!Number.isSafeInteger(spp) || spp < 0) return endpointError(422, "This player's stored SPP balance is invalid.");
    const randomIndex = deps.randomIndex ?? ((length: number) => randomInt(length));
    const pendingCount = [...found.xml.matchAll(/<pendingAdvancement\b/gi)].length;
    const teamPending = findTeamPending(found.xml);
    if (pendingCount > 1) return endpointError(409, "This team contains multiple pending advancements and must be repaired before progression can continue.");
    if (pendingCount === 1 && !teamPending) return endpointError(409, "This team contains an unreadable pending advancement and must be repaired before progression can continue.");
    if (teamPending?.playerId === action.playerId) {
      const pending = teamPending.pending;
      const expectedCost = progression.costs[pending.method];
      const legalPending = pending.cost === expectedCost && (pending.method === "randomPrimary"
        ? pending.category !== undefined && progression.primaryCategories.includes(pending.category) && pending.choices.every((skill) => progression.primarySkills.includes(skill) && bb2025.skills[skill]?.category === pending.category)
        : pending.roll !== undefined && pending.choices.every((choice) => characteristicChoices(pending.roll!, originalPlayer, position).includes(choice as Characteristic)) && pending.primaryFallbacks.every((skill) => progression.primarySkills.includes(skill)) && pending.secondaryFallbacks.length === 0);
      if (!legalPending) return endpointError(409, "This team's pending advancement is no longer runtime-safe and requires organizer recovery.");
    }

    if (action.action === "rollRandomPrimary" || action.action === "rollCharacteristic") {
      const requestedMethod = action.action === "rollRandomPrimary" ? "randomPrimary" : "characteristic";
      if (teamPending) {
        if (teamPending.playerId !== action.playerId || teamPending.pending.method !== requestedMethod ||
          (action.action === "rollRandomPrimary" && teamPending.pending.category !== action.category)) {
          return endpointError(409, "This team already has a pending advancement roll. Resolve it before rolling again.");
        }
        return { status: 200, body: { pending: pendingResponse(claimForStored(auth, teamId, action.playerId, revision, teamPending.pending, now + TOKEN_TTL_MS), deps.tokenSecret) } };
      }
    } else if (teamPending) {
      if (action.action !== "commitRoll" || teamPending.playerId !== action.playerId) {
        return endpointError(409, "This team has a pending advancement roll. Resolve it before another advancement.");
      }
    }

    if (action.action === "rollRandomPrimary") {
      const cost = progression.costs.randomPrimary;
      if (spp < cost) return endpointError(422, `This player needs ${cost} SPP for a random Primary Skill.`);
      if (!progression.primaryCategories.includes(action.category)) return endpointError(422, "That is not a Primary Skill category for this player.");
      const eligible = progression.primarySkills.filter((skill) => bb2025.skills[skill]?.category === action.category && bb2025.skills[skill]?.elite !== true);
      if (!eligible.length) return endpointError(422, "No legal random Primary Skills remain in that category.");
      const pick = (): string => {
        const index = randomIndex(eligible.length);
        if (!Number.isSafeInteger(index) || index < 0 || index >= eligible.length) throw new Error("The server random source returned an invalid index.");
        return eligible[index]!;
      };
      let choices: string[];
      try { choices = [pick(), pick()]; } catch { return endpointError(500, "The advancement roll could not be generated safely."); }
      const pending: StoredPending = { nonce: randomBytes(18).toString("base64url"), method: "randomPrimary", cost, choices, primaryFallbacks: [], secondaryFallbacks: [], category: action.category, expiresAt: now + TOKEN_TTL_MS };
      const updatedPlayer = setPending(setCurrentSpp(originalPlayer, spp - cost), pending);
      const updatedXml = found.xml.replace(originalPlayer, updatedPlayer);
      const saveError = await persistMutation(found.path, found.xml, updatedXml, deps, undefined, true, teamId);
      if (saveError) return mutationError(saveError);
      return { status: 200, body: { pending: pendingResponse(claimForStored(auth, teamId, action.playerId, teamRevision(updatedXml), pending, now + TOKEN_TTL_MS), deps.tokenSecret) } };
    }

    if (action.action === "rollCharacteristic") {
      const cost = progression.costs.characteristic;
      if (spp < cost) return endpointError(422, `This player needs ${cost} SPP for a Characteristic Improvement.`);
      const rollIndex = randomIndex(8);
      if (!Number.isSafeInteger(rollIndex) || rollIndex < 0 || rollIndex >= 8) return endpointError(500, "The characteristic roll could not be generated safely.");
      const roll = rollIndex + 1;
      const choices = characteristicChoices(roll, originalPlayer, position);
      const pending: StoredPending = {
        nonce: randomBytes(18).toString("base64url"), method: "characteristic", cost, choices,
        primaryFallbacks: progression.primarySkills.filter((skill) => bb2025.skills[skill]?.elite !== true), secondaryFallbacks: [],
        roll, expiresAt: now + TOKEN_TTL_MS,
      };
      if (!pending.choices.length && !pending.primaryFallbacks.length) return endpointError(422, "This roll has no runtime-safe legal result for this player.");
      const updatedPlayer = setPending(setCurrentSpp(originalPlayer, spp - cost), pending);
      const updatedXml = found.xml.replace(originalPlayer, updatedPlayer);
      const saveError = await persistMutation(found.path, found.xml, updatedXml, deps, undefined, true, teamId);
      if (saveError) return mutationError(saveError);
      return { status: 200, body: { pending: pendingResponse(claimForStored(auth, teamId, action.playerId, teamRevision(updatedXml), pending, now + TOKEN_TTL_MS), deps.tokenSecret) } };
    }

    let method: AdvancementMethod;
    let cost: number;
    let skill: string | undefined;
    let skillAccess: "primary" | "secondary" | undefined;
    let characteristic: Characteristic | undefined;
    if (action.action === "applySkill") {
      if (action.method === "chosenSecondary") return endpointError(422, "Secondary advancements are unavailable until fork runtime pricing can be represented exactly.");
      method = "chosenPrimary";
      cost = progression.costs.chosenPrimary;
      skill = action.skill.trim();
      skillAccess = "primary";
      if (bb2025.skills[skill]?.elite === true) return endpointError(422, "Elite Skill advancements are unavailable until the fork runtime surcharge can be represented exactly.");
      if (!progression.primarySkills.includes(skill)) return endpointError(422, "That is not a legal Primary Skill for this player.");
    } else {
      const pending = parseStoredPending(originalPlayer);
      if (!pending) return endpointError(409, "This roll is no longer pending on the stored team.");
      const claim = readClaim(action.token, deps.tokenSecret);
      if (!claim || claim.expiresAt < now || !coachNamesEqual(claim.coach, auth.coach) || claim.teamId !== teamId || claim.playerId !== action.playerId || claim.revision !== revision || !claimMatchesPending(claim, pending)) {
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
          if (action.choice.access === "secondary") return endpointError(422, "Secondary fallback advancements are unavailable until fork runtime pricing can be represented exactly.");
          skillAccess = "primary";
          const eligible = claim.primaryFallbacks;
          if (!eligible.includes(skill)) return endpointError(422, "That fallback Skill was not offered by this roll.");
        }
      }
    }
    const reserved = action.action === "commitRoll";
    if (!reserved && spp < cost) return endpointError(422, `This player no longer has the required ${cost} SPP.`);
    if (skill && bb2025.skills[skill]?.elite === true) return endpointError(422, "Elite Skill advancements are unavailable until the fork runtime surcharge can be represented exactly.");
    const valueIncrease = characteristic ? CHARACTERISTIC_VALUE[characteristic] : 20_000;
    let updatedPlayer = reserved ? clearPending(originalPlayer) : setCurrentSpp(originalPlayer, spp - cost);
    if (skill) updatedPlayer = appendSkill(updatedPlayer, skill);
    if (characteristic) updatedPlayer = improveCharacteristic(updatedPlayer, characteristic, position);
    updatedPlayer = appendAudit(updatedPlayer, { method, cost, valueIncrease, ...(skill ? { skill, skillAccess: skillAccess ?? "primary" } : {}), ...(characteristic ? { characteristic } : {}), at: new Date(now).toISOString() });
    let updatedXml = found.xml.replace(originalPlayer, updatedPlayer);
    try {
      updatedXml = bumpTeamValues(updatedXml, valueIncrease, isMng(originalPlayer) ? 0 : valueIncrease);
    } catch (error) {
      return endpointError(500, error instanceof Error ? error.message : "The stored team-value aggregates are invalid.");
    }
    const meta = parseTeamXmlMeta(updatedXml);
    const saveError = await persistMutation(found.path, found.xml, updatedXml, deps, {
      coach: auth.coach, before: stored, after: { ...stored, teamValue: meta.teamValue },
    }, false, teamId);
    if (saveError) return mutationError(saveError);
    return { status: 200, body: { ok: true, revision: teamRevision(updatedXml), playerId: action.playerId, spentSpp: cost, valueIncrease } };
  } finally {
    lock.release();
    generationLock.release();
  }
}
