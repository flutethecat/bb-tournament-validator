// The club observer (creation wizards v2 Q16 + round 3): a scheduler tick, the Discord observer's pattern (src/discord/
// observer.ts), that notices club events by comparing the clubs' ledger (src/clubs/stats.ts) with what it already handled
// (markers in the Discord state store's ledger, key "club:<id>"), so nothing is posted or told twice, across restarts.
//
//   member result      a game a member played for the club            -> the club webhook (toggle "results"), and an
//                                                                       inbox note to clubmates who opted in when it is a win
//   tournament podium  a finished tournament's top three              -> the club webhook (toggle "podiums")
//   league title       a finished season's crowned champion           -> the club webhook (toggle "titles")
//
// Only what is already public counts: the ledger never holds a draft, a ladder in setup or test data, and every competition
// it reads is authorised. An organiser-entered or -edited result is a record but never announced (owner round 3): marked,
// never posted or told. First sight of a club marks everything WITHOUT posting, so creating a club, adding a webhook or
// turning "ladder games count" on never replays history. Every ledger game is marked each pass, counted or not.

import type { DiscordPayload, WebhookPoster } from "../leagues/discord.js";
import { postWebhook as defaultPoster } from "../leagues/discord.js";
import type { NotificationInput } from "../notifications.js";
import { BRAND, post, safe } from "../discord/posts.js";
import type { DiscordStateStore } from "../discord/store.js";
import { countedGames, type ClubGame, type ClubHonour, type ClubLedger } from "./stats.js";
import type { ClubStore } from "./store.js";
import { clubCoachKey, type ClubRecord } from "./types.js";

export const CLUB_OBSERVER_TICK_MS = 60_000;
const GOLD = 0xe8b02c;
const GREEN = 0x3fa34d;

export interface ClubObserverDeps {
  store: Pick<ClubStore, "list" | "webhook">;
  ledger(): ClubLedger;
  state: Pick<DiscordStateStore, "entry" | "mark">;
  poster?: WebhookPoster;
  notify?(coach: string, input: NotificationInput): void;
  now?: () => Date;
  log?: (line: string) => void;
}

const score = (g: ClubGame): string => `${g.score.for}-${g.score.against}`;
const where = (g: { competitionName: string; seasonName?: string }): string => [g.competitionName, g.seasonName].filter(Boolean).join(" ");

export function clubResultPost(club: ClubRecord, g: ClubGame): DiscordPayload {
  const verb = g.result === "win" ? "beat" : g.result === "loss" ? "lost to" : "drew with";
  return post(
    `${safe(club.name, 100)}: member result`,
    `${safe(g.member.coach, 60)} (${safe(g.member.team, 60)}) ${verb} ${safe(g.opponent.coach, 60)} (${safe(g.opponent.team, 60)}) ${score(g)}\n${safe(where(g), 150)}${g.round ? `, ${safe(g.round, 60)}` : ""}`,
    g.result === "win" ? GREEN : GOLD,
  );
}

export function clubHonourPost(club: ClubRecord, h: ClubHonour): DiscordPayload {
  const place = h.kind === "title" ? "won the league" : h.place === 1 ? "won" : h.place === 2 ? "finished 2nd in" : "finished 3rd in";
  return post(
    `${safe(club.name, 100)}: ${h.kind === "title" ? "league title" : "tournament podium"}`,
    `${safe(h.coach, 60)}${h.team ? ` (${safe(h.team, 60)})` : ""} ${place} ${safe(where(h), 150)}.`,
    GOLD,
  );
}

export class ClubObserver {
  private running = false;
  constructor(private readonly deps: ClubObserverDeps) {}

  private get poster(): WebhookPoster { return this.deps.poster ?? defaultPoster; }
  private now(): Date { return this.deps.now?.() ?? new Date(); }

  /** One pass over every club. Never throws. Returns the posts sent plus the notes raised. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let n = 0;
    try {
      let clubs: ClubRecord[] = [];
      try { clubs = this.deps.store.list(); } catch (e) { this.deps.log?.(`[clubs] store unreadable: ${(e as Error).message}`); return 0; }
      let ledger: ClubLedger;
      try { ledger = this.deps.ledger(); } catch (e) { this.deps.log?.(`[clubs] ledger failed: ${(e as Error).message}`); return 0; }
      for (const club of clubs) {
        try { n += await this.club(club, ledger); } catch (e) { this.deps.log?.(`[clubs] club pass failed: ${(e as Error).message}`); }
      }
    } finally {
      this.running = false;
    }
    return n;
  }

  private markers(club: ClubRecord, ledger: ClubLedger): string[] {
    return [...(ledger.games.get(club.id) ?? []).map((g) => `game:${g.id}`), ...(ledger.honours.get(club.id) ?? []).map((h) => `honour:${h.id}`)];
  }

  /** The webhook ledger of the club's CURRENT connection: a new connection (webhookConnectedAt) starts a fresh one. */
  static hookKey(club: Pick<ClubRecord, "id" | "webhookConnectedAt">): string | undefined {
    return club.webhookConnectedAt ? `clubhook:${club.id}:${club.webhookConnectedAt}` : undefined;
  }

  /** A webhook was just connected: baseline every event that exists now, so only later ones post (P3). Never throws. */
  baselineWebhook(club: ClubRecord): void {
    const key = ClubObserver.hookKey(club);
    if (!key) return;
    try {
      const markers = this.markers(club, this.deps.ledger());
      this.deps.state.mark(key, markers, this.now().toISOString(), true, new Set(markers));
    } catch (e) { this.deps.log?.(`[clubs] webhook baseline failed: ${(e as Error).message}`); }
  }

  private async club(club: ClubRecord, ledger: ClubLedger): Promise<number> {
    const at = this.now().toISOString();
    const all = ledger.games.get(club.id) ?? [];
    const honours = ledger.honours.get(club.id) ?? [];
    const counted = new Set(countedGames(club, ledger).map((g) => g.id));
    const markers = this.markers(club, ledger);
    const live = new Set(markers);
    let n = 0;
    // Clubmate wins (inbox): the club's own ledger, baselined on first sight.
    const key = `club:${club.id}`;
    const known = this.deps.state.entry(key);
    const fresh = new Set(this.deps.state.mark(key, markers, at, true, live));
    if (known?.baselineAt && !club.archivedAt) {
      for (const g of all) if (fresh.has(`game:${g.id}`) && counted.has(g.id) && g.recorded && g.result === "win") n += this.tellWin(club, g);
    }
    // Webhook posts: the current connection's ledger, baselined when it was connected (or on first sight of it), so
    // nothing from before the connection posts.
    const url = this.deps.store.webhook(club.id);
    const hookKey = ClubObserver.hookKey(club);
    if (!url || !hookKey) return n;
    const hookKnown = this.deps.state.entry(hookKey);
    const hookFresh = new Set(this.deps.state.mark(hookKey, markers, at, true, live));
    if (!hookKnown?.baselineAt || club.archivedAt) return n;
    for (const g of all) {
      if (!hookFresh.has(`game:${g.id}`) || !counted.has(g.id) || !g.recorded || !club.settings.webhookEvents.results) continue;
      if (await this.send(url, clubResultPost(club, g))) n += 1;
    }
    for (const h of honours) {
      if (!hookFresh.has(`honour:${h.id}`)) continue;
      const on = h.kind === "title" ? club.settings.webhookEvents.titles : club.settings.webhookEvents.podiums;
      if (on && (await this.send(url, clubHonourPost(club, h)))) n += 1;
    }
    return n;
  }

  private async send(url: string, payload: DiscordPayload): Promise<boolean> {
    try { return (await this.poster(url, { ...payload, username: BRAND })).ok; } catch { return false; }
  }

  /** "A clubmate won": an inbox note to every other member who opted in (off by default). */
  private tellWin(club: ClubRecord, g: ClubGame): number {
    if (!this.deps.notify) return 0;
    const winner = clubCoachKey(g.member.coach);
    let n = 0;
    for (const m of club.members) {
      if (m.notify?.wins !== true || clubCoachKey(m.coach) === winner) continue;
      try {
        this.deps.notify(m.coach, {
          type: "club",
          title: `${g.member.coach} won for ${club.name}`,
          body: `${g.member.team} beat ${g.opponent.team} ${score(g)} in ${where(g)}.`,
          link: `/app/clubs/${encodeURIComponent(club.id)}?tab=results`,
          from: "",
        });
        n += 1;
      } catch { /* fire-and-forget */ }
    }
    return n;
  }
}
