/**
 * Browse leagues (owner 11-02): the extra public facts each row of GET /api/leagues carries, so the list page can show a
 * status chip, the place and the Registration open call to action, and search every identifying field of a league.
 *
 * Public data only. The picks below are deliberate: team names and coach display names (both already public on every
 * season read), season names, the league's town and state / province (never the street or the postcode), and its regions.
 * Never an email, phone, Discord id, NAF name, coach account id or any organiser-only flag.
 */
import { seasonStage } from "./lifecycle.js";
import { seasonWindowStatus } from "./seasonRegistration.js";
import type { LeagueRecord, SeasonRecord } from "./types.js";

export type LeagueBrowseStatus = "in-progress" | "registration" | "finished" | "off-season";

export interface LeagueBrowseInfo {
  /** The newest season's stage: active = in progress, registration, completed = finished; setup or no season = off-season. */
  status: LeagueBrowseStatus;
  /** A coach can join the newest season now (seasonWindowStatus: published, not started unless mid-season joins, dates). */
  registrationOpen: boolean;
  /** "Town, ST" from the league address when known (never street or postcode). */
  location?: string;
  /** The organiser's regions (coaches pick one at join). */
  regions: string[];
  /** A demo / test league (League settings test flag or the demo seed script). */
  test?: true;
  /** Every season's name, newest first. */
  seasons: string[];
  /** Every team that has played or registered in any season, once each: team name plus the coach's display name. */
  teams: Array<{ name: string; coach: string }>;
}

const MAX_TEAMS = 400;

export function leagueBrowseStatus(seasons: readonly SeasonRecord[]): LeagueBrowseStatus {
  const newest = [...seasons].sort((a, b) => b.number - a.number)[0];
  if (!newest) return "off-season";
  const stage = seasonStage(newest);
  return stage === "active" ? "in-progress" : stage === "registration" ? "registration" : stage === "completed" ? "finished" : "off-season";
}

export function leagueLocation(league: Pick<LeagueRecord, "address">): string | undefined {
  const a = league.address;
  if (!a) return undefined;
  const text = [a.locality, a.region].map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean).join(", ");
  return text || undefined;
}

export function leagueBrowseInfo(league: LeagueRecord, seasons: readonly SeasonRecord[], now: Date = new Date()): LeagueBrowseInfo {
  const ordered = [...seasons].sort((a, b) => b.number - a.number);
  const newest = ordered[0];
  const seen = new Set<string>();
  const teams: LeagueBrowseInfo["teams"] = [];
  const add = (name: unknown, coach: unknown) => {
    const n = typeof name === "string" ? name.trim() : "";
    if (!n || teams.length >= MAX_TEAMS) return;
    const c = typeof coach === "string" ? coach.trim() : "";
    const key = `${n.toLowerCase()}\0${c.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    teams.push({ name: n, coach: c });
  };
  for (const s of ordered) {
    for (const t of s.teams ?? []) add(t.name, t.coach);
    for (const p of s.participants ?? []) add(p.team, p.coach);
  }
  const location = leagueLocation(league);
  return {
    status: leagueBrowseStatus(ordered),
    registrationOpen: newest ? seasonWindowStatus(league, newest, now).open : false,
    ...(location ? { location } : {}),
    regions: Array.isArray(league.regions) ? league.regions.filter((r): r is string => typeof r === "string" && r.trim() !== "").map((r) => r.trim()) : [],
    ...(league.test === true ? { test: true as const } : {}),
    seasons: ordered.map((s) => s.name).filter((n) => typeof n === "string" && n !== ""),
    teams,
  };
}
