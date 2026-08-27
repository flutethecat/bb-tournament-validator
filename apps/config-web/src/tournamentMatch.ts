import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile, type LibraryTeam } from "@bb/fork-ops";
import { inducementWireGold, withRosteredInducementSet } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";

export interface TournamentMatchInstructions {
  treasury: number;
  inducements: Array<{ key: string; count: number }>;
}

export interface TournamentMatchSide {
  ffbCoachId: string;
  teamId: string;
  instructions: TournamentMatchInstructions;
}

export interface TournamentMatchMetadata {
  gameId: string;
  packageName?: string;
  home: TournamentMatchSide;
  away: TournamentMatchSide;
  createdAt: string;
}

interface TournamentMatchStoreFile {
  version: 1;
  matches: Record<string, TournamentMatchMetadata>;
}

const emptyStore = (): TournamentMatchStoreFile => ({ version: 1, matches: {} });

/** Build the informational predefined-inducement list and its wire-gold value. */
export function buildInstructions(
  team: LibraryTeam,
  specialRules: readonly string[] = [],
): TournamentMatchInstructions {
  const seen = new Set<string>();
  const inducements = (team.rosteredInducements ?? []).map((pick) => {
    const key = pick.key.trim();
    if (!key) throw new Error(`Team ${team.teamId} has an inducement with no catalog key.`);
    if (seen.has(key)) throw new Error(`Team ${team.teamId} lists inducement ${key} more than once.`);
    seen.add(key);
    if (!Number.isSafeInteger(pick.count) || pick.count <= 0)
      throw new Error(`Team ${team.teamId} has an invalid count for inducement ${key}.`);
    const unitGold = inducementWireGold(bb2025, key, specialRules);
    return { key, count: pick.count, unitGold };
  });

  const inducementGold = inducements.reduce(
    (total, pick) => total + pick.unitGold * pick.count,
    0,
  );
  const treasury = inducementGold;
  if (!Number.isSafeInteger(treasury)) throw new Error(`Tournament treasury for team ${team.teamId} exceeds the safe integer range.`);
  return { treasury, inducements: inducements.map(({ key, count }) => ({ key, count })) };
}

export function teamSpecialRulesFromXml(xml: string): string[] {
  const block = xml.match(/<specialRules\b[^>]*>([\s\S]*?)<\/specialRules>/i)?.[1] ?? "";
  return [...block.matchAll(/<rule\b[^>]*>([^<]+)<\/rule>/gi)].map((match) => match[1]!.trim());
}

/** Retrofit the composer-owned block only for legacy tournament XML that predates it. */
export function ensureTournamentInducementSetXml(team: LibraryTeam, xml: string): string {
  if (!/<treasury>\s*0\s*<\/treasury>/i.test(xml))
    throw new Error(`Tournament team ${team.teamId} must have <treasury>0</treasury>.`);
  const picks = team.rosteredInducements ?? [];
  const block = xml.match(/<inducementSet\b[^>]*>([\s\S]*?)<\/inducementSet>/i)?.[1];
  if (block === undefined) return withRosteredInducementSet(xml, picks, bb2025);
  if (picks.length === 0)
    throw new Error(`Tournament team ${team.teamId} has an unexpected <inducementSet>.`);
  if (/<(?:starPlayerSet|card|prayer)\b/i.test(block))
    throw new Error(`Tournament team ${team.teamId} has unsupported children in <inducementSet>.`);

  const attribute = (element: string, name: string): string | undefined =>
    element.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  const actual = (block.match(/<inducement\b[^>]*\/?\s*>/gi) ?? []).map((element) => ({
    type: attribute(element, "type") ?? "",
    value: Number(attribute(element, "value")),
    uses: Number(attribute(element, "uses")),
  }));
  const expected = picks.map((pick) => {
    const wireName = bb2025.inducements[pick.key]?.wireName;
    if (!wireName) throw new Error(`Cannot resolve fork wire name for rostered inducement "${pick.key}".`);
    return { type: wireName, value: pick.count, uses: 0 };
  });
  const byType = (left: { type: string }, right: { type: string }): number => left.type.localeCompare(right.type);
  if (JSON.stringify([...actual].sort(byType)) !== JSON.stringify([...expected].sort(byType)))
    throw new Error(`Tournament team ${team.teamId} has an <inducementSet> that does not match its rostered inducements.`);
  return xml;
}

export class TournamentMatchStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "tournament-matches.json");
  }

  private readStore(): TournamentMatchStoreFile {
    if (!existsSync(this.file)) return emptyStore();
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<TournamentMatchStoreFile>;
      if (parsed.version !== 1 || !parsed.matches || typeof parsed.matches !== "object" || Array.isArray(parsed.matches))
        return emptyStore();
      return { version: 1, matches: parsed.matches };
    } catch {
      return emptyStore();
    }
  }

  get(gameId: string): TournamentMatchMetadata | undefined {
    const matches = this.readStore().matches;
    return Object.hasOwn(matches, gameId) ? matches[gameId] : undefined;
  }

  put(metadata: TournamentMatchMetadata): TournamentMatchMetadata {
    if (!metadata.gameId.trim()) throw new Error("gameId is required for tournament match metadata.");
    const current = this.readStore();
    const next: TournamentMatchStoreFile = {
      version: 1,
      matches: { ...current.matches, [metadata.gameId]: metadata },
    };
    atomicWriteTextFile(this.file, `${JSON.stringify(next, null, 2)}\n`);
    return metadata;
  }
}

export class TournamentMatchAccessError extends Error {
  constructor(readonly status: 400 | 403, message: string) {
    super(message);
  }
}

/** Enforce participant-only reads; only admins may select an arbitrary side. */
export function instructionsForSession(
  match: TournamentMatchMetadata,
  auth: { coach: string; admin: boolean },
  requestedSide?: string | null,
): TournamentMatchInstructions {
  const side = requestedSide?.trim().toLowerCase() || undefined;
  if (side !== undefined && side !== "home" && side !== "away")
    throw new TournamentMatchAccessError(400, "side must be home or away.");

  const instructions = (selected: "home" | "away"): TournamentMatchInstructions => ({
    treasury: match[selected].instructions.treasury,
    inducements: match[selected].instructions.inducements.map(({ key, count }) => ({ key, count })),
  });

  if (auth.admin && side) return instructions(side);

  const coach = auth.coach.trim().toLowerCase();
  const ownsHome = coach !== "" && match.home.ffbCoachId.trim().toLowerCase() === coach;
  const ownsAway = coach !== "" && match.away.ffbCoachId.trim().toLowerCase() === coach;
  if (side === "home" && ownsHome) return instructions("home");
  if (side === "away" && ownsAway) return instructions("away");
  if (!side && ownsHome !== ownsAway) return instructions(ownsHome ? "home" : "away");
  if (!side && ownsHome && ownsAway)
    throw new TournamentMatchAccessError(400, "Specify ?side=home or ?side=away for this same-coach match.");
  if (auth.admin) throw new TournamentMatchAccessError(400, "Admin requests must specify ?side=home or ?side=away.");
  throw new TournamentMatchAccessError(403, "You may fetch only your own match instructions.");
}
