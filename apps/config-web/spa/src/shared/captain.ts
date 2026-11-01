// Team Captain replacement in league play (owner 10-30; server src/captain.ts). Pure helpers the team sheets (league
// Teams tab, team management page) and the fixture lobby / pre-game read: is a captaincy vacant, who may appoint, and the
// eligible players in the shared player picker's row shape. The server decides eligibility (per-race Big Guy / Star
// data) and sends the ids; nothing here re-derives the rules.
import type { RosterPlayerView } from "../tabletop/recorder";

export const TEAM_CAPTAIN = "Team Captain";
export const CAPTAIN_VACANT_LABEL = "Captain vacant";
export const CAPTAIN_VACANT_TITLE = "Your Team Captain has left the team. Choose a new captain.";

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
export const hasTeamCaptain = (skills: readonly string[] | undefined): boolean => (skills ?? []).some((s) => norm(s) === norm(TEAM_CAPTAIN));

/**
 * Is this league team waiting for a new captain? The server flag, confirmed against the roster. The fixture lobby and
 * pre-game show a reminder chip when it is true (CaptainVacantChip.vue).
 */
export function leagueCaptainVacant(team: { captainVacant?: true; players?: ReadonlyArray<{ skills: string[] }> } | undefined | null): boolean {
  return Boolean(team?.captainVacant === true && !(team.players ?? []).some((p) => hasTeamCaptain(p.skills)));
}

/** May this viewer appoint (the team's own coach account, or an organiser / admin of the league)? */
export function canAppointCaptain(team: { coachId?: string; coachAssigned?: { cleared?: true } }, coach: string, manage: boolean): boolean {
  if (manage) return true;
  const seat = team.coachAssigned?.cleared ? "" : (team.coachId ?? "");
  return Boolean(coach && seat && norm(seat) === norm(coach));
}

/** League roster players -> the shared picker's rows (eligible ids only, in roster order). */
export function leagueCaptainRows(team: {
  players: ReadonlyArray<{ playerId: string; number: number | null; name: string; position: string; skills: string[]; availableSpp: number; missNextGame: boolean; niggling: number; ma: number | null; st: number | null; ag: number | null; pa: number | null; av: number | null }>;
  captainEligible?: string[];
}): RosterPlayerView[] {
  const ok = new Set(team.captainEligible ?? []);
  return team.players.filter((p) => ok.has(p.playerId)).map((p) => ({
    id: p.playerId, name: p.name, ...(p.number !== null ? { number: p.number } : {}), spp: p.availableSpp, mng: p.missNextGame, dead: false,
    position: p.position, positionName: p.position, skills: [...p.skills], niggles: p.niggling, ma: p.ma, st: p.st, ag: p.ag, pa: p.pa, av: p.av,
  }));
}

/** What the confirm step says the appointment gives (no second Pro for a player who already has it). */
export function captainGainText(skills: readonly string[] | undefined): string {
  const pro = (skills ?? []).some((s) => norm(s) === "pro");
  return pro ? "They gain Team Captain (they already have Pro). No cost, no team value change." : "They gain Team Captain and Pro for free. No team value change.";
}

const target = (v: string | undefined): number | null => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Team management page (fork library team) players -> the picker's rows: the eligible ids the server sent, by progress.id. */
export function libraryCaptainRows(players: ReadonlyArray<{
  number: number; name?: string; position: string; positionFull?: string; stats: { MA: number; ST: number; AG: string; PA: string; AV: string };
  printed: Array<{ name: string }>; free?: Array<{ name: string }>; added: Array<{ name: string }>; progress?: { id: string; spp: number; mng: boolean };
}>, eligible: readonly string[]): RosterPlayerView[] {
  const ok = new Set(eligible);
  return players.filter((p) => p.progress && ok.has(p.progress.id)).map((p) => ({
    id: p.progress!.id, name: p.name ?? "", number: p.number, spp: p.progress!.spp, mng: p.progress!.mng, dead: false,
    position: p.position, positionName: p.positionFull || p.position, skills: [...p.printed, ...(p.free ?? []), ...p.added].map((s) => s.name),
    ma: p.stats.MA, st: p.stats.ST, ag: target(p.stats.AG), pa: target(p.stats.PA), av: target(p.stats.AV),
  }));
}
