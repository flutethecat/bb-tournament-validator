/**
 * Match recorder -> Discord webhook (optional). One embed per pre-game milestone, for the BloodBowl bot to pick up.
 *
 *   env DISCORD_RECORDER_WEBHOOK_URL   unset = off. The URL is a secret: it is never logged or echoed.
 *
 * `recorderAnnouncement` is pure (tests build payloads with no network); `createRecorderWebhook` owns the network side:
 * a small queue, a minimum gap between posts (Discord rate limits webhooks), a timeout, and failures that are logged
 * (without the URL) and never reach the match routes. Payload shape: docs/artifact-orchestration/spec-recorder-pregame-2026-10-30.md.
 * The bot keys on `embeds[0].footer.text` = "tabletop:<matchId> | pregame.<kind>".
 */

import type { Side, TabletopEvent } from "./events.js";

export type AnnouncementKind = "fans" | "weather" | "inducements" | "prayers" | "coin" | "skip";
export interface AnnouncementMatch {
  id: string;
  test?: boolean;
  home: { coach: string; teamName: string };
  away: { coach: string; teamName: string };
}
export interface RecorderAnnouncement { kind: AnnouncementKind; match: AnnouncementMatch; events: readonly TabletopEvent[] }

export interface DiscordEmbedField { name: string; value: string; inline?: boolean }
export interface DiscordWebhookBody {
  username: string;
  allowed_mentions: { parse: string[] };
  embeds: Array<{ title: string; description: string; color: number; fields: DiscordEmbedField[]; footer: { text: string }; timestamp: string; url?: string }>;
}

const COLORS: Record<AnnouncementKind, number> = { fans: 0xe8b84a, weather: 0x3498db, inducements: 0x9b59b6, prayers: 0xf1c40f, coin: 0x2ecc71, skip: 0x95a5a6 };
/** One plain-language effect line per weather result (our own wording; the table is at
 *  https://bloodbowlbase.ru/bb2025/core_rules/the_game_of_blood_bowl/ #weather-table). */
const WEATHER_EFFECT: Record<string, string> = {
  "Sweltering Heat": "Some players may collapse from the heat after each drive.",
  "Very Sunny": "Passing is harder in the glare.",
  "Perfect Conditions": "No effect.",
  "Pouring Rain": "The ball is slippery: catching and picking up are harder.",
  Blizzard: "Going for it is riskier and only short passes are possible.",
};
export const weatherEffect = (name: string): string => WEATHER_EFFECT[name] ?? "";

const money = (n: unknown): string => `${Math.round(Number(n ?? 0) / 1000)}k`;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Names typed by users go into Discord: neutralise mentions and markdown that could ping or break the embed. */
const safe = (s: string): string => clip(String(s).replace(/@/g, "@​").replace(/([*_`~|>\\])/g, "\\$1"), 200);
const rolled = (p: Record<string, unknown>): string => (p.rolledBy === "coach" ? "entered by the coach" : "rolled by the site");

/** The webhook body for one milestone, or undefined when the events do not carry it (nothing is posted). */
export function recorderAnnouncement(a: RecorderAnnouncement, opts: { baseUrl?: string; now?: Date } = {}): DiscordWebhookBody | undefined {
  const { match, events, kind } = a;
  const team = (s: Side) => `${safe(match[s].teamName)} (${safe(match[s].coach)})`;
  const of = (type: string, s?: Side) => events.filter((e) => e.type === type && (s === undefined || e.team === s));
  let title = "";
  let description = "";
  const fields: DiscordEmbedField[] = [];
  if (kind === "fans") {
    const f = { home: of("fans", "home")[0]?.payload, away: of("fans", "away")[0]?.payload };
    if (!f.home || !f.away) return undefined;
    title = "Fans";
    for (const s of ["home", "away"] as const)
      fields.push({ name: team(s), value: `${Number(f[s]!.dedicatedFans ?? 0)} dedicated fans + D3 ${Number(f[s]!.roll ?? 0)} = **${Number(f[s]!.total ?? 0)}** (${rolled(f[s]!)})`, inline: true });
    const h = Number(f.home.total ?? 0), w = Number(f.away.total ?? 0);
    description = h === w ? `Fan factor is even (${h} each).` : `${safe(match[h > w ? "home" : "away"].teamName)} has +${Math.abs(h - w)} fan factor.`;
  } else if (kind === "weather") {
    const w = events.find((e) => e.type === "weather" && e.payload.pregame === true)?.payload;
    if (!w) return undefined;
    const name = String(w.result ?? "");
    title = `Weather: ${name}`;
    const dice = Array.isArray(w.dice) ? (w.dice as number[]).join(" + ") : String(w.roll ?? "");
    description = `2D6 ${dice} = ${Number(w.roll ?? 0)} (${rolled(w)}). ${weatherEffect(name)}`.trim();
  } else if (kind === "inducements") {
    title = "Inducements";
    for (const s of ["home", "away"] as const) {
      const p = of("inducement", s).at(-1)?.payload;
      if (!p) return undefined;
      const picks = (p.picks as Array<{ name: string; qty: number }> | undefined) ?? [];
      fields.push({ name: team(s), value: picks.length ? `${picks.map((x) => `${x.qty} x ${safe(String(x.name))}`).join(", ")} (${money(p.total)})` : "None", inline: true });
    }
    description = "Both teams have chosen their inducements.";
  } else if (kind === "prayers") {
    const pr = of("prayer");
    if (!pr.length) return undefined;
    title = "Prayers to Nuffle";
    for (const s of ["home", "away"] as const) {
      const mine = of("prayer", s).map((e) => `${Number(e.payload.roll ?? 0)}: ${String(e.payload.name ?? "")}`);
      if (mine.length) fields.push({ name: team(s), value: mine.join("\n"), inline: true });
    }
    description = `D16 ${rolled(pr[0]!.payload)}.`;
  } else if (kind === "coin") {
    const flip = events.find((e) => e.id === "pg-coinflip");
    const choice = (events.find((e) => e.id === "pg-coinchoice")?.payload.choice ?? flip?.payload.choice) as string | undefined;
    if (!flip || (choice !== "kick" && choice !== "receive")) return undefined;
    const p = flip.payload;
    const caller = p.caller === "home" || p.caller === "away" ? p.caller : undefined;
    const winner = flip.team;
    const loser: Side = winner === "home" ? "away" : "home";
    title = `Coin flip: ${safe(match[winner].teamName)} ${choice === "kick" ? "kicks" : "receives"}`;
    description = [
      caller ? `${safe(match[caller].coach)} called ${String(p.call ?? "")}.` : "",
      `${p.mode === "hand" ? "A real coin showed" : "The coin landed"} ${String(p.result ?? "")}.`,
      `${safe(match[winner].coach)} won the toss and chose to ${choice}; ${safe(match[loser].teamName)} will ${choice === "kick" ? "receive" : "kick"}.`,
    ].filter(Boolean).join(" ");
  } else {
    const s = events.find((e) => e.type === "pregameSkip");
    if (!s) return undefined;
    title = "Pre-game skipped";
    description = `An organiser (${safe(s.by)}) skipped the pre-game; the match starts at the kick-off set-up.`;
  }
  return {
    username: "Super FUMBBL Recorder",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: clip(`${match.test ? "[Test] " : ""}${title}`, 256),
      description: clip(`${team("home")} v ${team("away")}\n${description}`, 2000),
      color: COLORS[kind],
      fields: fields.slice(0, 10),
      footer: { text: `tabletop:${match.id} | pregame.${kind}` },
      timestamp: (opts.now ?? new Date()).toISOString(),
      ...(opts.baseUrl ? { url: `${opts.baseUrl}/app/tabletop/${encodeURIComponent(match.id)}` } : {}),
    }],
  };
}

export interface RecorderWebhook {
  post(body: DiscordWebhookBody): void;
  /** Resolves when the queue is empty (tests). */
  idle(): Promise<void>;
}

/** A webhook poster, or undefined when no URL is configured. Never throws into the caller. */
export function createRecorderWebhook(opts: {
  url: string | undefined;
  fetch?: typeof fetch;
  minGapMs?: number;
  maxQueue?: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): RecorderWebhook | undefined {
  const url = opts.url?.trim();
  const log = opts.log ?? ((m: string) => console.warn(m));
  if (!url) return undefined;
  try {
    if (new URL(url).protocol !== "https:") throw new Error("not https");
  } catch {
    log("[recorder-webhook] DISCORD_RECORDER_WEBHOOK_URL is not an https URL; posting is off.");
    return undefined;
  }
  const doFetch = opts.fetch ?? fetch;
  const gap = opts.minGapMs ?? 1200;
  const maxQueue = opts.maxQueue ?? 20;
  const timeout = opts.timeoutMs ?? 5000;
  const clock = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const queue: DiscordWebhookBody[] = [];
  let running: Promise<void> | undefined;
  let last = Number.NEGATIVE_INFINITY;
  async function drain(): Promise<void> {
    while (queue.length) {
      const body = queue.shift()!;
      const wait = last + gap - clock();
      if (wait > 0) await sleep(wait);
      last = clock();
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeout);
      try {
        const res = await doFetch(url!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
        if (!res.ok) log(`[recorder-webhook] post failed: HTTP ${res.status}`);
      } catch (e) {
        log(`[recorder-webhook] post failed: ${(e as Error)?.name === "AbortError" ? "timed out" : "network error"}`);
      } finally {
        clearTimeout(t);
      }
    }
  }
  return {
    post(body) {
      try {
        queue.push(body);
        while (queue.length > maxQueue) queue.shift(); // drop the oldest when Discord is slow
        running ??= drain().finally(() => { running = undefined; });
      } catch { /* never reaches the match */ }
    },
    idle: async () => { while (running) await running; },
  };
}
