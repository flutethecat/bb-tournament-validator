import type { ScheduledMatchRecord, TournamentEntrantRecord, TournamentRecord } from "./types.js";

export interface CanonicalTournamentIdentity {
  ffbCoachId: string;
  identities: { nafName?: string; nafId?: string };
}

export interface NafExportInput {
  tournament: TournamentRecord;
  organizerCoachId: string;
  entrants: TournamentEntrantRecord[];
  matches: ScheduledMatchRecord[];
  identityRecord(coachId: string): CanonicalTournamentIdentity | undefined;
  teamBuild(teamId: string, coachId?: string): unknown | undefined;
}

export class NafExportError extends Error {
  constructor(readonly problems: string[]) {
    super(`NAF export is unavailable: ${problems.join("; ")}`);
  }
}

const xml = (value: string | number): string => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, ...fields: string[]): string | undefined {
  const record = object(value);
  for (const field of fields) {
    const candidate = record?.[field];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function rating(value: unknown): number {
  const record = object(value);
  const raw = record?.teamValue ?? record?.currentTeamValue ?? record?.value;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.round(raw / 1_000)) : 100;
}

/** NAF report time format ("2026-3-1 10:00"), shared with the tabletop CSV export. */
export function nafTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()} ${date.getUTCHours()}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export function renderNafTournamentXml(input: NafExportInput): string {
  return renderNafTournamentReport(input).xml;
}

/** A NAF report plus the warnings the organiser should fix (withdrawn coaches' games reported with NAF fields empty). */
export interface NafTournamentReport { xml: string; warnings: string[] }

/**
 * The NAF report of a tournament: every completed game. Active entrants' NAF details come from their identity record
 * (the profile) and must be complete. A withdrawn entrant is listed only when they played a completed game, with the
 * NAF details frozen on the entry when they withdrew (nafSnapshot), else the number stored with the entry; never the
 * live profile. Missing details there are a warning, not a refusal, so no game is dropped.
 */
export function renderNafTournamentReport(input: NafExportInput): NafTournamentReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const identities = new Map<string, { name: string; number: string }>();
  const teams = new Map<string, { race: string; rating: number }>();
  const completed = input.matches.filter((match) => match.tournamentId === input.tournament.id && match.away && match.status === "completed" && match.result);
  const played = new Set(completed.flatMap((match) => [match.home.entrantId, match.away!.entrantId]));
  const relevantEntrants = input.entrants.filter((entrant) => entrant.tournamentId === input.tournament.id
    && (entrant.droppedAt === undefined || played.has(entrant.id)));
  for (const entrant of relevantEntrants) {
    const coach = entrant.coach.ffbCoachId;
    if (entrant.droppedAt === undefined) {
      const canonical = input.identityRecord(coach);
      const name = canonical?.identities.nafName?.trim();
      const number = canonical?.identities.nafId?.trim();
      if (!name) problems.push(`${coach}: missing NAF name`);
      if (!number) problems.push(`${coach}: missing NAF number`);
      else if (!/^\d+$/.test(number)) problems.push(`${coach}: NAF number must contain digits only`);
      if (name && number && /^\d+$/.test(number)) identities.set(entrant.id, { name, number });
    } else {
      const name = entrant.nafSnapshot?.nafName?.trim() ?? "";
      const raw = (entrant.nafSnapshot?.nafNumber ?? entrant.nafNumber ?? "").trim();
      const number = /^\d+$/.test(raw) ? raw : "";
      if (!name) warnings.push(`${coach} (withdrawn): missing NAF name, reported empty`);
      if (!number) warnings.push(`${coach} (withdrawn): missing NAF number, reported empty`);
      identities.set(entrant.id, { name, number });
    }
    const build = input.teamBuild(entrant.teamId, entrant.coach.ffbCoachId);
    // Harvest adaptation: this tree has no registrationSnapshot, so race and TV come solely
    // from the harvested module's existing injected teamBuild fallback.
    const race = text(build, "race", "rosterName");
    if (!race) problems.push(`${entrant.coach.ffbCoachId}: team ${entrant.teamId} is missing a NAF race`);
    else teams.set(entrant.id, { race, rating: rating(build) });
  }
  const organizer = input.identityRecord(input.organizerCoachId);
  const organizerName = organizer?.identities.nafName?.trim();
  if (!organizerName) problems.push(`${input.organizerCoachId}: exporting organizer is missing a NAF name`);
  const listed = new Set(relevantEntrants.map((entrant) => entrant.id));
  for (const match of completed) for (const side of [match.home, match.away!]) {
    if (!listed.has(side.entrantId)) problems.push(`${side.coach.ffbCoachId}: a completed game has no entry in this tournament`);
  }
  if (!completed.length) problems.push("tournament has no completed two-coach matches");
  if (problems.length) throw new NafExportError([...new Set(problems)]);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    ...warnings.map((warning) => `<!-- warning: ${warning.replaceAll("--", "- -")} -->`),
    '<nafReport xmlns:blo="http://www.bloodbowl.net">',
    `\t<organizer>${xml(organizerName!)}</organizer>`,
    "\t<coaches>",
  ];
  for (const entrant of relevantEntrants) {
    const identity = identities.get(entrant.id)!;
    const team = teams.get(entrant.id)!;
    lines.push("\t\t<coach>", `\t\t\t<name>${xml(identity.name)}</name>`, `\t\t\t<number>${xml(identity.number)}</number>`, `\t\t\t<team>${xml(team.race)}</team>`, "\t\t</coach>");
  }
  lines.push("\t</coaches>");
  for (const match of completed) {
    const away = match.away!;
    const result = match.result!;
    lines.push("\t<game>", `\t\t<timeStamp>${xml(nafTimestamp(result.reportedAt))}</timeStamp>`);
    for (const [side, score, casualties] of [
      [match.home, result.homeScore, result.homeCasualties ?? 0],
      [away, result.awayScore, result.awayCasualties ?? 0],
    ] as const) {
      const identity = identities.get(side.entrantId)!;
      const team = teams.get(side.entrantId)!;
      lines.push(
        "\t\t<playerRecord>",
        `\t\t\t<name>${xml(identity.name)}</name>`,
        `\t\t\t<number>${xml(identity.number)}</number>`,
        `\t\t\t<team>${xml(team.race)}</team>`,
        `\t\t\t<teamRating>${team.rating}</teamRating>`,
        `\t\t\t<touchDowns>${score}</touchDowns>`,
        `\t\t\t<badlyHurt>${casualties}</badlyHurt>`,
        "\t\t</playerRecord>",
      );
    }
    lines.push("\t</game>");
  }
  lines.push("</nafReport>");
  return { xml: `${lines.join("\n")}\n`, warnings };
}
