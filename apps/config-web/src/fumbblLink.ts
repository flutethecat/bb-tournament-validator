import type { CoachRegistryEntry } from "./data.js";

/**
 * A coach's linked FUMBBL name from the tournament coach registry (the discord-bot's coaches.json).
 *
 * 1. An entry carrying the coach's own Discord id wins (the verified association).
 * 2. Otherwise a name match: the entry's fumbblName must equal the fork coach name EXACTLY (fork names are
 *    case-sensitive, so "victimname" never matches "VictimName"), the entry must not belong to a different Discord
 *    account, and the match must be unique.
 * Anything else is null: never attribute someone else's FUMBBL identity.
 */
export function linkedFumbblNameIn(registry: readonly CoachRegistryEntry[], coach: string, discordUserId: string): string | null {
  const own = discordUserId ? registry.filter((e) => e.discordUserId === discordUserId && e.fumbblName?.trim()) : [];
  if (own.length) {
    const names = new Set(own.map((e) => e.fumbblName!.trim()));
    return names.size === 1 ? [...names][0]! : null;
  }
  const name = coach.trim();
  if (!name) return null;
  const byName = registry.filter((e) => e.fumbblName?.trim() === name);
  if (byName.length !== 1) return null;
  const entry = byName[0]!;
  if (entry.discordUserId && entry.discordUserId !== discordUserId) return null;
  return name;
}
