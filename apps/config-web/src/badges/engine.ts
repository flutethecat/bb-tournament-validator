/**
 * The badge engine (badges lane, 11-04): recompute every site badge and achievement from history and apply the difference.
 *
 *   recompute()  ledger (src/badges/ledger.ts) -> evaluators (src/badges/evaluators.ts) -> diff with the stored awards:
 *                new awards are written (logged, by the site) and then announced; awards that no longer hold (a corrected,
 *                cleared or deleted result, a season reopened, a reign that changed) are revoked (logged). Idempotent: one
 *                award per subject per badge (per tier, per race); a second pass changes nothing.
 *   kick()       the small additive hook every result path calls through server.ts (the recorder publish / undo, a league
 *                result write, the fork sync, the TourPlay import merge, a tournament result): a recompute soon after,
 *                coalesced. The minute tick covers any path that does not kick (season end, belt reign length, club years).
 *
 * Announcements, after the write and best effort: an inbox note to the coach (type "award") and, when the competition's
 * "Badge earned" Discord event is on (off by default), a post through the cleaned sender (targets.ts postTo). Silent:
 * the first run ever, a badge the engine has never evaluated before (a new catalog entry), and any coach under deletion.
 * Drafts and test data never reach the ledger, so they never announce.
 *
 * Fails closed: an unreadable store or competition aborts the pass before anything is written (nothing is revoked from a
 * partial picture).
 */
import type { DiscordPayload, WebhookPoster } from "../leagues/discord.js";
import { postWebhook as defaultPoster } from "../leagues/discord.js";
import type { LeagueStore } from "../leagues/store.js";
import type { NotificationInput } from "../notifications.js";
import { post, safe } from "../discord/posts.js";
import type { DiscordStateStore } from "../discord/store.js";
import { leagueTarget, postTo, seasonTarget, tournamentTarget, type DiscordTarget } from "../discord/targets.js";
import type { TournamentStore } from "../tournaments/store.js";
import { badgeDefinition, badgeText, BADGE_CATALOG } from "./catalog.js";
import { evaluateCatalog, type Earned } from "./evaluators.js";
import { badgeGlyph } from "./icons.js";
import { buildBadgeLedger, recorderDetail, type BadgeLedgerSources, type RecorderResult } from "./ledger.js";
import type { BadgeFile, BadgeStore, StoredAward } from "./store.js";
import { randomBytes } from "node:crypto";

export const BADGE_TICK_MS = 60_000;
/** A full pass at least this often even with no change seen (time-based badges: reign length, club years). */
export const BADGE_FULL_PASS_MS = 15 * 60_000;
const GOLD = 0xe8b02c;

export interface BadgeEngineDeps {
  store: BadgeStore;
  /** The history sources (leagues, tournaments, clubs, recorder detail). */
  sources: () => BadgeLedgerSources | Promise<BadgeLedgerSources>;
  /** A cheap stamp that changes when any source may have (the tick skips a pass when it has not). */
  changeKey?: () => string;
  notify?: (coach: string, input: NotificationInput) => void;
  /** Discord "Badge earned": the league store (targets) and the Discord state store (tournament webhooks). */
  discord?: { leagues: Pick<LeagueStore, "league" | "secrets" | "season">; tournaments?: Pick<TournamentStore, "tournament">; state: Pick<DiscordStateStore, "config" | "webhook">; poster?: WebhookPoster };
  /** A coach under deletion earns nothing (privacy fence). */
  isFenced?: (coach: string) => boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface RecomputeOutcome { awarded: StoredAward[]; revoked: StoredAward[]; silent: boolean }

export const logId = (): string => `bl-${randomBytes(6).toString("hex")}`;

/** The pure diff: what to add and what to drop. Fenced coaches' awards are neither added nor revoked (deletion removes them). */
export function diffAwards(file: BadgeFile, earned: readonly Earned[], now: Date, fenced: (coach: string) => boolean = () => false): { add: StoredAward[]; drop: StoredAward[] } {
  const have = new Map(file.auto.map((a) => [a.key, a] as const));
  const want = new Map(earned.map((e) => [e.key, e] as const));
  const add: StoredAward[] = [];
  for (const e of earned) {
    if (have.has(e.key)) continue;
    if (e.subject.kind === "coach" && fenced(e.subject.name)) continue;
    add.push({ key: e.key, badgeId: e.badgeId, ...(e.variant ? { variant: e.variant } : {}), subject: e.subject, at: e.at, awardedAt: now.toISOString(), context: e.context });
  }
  const drop = file.auto.filter((a) => !want.has(a.key) && !(a.subject.kind === "coach" && fenced(a.subject.name)));
  return { add, drop };
}

export function awardNotice(a: Pick<StoredAward, "badgeId" | "variant" | "context">): NotificationInput | undefined {
  const def = badgeDefinition(a.badgeId);
  if (!def) return undefined;
  const t = badgeText(def, a.variant);
  return {
    type: "award", title: `${def.kind === "achievement" ? "Achievement" : "Badge"} earned: ${t.name}`,
    body: `${t.description}${a.context.label ? ` (${a.context.label})` : ""}`, link: "/home#badges", from: "", subject: t.name,
  };
}

export function badgePost(competition: string, coach: string, a: Pick<StoredAward, "badgeId" | "variant">, test = false): DiscordPayload | undefined {
  const def = badgeDefinition(a.badgeId);
  if (!def) return undefined;
  const t = badgeText(def, a.variant);
  return post(`${test ? "[Test] " : ""}${safe(competition, 100)}: ${def.kind === "achievement" ? "achievement" : "badge"} earned`, `${badgeGlyph(def.icon)} ${safe(coach, 60)} earned **${safe(t.name, 80)}**. ${safe(t.description, 200)}`, GOLD);
}

export class BadgeEngine {
  private running = false;
  private again = false;
  private kickTimer: NodeJS.Timeout | undefined;
  private lastKey = "";
  private lastFull = 0;

  constructor(private readonly deps: BadgeEngineDeps) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  /** One full pass. Throws (nothing written) when a source or the store is unreadable. */
  async recompute(): Promise<RecomputeOutcome> {
    const now = this.now();
    const sources = await this.deps.sources();
    const ledger = buildBadgeLedger(sources, now);
    const earned = evaluateCatalog(ledger, now);
    const fenced = (c: string) => this.deps.isFenced?.(c) === true;
    let outcome: RecomputeOutcome = { awarded: [], revoked: [], silent: true };
    this.deps.store.update((file) => {
      const { add, drop } = diffAwards(file, earned, now, fenced);
      const seeded = new Set(file.seeded);
      const firstRun = !file.initialisedAt;
      const at = now.toISOString();
      const dropped = new Set(drop.map((d) => d.key));
      file.auto = [...file.auto.filter((a) => !dropped.has(a.key)), ...add];
      const log = [
        ...add.map((a) => ({ id: logId(), at, action: "award" as const, badgeId: a.badgeId, ...(a.variant ? { variant: a.variant } : {}), subject: a.subject, by: "", ...(a.context.leagueId ? { leagueId: a.context.leagueId } : {}) })),
        ...drop.map((a) => ({ id: logId(), at, action: "revoke" as const, badgeId: a.badgeId, ...(a.variant ? { variant: a.variant } : {}), subject: a.subject, by: "", ...(a.context.leagueId ? { leagueId: a.context.leagueId } : {}), reason: "No longer holds (a result changed)." })),
      ];
      file.log = [...log.reverse(), ...file.log];
      file.initialisedAt ??= at;
      file.seeded = BADGE_CATALOG.filter((d) => d.status === "live").map((d) => d.id);
      // Announce only awards of badges seen before (never the first run, never a brand-new catalog entry).
      const loud = firstRun ? [] : add.filter((a) => seeded.has(a.badgeId));
      outcome = { awarded: loud, revoked: drop, silent: firstRun };
      return undefined;
    });
    await this.announce(outcome.awarded);
    if (outcome.awarded.length || outcome.revoked.length) this.deps.log?.(`[badges] ${outcome.awarded.length} awarded, ${outcome.revoked.length} revoked`);
    return outcome;
  }

  private async announce(awards: readonly StoredAward[]): Promise<void> {
    for (const a of awards) {
      if (a.subject.kind !== "coach") continue; // team milestones show on the team page; the coach's own award carries the notice
      const notice = awardNotice(a);
      if (notice) { try { this.deps.notify?.(a.subject.name, notice); } catch { /* fire-and-forget */ } }
      const target = this.targetFor(a);
      if (!target) continue;
      const payload = badgePost(target.name, a.subject.name, a, target.test);
      if (payload) await postTo(target, "badgeEarned", payload, this.deps.discord?.poster ?? defaultPoster);
    }
  }

  private targetFor(a: StoredAward): DiscordTarget | undefined {
    const d = this.deps.discord;
    if (!d) return undefined;
    try {
      if (a.context.tournamentId) {
        const t = d.tournaments?.tournament(a.context.tournamentId);
        return t ? tournamentTarget(d.state, t) : undefined;
      }
      const league = a.context.leagueId ? d.leagues.league(a.context.leagueId) : undefined;
      if (!league) return undefined;
      return a.context.seasonId ? seasonTarget(d.leagues, league, a.context.seasonId) : leagueTarget(d.leagues, league);
    } catch { return undefined; }
  }

  /** The minute tick: a pass when a source changed, or every BADGE_FULL_PASS_MS. */
  async tick(): Promise<void> {
    const key = this.deps.changeKey?.() ?? "";
    const due = Date.now() - this.lastFull >= BADGE_FULL_PASS_MS;
    if (key && key === this.lastKey && !due) return;
    await this.run();
    this.lastKey = key;
  }

  /** A result was saved somewhere: recompute shortly (coalesced). Never throws. */
  kick(delayMs = 1_500): void {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => { this.kickTimer = undefined; void this.run(); }, delayMs);
    this.kickTimer.unref?.();
  }

  private async run(): Promise<void> {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        try { await this.recompute(); this.lastFull = Date.now(); } catch (e) { this.deps.log?.(`[badges] pass skipped: ${(e as Error).message}`); }
      } while (this.again);
    } finally { this.running = false; }
  }
}

// ---- recorder detail source ---------------------------------------------------------------------------------------------

interface RecorderRepo {
  listMatches(): Promise<Array<{ id: string; state: string; fixtureRef?: string; test?: true; updatedAt: string; home: { coach: string }; away: { coach: string }; fixtureLink?: { opId: string } }>>;
  readEvents(matchId: string): Promise<Array<{ id: string; type: string; team?: string; player?: string; half?: unknown; payload: Record<string, unknown> }>>;
}

/** fixture ref -> the published recorder match's detail per coach, cached per match by its update time. */
export function recorderSource(effective: (events: never[]) => unknown[]) {
  const cache = new Map<string, { stamp: string; ref: string; result: RecorderResult }>();
  return async (repo: RecorderRepo | undefined): Promise<Map<string, RecorderResult>> => {
    const out = new Map<string, RecorderResult>();
    if (!repo) return out;
    const matches = await repo.listMatches();
    const live = new Set<string>();
    for (const m of matches) {
      if (m.test || m.state !== "published" || !m.fixtureRef || !m.fixtureLink?.opId) continue;
      live.add(m.id);
      const stamp = `${m.updatedAt}|${m.fixtureLink.opId}`;
      let hit = cache.get(m.id);
      if (!hit || hit.stamp !== stamp) {
        const events = effective((await repo.readEvents(m.id)) as never[]) as Parameters<typeof recorderDetail>[0];
        const d = recorderDetail(events);
        const byCoach = new Map([[m.home.coach.normalize("NFC").trim().toLowerCase(), d.home], [m.away.coach.normalize("NFC").trim().toLowerCase(), d.away]]);
        hit = { stamp, ref: m.fixtureRef, result: { opId: m.fixtureLink.opId, byCoach } };
        cache.set(m.id, hit);
      }
      out.set(hit.ref, hit.result);
    }
    for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
    return out;
  };
}
