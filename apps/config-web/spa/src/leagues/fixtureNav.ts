// League page, Fixtures tab: the header nav bar's pure helpers (round strip, current round, round / team filter, the
// table view's status chip) and the per-viewer Cards | Table choice. No DOM except the guarded localStorage access.

import { concedeOf, fixturePlayed, type PhaseGroup } from "./league";
import type { LeagueFixture } from "./types";

/** A round number, or every round. */
export type RoundPick = number | "all";

/** Every round number across the given phases, ascending, once each. */
export function fixtureRounds(groups: PhaseGroup[]): number[] {
  return [...new Set(groups.flatMap((g) => g.rounds.map((r) => r.round)))].sort((a, b) => a - b);
}

/** The round to open on: the first round with an unplayed fixture, else the last round, else every round. */
export function currentRound(groups: PhaseGroup[]): RoundPick {
  const rounds = fixtureRounds(groups);
  const open = rounds.find((n) => groups.some((g) => g.rounds.some((r) => r.round === n && r.played < r.fixtures.length)));
  return open ?? rounds[rounds.length - 1] ?? "all";
}

/** `?round=` as a pick: "all", or a round the season has; anything else is no pick (the current round applies). */
export function parseRound(raw: unknown, rounds: number[]): RoundPick | undefined {
  if (raw === "all") return "all";
  const n = typeof raw === "string" && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  return rounds.includes(n) ? n : undefined;
}

/** The neighbours of a pick in the round strip (no neighbours from "all"). */
export function roundSteps(rounds: number[], pick: RoundPick): { prev?: number; next?: number } {
  if (pick === "all") return {};
  const i = rounds.indexOf(pick);
  return { ...(i > 0 ? { prev: rounds[i - 1] } : {}), ...(i >= 0 && i < rounds.length - 1 ? { next: rounds[i + 1] } : {}) };
}

/** Teams that appear in the fixtures, A to Z. */
export function fixtureTeams(groups: PhaseGroup[]): string[] {
  const names = new Set<string>();
  for (const g of groups) for (const r of g.rounds) for (const f of r.fixtures) { names.add(f.home.team); names.add(f.away.team); }
  return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/** The groups narrowed to one round and/or one team; empty rounds and phases drop out. `played` follows the filter. */
export function filterFixtures(groups: PhaseGroup[], round: RoundPick, team: string): PhaseGroup[] {
  return groups
    .map((g) => ({
      ...g,
      rounds: g.rounds
        .filter((r) => round === "all" || r.round === round)
        .map((r) => {
          const fixtures = team ? r.fixtures.filter((f) => f.home.team === team || f.away.team === team) : r.fixtures;
          return { ...r, fixtures, played: fixtures.filter(fixturePlayed).length };
        })
        .filter((r) => r.fixtures.length),
    }))
    .filter((g) => g.rounds.length);
}

export type FixtureStatusTone = "ok" | "soon" | "urgent" | "muted";
/** The table view's status chip: Played, Forfeit (a concession), Suspended / Not played, Overdue (a scheduled date that
 *  has passed, unplayed) or Scheduled. `today` is YYYY-MM-DD. */
export function fixtureStatus(f: LeagueFixture, today: string): { label: string; tone: FixtureStatusTone } {
  if (concedeOf(f) || f.home.conceded || f.away.conceded) return { label: "Forfeit", tone: "soon" };
  const played = fixturePlayed(f);
  if (f.suspended) return { label: played ? "Suspended" : "Not played", tone: "muted" };
  if (played) return { label: "Played", tone: "ok" };
  if (f.date && f.date < today) return { label: "Overdue", tone: "urgent" };
  return { label: "Scheduled", tone: "muted" };
}

export type FixturesView = "cards" | "table";
export const FIXTURES_VIEW_KEY = "sf-league-fixtures-view";
/** The viewer's last Cards | Table choice; cards when storage is missing, blocked or holds anything else. */
export function readFixturesView(): FixturesView {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(FIXTURES_VIEW_KEY) === "table" ? "table" : "cards"; } catch { return "cards"; }
}
export function writeFixturesView(v: FixturesView): void {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(FIXTURES_VIEW_KEY, v); } catch { /* no storage */ }
}

/** A filter choice that the (new) season still offers, else "" / "all" (the filter is off). */
export const keepTeam = (team: string, teams: string[]): string => (teams.includes(team) ? team : "");
export const keepPhase = (phase: string, phases: string[]): string => (phases.includes(phase) ? phase : "all");

/** The score link's accessible name keeps the visible score: "Fixture summary: A 2–2 B" ("A vs B" unplayed). */
export function scoreLinkLabel(f: Pick<LeagueFixture, "home" | "away">): string {
  const mid = f.home.score !== null && f.away.score !== null ? `${f.home.score}–${f.away.score}` : "vs";
  return `Fixture summary: ${f.home.team} ${mid} ${f.away.team}`;
}

/** A pending fixture whose lobby is worth opening: no score yet, not suspended, both sides have a coach account, and no
 *  deadline outcome other than "waiting for the organiser" (the server decides the rest; mirrors deadlines.ts). */
export function fixtureOpenForLobby(f: LeagueFixture): boolean {
  if (f.suspended || f.home.score !== null || f.away.score !== null) return false;
  if (f.deadlineOutcome && f.deadlineOutcome.outcome !== "review") return false;
  return Boolean(f.home.coachId && f.away.coachId);
}

// ---- Collapsible phase panels (owner 11-02): a completed phase (every fixture played) starts collapsed, the current and
// coming ones open; each viewer's own toggles are remembered per league in localStorage (guarded: no storage = defaults).

/** localStorage key holding one league's phase toggles: { "<seasonId>:<phaseId>": open }. */
export const phaseFoldKey = (leagueId: string): string => `sf-league-fixtures-phases:${leagueId}`;
/** The toggle id of a season's phase (phase ids repeat across seasons). */
export const phaseFoldId = (seasonId: string, phaseId: string): string => `${seasonId}:${phaseId}`;

/** Every fixture of the phase is played (a phase without fixtures is not complete). */
export const phaseComplete = (g: Pick<PhaseGroup, "rounds">): boolean =>
  g.rounds.length > 0 && g.rounds.every((r) => r.fixtures.length > 0 && r.played >= r.fixtures.length);

export type PhaseFolds = Record<string, boolean>;

/** A league's remembered toggles ({} when none, unreadable or no storage). */
export function readPhaseFolds(leagueId: string): PhaseFolds {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = JSON.parse(localStorage.getItem(phaseFoldKey(leagueId)) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k, v]) => k.length <= 200 && typeof v === "boolean")) as PhaseFolds;
  } catch { return {}; }
}

/** Remembers one toggle (best effort). */
export function writePhaseFold(leagueId: string, id: string, open: boolean): PhaseFolds {
  const next = { ...readPhaseFolds(leagueId), [id]: open };
  try { if (typeof localStorage !== "undefined") localStorage.setItem(phaseFoldKey(leagueId), JSON.stringify(next)); } catch { /* no storage */ }
  return next;
}

/** Open or collapsed: the viewer's toggle, else collapsed when the phase is complete. */
export const phaseOpen = (folds: PhaseFolds, id: string, g: Pick<PhaseGroup, "rounds">): boolean => folds[id] ?? !phaseComplete(g);
