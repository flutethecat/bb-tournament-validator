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

function timestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()} ${date.getUTCHours()}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export function renderNafTournamentXml(input: NafExportInput): string {
  const problems: string[] = [];
  const identities = new Map<string, { name: string; number: string }>();
  const teams = new Map<string, { race: string; rating: number }>();
  const relevantEntrants = input.entrants.filter((entrant) => entrant.tournamentId === input.tournament.id);
  for (const entrant of relevantEntrants) {
    const canonical = input.identityRecord(entrant.coach.ffbCoachId);
    const name = canonical?.identities.nafName?.trim();
    const number = canonical?.identities.nafId?.trim();
    if (!name) problems.push(`${entrant.coach.ffbCoachId}: missing NAF name`);
    if (!number) problems.push(`${entrant.coach.ffbCoachId}: missing NAF number`);
    else if (!/^\d+$/.test(number)) problems.push(`${entrant.coach.ffbCoachId}: NAF number must contain digits only`);
    if (name && number && /^\d+$/.test(number)) identities.set(entrant.id, { name, number });
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
  const completed = input.matches.filter((match) => match.tournamentId === input.tournament.id && match.away && match.status === "completed" && match.result);
  if (!completed.length) problems.push("tournament has no completed two-coach matches");
  if (problems.length) throw new NafExportError([...new Set(problems)]);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
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
    lines.push("\t<game>", `\t\t<timeStamp>${xml(timestamp(result.reportedAt))}</timeStamp>`);
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
  return `${lines.join("\n")}\n`;
}
