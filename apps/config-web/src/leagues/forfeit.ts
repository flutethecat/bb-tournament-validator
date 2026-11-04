/**
 * League fixture forfeits (spec-forfeit-and-dice-2026-11-02): the TourPlay-style forfeit dialog, from the fixtures editor
 * and from the match recorder. Organisers of the league and site admins only.
 *
 *   GET  /api/leagues/:id/seasons/:seasonId/fixtures/:fixtureId/forfeit             the dialog: rosters, eligibility, suggestions
 *   POST .../fixtures/:fixtureId/forfeit/defections  { side }                       roll defections (server roller, dice log first)
 *   POST .../fixtures/:fixtureId/forfeit             { home, away, noStandings, legalConcession }  enter the forfeit
 *   POST .../fixtures/:fixtureId/forfeit/settings    { defectionRolls: boolean }     the game's admin toggle
 *
 * Entering a forfeit replaces any hand-entered result, marks the forfeiting side(s) conceded (the F marker) and records
 * fixture.forfeit (public) + forfeitDetail (internal). It counts as an administrative result (Weekly Digest "Admin ...").
 * The roster effects are applied once, at entry: winnings and fans to the team, MVPs (4 SPP each), miss-next-game marks,
 * and the defections (the player leaves the roster for formerPlayers; captaincy and team value are recomputed). The season
 * log keeps one line per team (the team history). A fixture with a recorded game (Super FUMBBL or the recorder) is refused:
 * its rosters already took that game.
 *
 * Defections: only after an illegal concession by ONE team, only when the game's toggle is on (fixture.defectionRolls,
 * absent = on), once per fixture (the rolls are stored as a draft and applied with the forfeit; no rerolling).
 */
import { createHash } from "node:crypto";
import { cryptoRoller, rollDie, type Roller } from "../dice/roller.js";
import { fixtureLogId, newRollId, type DiceLogStore } from "../dice/log.js";
import {
  DEFECTS_ON, FORFEIT_SIDES, ForfeitInputError, MVP_SPP, defectionCandidates, mvpLimit, other, parseForfeitInput, suggestForfeit,
  type ForfeitInput, type ForfeitSide,
} from "../forfeit/rules.js";
import { postTo, seasonTarget } from "../discord/targets.js";
import { safe } from "../discord/posts.js";
import { publicNamesDefault } from "../discord/games.js";
import type { DiscordPayload, WebhookPoster } from "./discord.js";
import { postWebhook as defaultPoster } from "./discord.js";
import { addHistory, playerLeaves, setMng, teamGamesPlayed } from "./teamOps.js";
import { addLog, resultSig } from "./events.js";
import { readJsonObject } from "./http.js";
import { isLeagueOrganiser, type LeagueStore } from "./store.js";
import { refreshTeamValues } from "./teamValue.js";
import { leagueFixtureRef } from "./tabletopFixtures.js";
import { fixturePlayed } from "./tourplay.js";
import type { ForfeitDefectionRoll, LeagueFixture, LeagueRecord, LeagueTeam, SeasonRecord } from "./types.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { applyTournamentResets } from "./ladder.js";

export interface ForfeitDeps {
  store: LeagueStore;
  roller?: Roller;
  diceLog?: DiceLogStore;
  postWebhook?: WebhookPoster;
  now?: () => Date;
  /** GAME_PAGES_PUBLIC_PLAYER_LINES for the webhook report (default: the Discord setting). */
  publicNames?: () => boolean;
}
export interface ForfeitWho { coach: string; admin: boolean }
export interface ForfeitIds { leagueId: string; seasonId: string; fixtureId: string }

const NO_STORE = { "cache-control": "no-store" };
const ok = (status: number, body: unknown): LeagueApiResult => ({ status, body, headers: { ...NO_STORE } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => ok(status, { error, ...extra });

interface Located { league: LeagueRecord; season: SeasonRecord; fixture: LeagueFixture }
function locate(store: LeagueStore, ids: ForfeitIds, who: ForfeitWho): Located | LeagueApiResult {
  const league = store.league(ids.leagueId);
  if (!league) return fail(404, "League not found.");
  if (!who.admin && !isLeagueOrganiser(league, who.coach)) return fail(403, "Only this league's organisers and site admins can enter a forfeit.");
  const season = store.season(league.id, ids.seasonId);
  if (!season) return fail(404, "Season not found.");
  const fixture = season.fixtures.find((f) => f.id === ids.fixtureId);
  if (!fixture) return fail(404, "Fixture not found.");
  return { league, season, fixture };
}
const isResult = (x: Located | LeagueApiResult): x is LeagueApiResult => "status" in x;

const teamOf = (season: SeasonRecord, f: LeagueFixture, s: ForfeitSide): LeagueTeam | undefined => {
  const side = f[s];
  return (side.teamId ? season.teams.find((t) => t.id === side.teamId) : undefined)
    ?? season.teams.find((t) => t.name.trim().toLowerCase() === side.team.trim().toLowerCase());
};
export const defectionsOn = (f: Pick<LeagueFixture, "defectionRolls">): boolean => f.defectionRolls !== false;

/** Any defection roll is in this fixture's dice log (a draft, or an attempt that logged some rolls before failing). */
function defectionsLogged(deps: Pick<ForfeitDeps, "diceLog">, ids: ForfeitIds): boolean {
  return (deps.diceLog?.read(fixtureLogId(leagueFixtureRef(ids.leagueId, ids.seasonId, ids.fixtureId))) ?? []).some((r) => r.kind === "defection");
}

/** Why a forfeit cannot be entered on this fixture now ("" = it can). */
function blockedReason(f: LeagueFixture): string {
  if (f.fork?.result) return "This fixture has a Super FUMBBL result: its rosters already took that game. Reset the game first.";
  if (f.tabletop?.opId) return "This fixture has a recorded result from the match recorder. Undo it in the recorder first.";
  if (f.forfeit) return "This fixture is already forfeited. Undo the forfeit first to enter it again.";
  return "";
}

/** GET: the dialog's model. */
export function forfeitModel(deps: ForfeitDeps, ids: ForfeitIds, who: ForfeitWho): LeagueApiResult {
  const at = locate(deps.store, ids, who);
  if (isResult(at)) return at;
  const { season, fixture: f } = at;
  const players = Object.fromEntries(FORFEIT_SIDES.map((s) => {
    const team = teamOf(season, f, s);
    const eligible = new Map((team ? defectionCandidates(team.players, team.race, season.ruleset) : []).map((c) => [c.playerId, c.advancements]));
    return [s, (team?.players ?? []).map((p) => ({
      playerId: p.playerId, name: p.name, number: p.number, position: p.position,
      missNextGame: p.missNextGame, defectionEligible: eligible.has(p.playerId), ...(eligible.has(p.playerId) ? { advancements: eligible.get(p.playerId) } : {}),
    }))];
  }));
  return ok(200, {
    fixture: {
      id: f.id, round: f.round, phase: f.phase,
      home: { team: f.home.team, coach: f.home.coach, teamId: f.home.teamId ?? null, score: f.home.score, conceded: f.home.conceded },
      away: { team: f.away.team, coach: f.away.coach, teamId: f.away.teamId ?? null, score: f.away.score, conceded: f.away.conceded },
      played: fixturePlayed(f),
      ...(f.forfeit ? { forfeit: f.forfeit } : {}),
    },
    ruleset: season.ruleset,
    defectionRolls: defectionsOn(f),
    players,
    suggestions: {
      home: suggestForfeit({ home: true, away: false }),
      away: suggestForfeit({ home: false, away: true }),
      both: suggestForfeit({ home: true, away: true }),
    },
    /** The same for a legal concession: no fan loss, no MVP limits, no notes. */
    legalSuggestions: {
      home: suggestForfeit({ home: true, away: false }, true),
      away: suggestForfeit({ home: false, away: true }, true),
      both: suggestForfeit({ home: true, away: true }, true),
    },
    /** A legal concession is locked off once defections are rolled. */
    legalLocked: Boolean(f.forfeitDraft) || defectionsLogged(deps, ids),
    ...(f.forfeitDraft ? { draft: f.forfeitDraft } : {}),
    ...(f.forfeitDetail ? { applied: (({ undo: _u, ...rest }) => rest)(f.forfeitDetail) } : {}),
    blocked: blockedReason(f),
  });
}

/** POST defections: roll D6 per eligible player of the forfeiting side (logged before stored or answered). */
export function rollDefections(deps: ForfeitDeps, ids: ForfeitIds, who: ForfeitWho, body: Record<string, unknown>, opts: { matchId?: string } = {}): LeagueApiResult {
  const at = locate(deps.store, ids, who);
  if (isResult(at)) return at;
  const { season, fixture: f } = at;
  const blocked = blockedReason(f);
  if (blocked) return fail(409, blocked);
  if (!defectionsOn(f)) return fail(409, "Defection rolls are turned off for this game (its admin panel).");
  if (body.side !== "home" && body.side !== "away") return fail(400, 'side must be "home" or "away" (the team that forfeited).');
  if (body.legalConcession === true) return fail(409, "A legal concession rolls no defections.");
  const side = body.side as ForfeitSide;
  if (f.forfeitDraft) {
    if (f.forfeitDraft.side !== side) return fail(409, `Defections were already rolled for the ${f.forfeitDraft.side} team.`, { draft: f.forfeitDraft });
    // rolled earlier (the fixtures editor, or before a restart): the recorder's own dice log gets each roll once
    if (opts.matchId && deps.diceLog) {
      const draft = f.forfeitDraft;
      const inMatch = new Set(deps.diceLog.read(opts.matchId).map((r) => r.id));
      try {
        for (const r of draft.rolls) {
          if (!r.rollId || inMatch.has(r.rollId)) continue;
          deps.diceLog.appendRoll({
            id: r.rollId, logId: opts.matchId, at: draft.at, by: draft.by, side: draft.side, kind: "defection", purpose: `Defection roll: ${r.name}`, dice: [r.roll],
            result: { playerId: r.playerId, name: r.name, leaves: r.leaves, fixture: ids.fixtureId, league: ids.leagueId, season: ids.seasonId }, admin: true,
          });
        }
      } catch { return fail(500, "The rolls could not be copied to the match's dice log. Try again."); }
    }
    return ok(200, { draft: f.forfeitDraft, already: true });
  }
  const team = teamOf(season, f, side);
  if (!team) return fail(409, "That team is not on this season's rosters.");
  const now = (deps.now?.() ?? new Date()).toISOString();
  const roller = deps.roller ?? cryptoRoller;
  const logId = fixtureLogId(leagueFixtureRef(ids.leagueId, ids.seasonId, ids.fixtureId));
  // A roll already in this fixture's dice log (an earlier attempt whose later rolls failed to log) is reused, never rerolled.
  const logged = new Map<string, { id: string; roll: number }>();
  for (const r of deps.diceLog?.read(logId) ?? []) {
    const pid = r.result.playerId;
    if (r.kind === "defection" && r.side === side && typeof pid === "string" && !logged.has(pid)) logged.set(pid, { id: r.id, roll: r.dice[0]! });
  }
  // The recorder's own dice log shows them too (the match id), once each.
  const inMatch = new Set(opts.matchId ? (deps.diceLog?.read(opts.matchId) ?? []).map((r) => r.id) : []);
  const rolls: ForfeitDefectionRoll[] = [];
  try {
    for (const c of defectionCandidates(team.players, team.race, season.ruleset)) {
      const prior = logged.get(c.playerId);
      const roll = prior?.roll ?? rollDie(roller, 6);
      const r: ForfeitDefectionRoll = { ...c, roll, leaves: DEFECTS_ON(roll), rollId: prior?.id ?? newRollId() };
      const entry = {
        id: r.rollId!, at: now, by: who.coach, side, kind: "defection" as const, purpose: `Defection roll: ${r.name}`, dice: [r.roll],
        result: { playerId: r.playerId, name: r.name, leaves: r.leaves, fixture: ids.fixtureId, league: ids.leagueId, season: ids.seasonId }, admin: true,
      };
      // The dice log first, one roll at a time: a roll that cannot be logged is never stored or shown, and those logged
      // before the failure are reused on the retry.
      if (!prior) deps.diceLog?.appendRoll({ ...entry, logId });
      if (opts.matchId && !inMatch.has(r.rollId!)) deps.diceLog?.appendRoll({ ...entry, logId: opts.matchId });
      rolls.push(r);
    }
  } catch {
    return fail(500, "The rolls could not be logged, so they were not made. Try again.");
  }
  f.forfeitDraft = { side, rolls, at: now, by: who.coach };
  deps.store.putSeason(season);
  return ok(201, { draft: f.forfeitDraft });
}

/** POST settings: the game's admin toggle for defection rolls. */
export function setDefectionRolls(deps: ForfeitDeps, ids: ForfeitIds, who: ForfeitWho, on: unknown): LeagueApiResult {
  const at = locate(deps.store, ids, who);
  if (isResult(at)) return at;
  if (typeof on !== "boolean") return fail(400, "defectionRolls must be true or false.", { field: "defectionRolls" });
  if (on) delete at.fixture.defectionRolls; else at.fixture.defectionRolls = false;
  addLog(at.season, { at: (deps.now?.() ?? new Date()).toISOString(), by: who.coach, kind: "forfeit", fixtureId: at.fixture.id, text: `${at.fixture.home.team} vs ${at.fixture.away.team}: defection rolls turned ${on ? "on" : "off"}.` });
  deps.store.putSeason(at.season);
  return ok(200, { defectionRolls: defectionsOn(at.fixture) });
}

const playerLabel = (p: { name: string; number?: number | null }, publicNames: boolean): string =>
  publicNames ? `${p.number !== undefined && p.number !== null ? `#${p.number} ` : ""}${p.name}` : `Player ${p.number ?? "?"}`;

/** The end-of-match Discord report for a forfeit, with the defection rolls (players who left / stayed). */
export function buildForfeitPost(league: Pick<LeagueRecord, "name">, season: Pick<SeasonRecord, "name">, f: LeagueFixture, publicNames: boolean): DiscordPayload {
  const h = safe(f.home.team, 60);
  const a = safe(f.away.team, 60);
  const fo = f.forfeit!;
  const head = fo.home && fo.away ? `Admin loss: ${h} and ${a} both forfeited.` : fo.home ? `Admin win: ${a} over ${h} (${h} forfeited).` : `Admin win: ${h} over ${a} (${a} forfeited).`;
  const lines = [head, `Result ${f.home.score ?? 0} - ${f.away.score ?? 0}.`];
  if (fo.noStandings) lines.push("No effect on standings.");
  for (const s of FORFEIT_SIDES) if (fo.penalty?.[s]) lines.push(`${safe(f[s].team, 60)}: ${fo.penalty[s]} penalty point${fo.penalty[s] === 1 ? "" : "s"}.`);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  const d = f.forfeitDetail?.defections;
  if (d) {
    const team = safe(f[d.side].team, 60);
    const left = d.rolls.filter((r) => r.leaves).map((r) => `${safe(playerLabel(r, publicNames), 60)} (rolled ${r.roll})`);
    const stayed = d.rolls.filter((r) => !r.leaves).map((r) => `${safe(playerLabel(r, publicNames), 60)} (rolled ${r.roll})`);
    if (!d.rolls.length) fields.push({ name: `Defections: ${team}`, value: "No player had enough advancements to roll." });
    else {
      fields.push({ name: `Left ${team}`, value: (left.join("\n") || "Nobody").slice(0, 1024) });
      fields.push({ name: `Stayed with ${team}`, value: (stayed.join("\n") || "Nobody").slice(0, 1024) });
    }
  }
  const round = [f.phase && f.phase !== "Regular" ? f.phase : "", f.round ? `Round ${f.round}` : ""].filter(Boolean).join(", ");
  return {
    username: "Super FUMBBL",
    embeds: [{
      title: `${f.test ? "[Test] " : ""}${safe(league.name, 120)}: forfeit`.slice(0, 256),
      description: `${lines.join("\n")}${round ? `\n${round}` : ""}`.slice(0, 2000),
      color: 0xe8b02c,
      ...(fields.length ? { fields } : {}),
      footer: { text: safe(season.name, 120) },
    }],
    allowed_mentions: { parse: [] },
  } as DiscordPayload;
}

export interface ApplyForfeitOptions {
  /** The recorder match entering this forfeit: a retry for the same match answers the forfeit already applied (idempotent). */
  matchId?: string;
  /** false = do not post the Discord report here (the caller posts it with announceForfeit after its own writes). */
  announce?: boolean;
}

/** A stable fingerprint of the two rosters (the undo refuses when either changed since the forfeit applied). */
const rosterHash = (teams: Array<LeagueTeam | undefined>): string => createHash("sha256").update(JSON.stringify(teams.map((t) => t ?? null))).digest("hex");

/** Posts the forfeit's end-of-match report once (forfeitDetail.announcedAt marks it; a retry never posts twice). */
export async function announceForfeit(deps: ForfeitDeps, ids: ForfeitIds): Promise<boolean> {
  const league = deps.store.league(ids.leagueId);
  const season = league ? deps.store.season(league.id, ids.seasonId) : undefined;
  const f = season?.fixtures.find((x) => x.id === ids.fixtureId);
  if (!league || !season || !f?.forfeit || !f.forfeitDetail || f.forfeitDetail.announcedAt) return false;
  f.forfeitDetail.announcedAt = (deps.now?.() ?? new Date()).toISOString();
  deps.store.putSeason(season);
  try {
    const names = deps.publicNames ? deps.publicNames() : publicNamesDefault();
    return await postTo(seasonTarget(deps.store, league, season.id), "matchResult", buildForfeitPost(league, season, f, names), deps.postWebhook ?? defaultPoster);
  } catch { return false; }
}

/**
 * POST undo: reverses an applied forfeit exactly (both rosters back to their state before it, the fixture's result too),
 * refused when either roster changed since. The defection rolls are kept as the fixture's draft: entering the forfeit again
 * reuses them, never rerolls.
 */
export function undoForfeit(deps: ForfeitDeps, ids: ForfeitIds, who: ForfeitWho, opts: { matchId?: string } = {}): LeagueApiResult {
  const at = locate(deps.store, ids, who);
  if (isResult(at)) return at;
  const { season, fixture: f } = at;
  const d = f.forfeitDetail;
  if (!f.forfeit || !d) return fail(409, "This fixture has no forfeit to undo.");
  // Entered from the match recorder: undone there, which also reopens the recorder match (never left closed by a forfeit
  // that no longer exists).
  if (d.matchId && d.matchId !== opts.matchId) return fail(409, "This forfeit was entered in the match recorder. Undo it there (Admin, Forfeit details): that also reopens the match.", { matchId: d.matchId });
  if (!d.undo) return fail(409, "This forfeit cannot be reversed automatically. Correct the rosters by hand.");
  const teams = { home: teamOf(season, f, "home"), away: teamOf(season, f, "away") };
  if (rosterHash([teams.home, teams.away]) !== d.undo.afterHash)
    return fail(409, "A roster changed since the forfeit was entered, so it cannot be reversed automatically. Correct the rosters by hand.");
  const iso = (deps.now?.() ?? new Date()).toISOString();
  for (const s of FORFEIT_SIDES) {
    const before: LeagueTeam | undefined = d.undo.teams[s];
    const i = before ? season.teams.findIndex((t) => t.id === before.id) : -1;
    if (i >= 0) {
      season.teams[i] = structuredClone(before!);
      addHistory(season.teams[i]!, { at: iso, by: who.coach, kind: "forfeit", changes: [{ what: `Forfeit v ${f[other(s)].team} undone`, to: "roster restored" }] });
    }
  }
  const r = d.undo.fixture;
  f.home.score = r.home.score; f.home.cas = r.home.cas; f.home.conceded = r.home.conceded;
  f.away.score = r.away.score; f.away.cas = r.away.cas; f.away.conceded = r.away.conceded;
  if (r.finishedAt) f.finishedAt = r.finishedAt; else delete f.finishedAt;
  if (r.resultEdit) f.resultEdit = r.resultEdit; else delete f.resultEdit;
  if (r.deadlineOutcome) f.deadlineOutcome = r.deadlineOutcome; else delete f.deadlineOutcome;
  if (d.defections) f.forfeitDraft = { side: d.defections.side, rolls: d.defections.rolls, at: d.at, by: d.by };
  delete f.forfeit;
  delete f.forfeitDetail;
  if (f.announced) delete f.announced.result;
  // the snapshot is the stored roster as it was (its team value included): nothing is recomputed over it
  season.resultsChangedAt = iso;
  addLog(season, { at: iso, by: who.coach, kind: "forfeit", fixtureId: f.id, text: `${f.home.team} vs ${f.away.team}: forfeit undone; rosters restored.` });
  deps.store.putSeason(season);
  return ok(200, { ok: true, ...(f.forfeitDraft ? { draft: f.forfeitDraft } : {}) });
}

/** POST: enter the forfeit (validated, applied once to the fixture and both rosters, logged, announced). */
export async function applyForfeit(deps: ForfeitDeps, ids: ForfeitIds, who: ForfeitWho, body: Record<string, unknown>, opts: ApplyForfeitOptions = {}): Promise<LeagueApiResult> {
  const at = locate(deps.store, ids, who);
  if (isResult(at)) return at;
  const { season, fixture: f } = at;
  // A retry from the same recorder match (its close did not finish) answers the forfeit it already applied.
  if (opts.matchId && f.forfeit && f.forfeitDetail?.matchId === opts.matchId)
    return ok(200, { ok: true, already: true, forfeit: f.forfeit, score: { home: f.home.score ?? 0, away: f.away.score ?? 0 }, revision: season.revision });
  const blocked = blockedReason(f);
  if (blocked) return fail(409, blocked);
  const teams = { home: teamOf(season, f, "home"), away: teamOf(season, f, "away") };
  const rosters = { home: new Set((teams.home?.players ?? []).map((p) => p.playerId)), away: new Set((teams.away?.players ?? []).map((p) => p.playerId)) };
  let input: ForfeitInput;
  try { input = parseForfeitInput(body, rosters); } catch (e) {
    if (e instanceof ForfeitInputError) return fail(400, e.message, e.field ? { field: e.field } : {});
    throw e;
  }
  const single: ForfeitSide | undefined = input.home.forfeit !== input.away.forfeit ? (input.home.forfeit ? "home" : "away") : undefined;
  // Legality is locked once defections are rolled: a legal concession would quietly discard the departures.
  if ((f.forfeitDraft || defectionsLogged(deps, ids)) && input.legalConcession) return fail(409, "Defections were already rolled for this fixture, so the concession cannot be marked legal.", { field: "legalConcession" });
  // A legal concession carries none of FFB's illegal-concession penalties: the conceder's fan loss is dropped unless the
  // organiser overrides it on purpose (overridePenalties).
  const ignored: string[] = [];
  if (input.legalConcession && body.overridePenalties !== true)
    for (const s of FORFEIT_SIDES) if (input[s].forfeit && input[s].fans < 0) { input[s].fans = 0; ignored.push(`${s}.fans`); }
  // Defections: an illegal concession by one team, toggle on, and rolled first (the draft); the draft must be that team's.
  let defections: { side: ForfeitSide; rolls: ForfeitDefectionRoll[] } | undefined;
  if (single && !input.legalConcession && defectionsOn(f)) {
    const team = teams[single];
    const due = team ? defectionCandidates(team.players, team.race, season.ruleset).length : 0;
    if (f.forfeitDraft && f.forfeitDraft.side !== single) return fail(409, `Defections were rolled for the ${f.forfeitDraft.side} team, which is not the one forfeiting. Clear the result to start again.`);
    if (due && !f.forfeitDraft) return fail(409, "Roll the defections first.", { field: "defections" });
    defections = { side: single, rolls: f.forfeitDraft?.rolls ?? [] };
  }
  // A defecting player gets no MVP and misses nothing: he is gone.
  const gone = new Set((defections?.rolls ?? []).filter((r) => r.leaves).map((r) => r.playerId));
  for (const s of FORFEIT_SIDES) {
    if (defections?.side === s && input[s].mvp.some((id) => gone.has(id))) return fail(400, "A player who left the team cannot be an MVP.", { field: `${s}.mvp` });
    if (input[s].mvp.length > mvpLimit(input, s)) return fail(400, "Too many MVPs for this team.", { field: `${s}.mvp` });
  }
  const now = deps.now?.() ?? new Date();
  const iso = now.toISOString();
  // What the undo restores: both rosters and the fixture's result as they were before this forfeit.
  const undoTeams = { ...(teams.home ? { home: structuredClone(teams.home) } : {}), ...(teams.away ? { away: structuredClone(teams.away) } : {}) };
  const undoFixture = {
    home: { score: f.home.score, cas: f.home.cas, conceded: f.home.conceded }, away: { score: f.away.score, cas: f.away.cas, conceded: f.away.conceded },
    ...(f.finishedAt ? { finishedAt: f.finishedAt } : {}), ...(f.resultEdit ? { resultEdit: f.resultEdit } : {}), ...(f.deadlineOutcome ? { deadlineOutcome: f.deadlineOutcome } : {}),
  };

  // The fixture: the F markers and the score; any typed result or deadline outcome is replaced.
  f.home.score = input.home.score;
  f.away.score = input.away.score;
  f.home.cas = f.away.cas = null;
  f.home.conceded = input.home.forfeit;
  f.away.conceded = input.away.forfeit;
  f.finishedAt = iso;
  delete f.resultEdit;
  delete f.deadlineOutcome;
  if (f.tabletop) f.tabletop = { revision: f.tabletop.revision + 1 }; // a waiting recorder match sees "reported elsewhere"
  const penalty = { home: input.home.forfeit ? input.home.penalty : 0, away: input.away.forfeit ? input.away.penalty : 0 };
  f.forfeit = { home: input.home.forfeit, away: input.away.forfeit, ...(input.noStandings ? { noStandings: true as const } : {}), ...(penalty.home || penalty.away ? { penalty } : {}), at: iso };
  f.forfeitDetail = {
    by: who.coach, at: iso, legalConcession: input.legalConcession,
    sides: { home: pickSide(input, "home"), away: pickSide(input, "away") },
    ...(defections ? { defections } : {}),
    ...(opts.matchId ? { matchId: opts.matchId } : {}),
  };
  delete f.forfeitDraft;

  // The rosters (the league is the record): applied once, here.
  const changed: string[] = [];
  for (const s of FORFEIT_SIDES) {
    const i = teams[s] ? season.teams.indexOf(teams[s]!) : -1;
    if (i < 0) continue;
    const before = season.teams[i]!;
    const team = structuredClone(before);
    const x = input[s];
    if (x.winnings) team.treasury = Math.max(0, (team.treasury ?? 0) + x.winnings);
    if (x.fans) team.fans = Math.max(1, (team.fans ?? 1) + x.fans);
    for (const id of x.mvp) {
      const p = team.players.find((q) => q.playerId === id);
      if (!p) continue;
      p.stats.mvp += 1;
      p.stats.spp += MVP_SPP;
      p.availableSpp = (p.availableSpp || 0) + MVP_SPP;
    }
    // Miss next game through the team page's bookkeeping (served once the team has played one more game).
    const played = teamGamesPlayed(season, team.id);
    for (const id of x.missNextGame) { const p = team.players.find((q) => q.playerId === id); if (p) setMng(p, true, played); }
    const history: string[] = [];
    if (defections?.side === s) {
      // Through the shared leave path (teamOps.playerLeaves): former-player record and Team Captain vacancy in one place.
      for (const r of defections.rolls) if (r.leaves) playerLeaves(team, r.playerId, "defected");
      const left = defections.rolls.filter((r) => r.leaves).map((r) => `${r.name} (${r.roll})`);
      const stayed = defections.rolls.filter((r) => !r.leaves).map((r) => `${r.name} (${r.roll})`);
      history.push(defections.rolls.length
        ? `Defections after the forfeit: ${left.length ? `left ${left.join(", ")}` : "nobody left"}${stayed.length ? `; stayed ${stayed.join(", ")}` : ""}.`
        : "Defections after the forfeit: no player had enough advancements to roll.");
    }
    season.teams[i] = team;
    changed.push(team.id);
    const bits = [
      x.forfeit ? "forfeited" : "won by forfeit",
      x.winnings ? `winnings ${x.winnings > 0 ? "+" : ""}${x.winnings}` : "",
      x.fans ? `Dedicated Fans ${x.fans > 0 ? "+" : ""}${x.fans}` : "",
      x.mvp.length ? `MVP ${x.mvp.map((id) => team.players.find((p) => p.playerId === id)?.name ?? id).join(", ")}` : "",
      x.missNextGame.length ? `miss next game ${x.missNextGame.map((id) => team.players.find((p) => p.playerId === id)?.name ?? id).join(", ")}` : "",
    ].filter(Boolean);
    addLog(season, { at: iso, by: who.coach, kind: "forfeit", fixtureId: f.id, teamId: team.id, text: `${team.name} v ${f[other(s)].team}: ${bits.join("; ")}.` });
    for (const text of history) addLog(season, { at: iso, by: who.coach, kind: "defection", fixtureId: f.id, teamId: team.id, text: `${team.name}: ${text}` });
    // The team's own history (team page): what the forfeit changed, one line each.
    addHistory(team, { at: iso, by: who.coach, kind: "forfeit", changes: [
      { what: `${x.forfeit ? "Forfeited" : "Won by forfeit"} v ${f[other(s)].team}` },
      ...(x.winnings ? [{ what: "Treasury", from: String(before.treasury ?? 0), to: String(team.treasury ?? 0) }] : []),
      ...(x.fans ? [{ what: "Dedicated Fans", from: String(before.fans ?? 1), to: String(team.fans ?? 1) }] : []),
      ...x.mvp.map((id) => ({ what: `MVP: ${team.players.find((p) => p.playerId === id)?.name ?? id}`, to: `+${MVP_SPP} SPP` })),
      ...x.missNextGame.map((id) => ({ what: `Miss next game: ${team.players.find((p) => p.playerId === id)?.name ?? id}` })),
      ...(defections?.side === s ? defections.rolls.map((r) => ({ what: `Defection roll ${r.roll}: ${r.name}`, to: r.leaves ? "left the team" : "stayed" })) : []),
    ] });
  }
  if (changed.length) refreshTeamValues(season, changed, { now });
  // A tournament-style ladder resets its rosters in the write that records a result (LeagueStore.putSeason): reset them
  // here first, so the undo's "after" fingerprint is the roster as stored (the reset is idempotent; the store finds it done).
  applyTournamentResets(season);
  f.forfeitDetail.undo = { teams: undoTeams, fixture: undoFixture, afterHash: rosterHash([teamOf(season, f, "home"), teamOf(season, f, "away")]) };
  season.resultsChangedAt = iso;
  const sig = resultSig(f);
  f.announced = { ...(f.announced ?? {}), result: sig };
  addLog(season, { at: iso, by: who.coach, kind: "match-result", fixtureId: f.id, sig, text: `${f.home.team} ${f.home.score} - ${f.away.score} ${f.away.team} (forfeit)` });
  deps.store.putSeason(season);

  // The end-of-match report after the writes (a draft league or a webhook-less competition posts nothing; the cleaned
  // sender stars words). The recorder posts it itself, after closing its match.
  const posted = opts.announce === false ? false : await announceForfeit(deps, ids);
  const { undo: _u, ...detail } = f.forfeitDetail;
  return ok(200, { ok: true, forfeit: f.forfeit, score: { home: f.home.score ?? 0, away: f.away.score ?? 0 }, detail, posted, ...(ignored.length ? { ignored } : {}), revision: season.revision });
}

const pickSide = (input: ForfeitInput, s: ForfeitSide) => ({ winnings: input[s].winnings, fans: input[s].fans, mvp: [...input[s].mvp], missNextGame: [...input[s].missNextGame] });

/** The routes (league api.ts tries this before the fixtures editor). undefined = not a forfeit route. */
export async function leagueForfeitRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps & Partial<ForfeitDeps>,
): Promise<LeagueApiResult | undefined> {
  const [first, seasonId, what, fixtureId, kind, sub, ...more] = rest;
  if (first !== "seasons" || what !== "fixtures" || !seasonId || !fixtureId || kind !== "forfeit" || more.length) return undefined;
  if (sub !== undefined && sub !== "defections" && sub !== "settings" && sub !== "undo") return undefined;
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!league) return fail(404, "League not found.");
  const ids = { leagueId: league.id, seasonId, fixtureId };
  const who = { coach: auth.coach, admin: auth.admin };
  const fdeps: ForfeitDeps = { store: deps.store, roller: deps.roller, diceLog: deps.diceLog, postWebhook: deps.postWebhook, now: deps.now, publicNames: deps.publicNames };
  if (sub === undefined && (method === "GET" || method === "HEAD")) return forfeitModel(fdeps, ids, who);
  if (method !== "POST") return fail(405, sub === undefined ? "Use GET or POST." : "Use POST.");
  const body = await readJsonObject(deps, 64 * 1024);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  if (sub === "defections") return rollDefections(fdeps, ids, who, body.value);
  if (sub === "settings") return setDefectionRolls(fdeps, ids, who, body.value.defectionRolls);
  if (sub === "undo") return undoForfeit(fdeps, ids, who);
  return applyForfeit(fdeps, ids, who, body.value);
}
