import { describe, expect, it } from "vitest";
import { createRecorderWebhook, recorderAnnouncement, type DiscordWebhookBody } from "../src/tabletop/discord.js";
import type { TabletopEvent } from "../src/tabletop/events.js";

// Recorder -> Discord webhook: the pure payload builder (no network) and the poster with a fake fetch.

const match = { id: "tm_abc", home: { coach: "Alice", teamName: "Reikland Reavers" }, away: { coach: "Bob", teamName: "Grim @everyone Gits" } };
let n = 0;
const e = (id: string, type: string, team: "home" | "away", payload: Record<string, unknown>, by = "Alice"): TabletopEvent =>
  ({ id: id || `x-${++n}`, matchId: "tm_abc", type: type as TabletopEvent["type"], team, payload, ts: "2026-10-30T10:00:00.000Z", by });
const now = new Date("2026-10-30T10:00:00.000Z");

describe("recorderAnnouncement", () => {
  it("fans: both teams with the D3 and who rolled; the footer names the match and milestone for the bot", () => {
    const body = recorderAnnouncement({
      kind: "fans", match,
      events: [e("pg-fans-home", "fans", "home", { roll: 3, dedicatedFans: 2, total: 5, rolledBy: "coach" }), e("pg-fans-away", "fans", "away", { roll: 1, dedicatedFans: 2, total: 3, rolledBy: "site" })],
    }, { baseUrl: "https://example.test", now })!;
    expect(body.username).toBe("Super FUMBBL Recorder");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const embed = body.embeds[0]!;
    expect(embed).toMatchObject({ title: "Fans", footer: { text: "tabletop:tm_abc | pregame.fans" }, timestamp: now.toISOString(), url: "https://example.test/app/tabletop/tm_abc" });
    expect(embed.description).toContain("Reikland Reavers has +2 fan factor.");
    expect(embed.fields[0]!.value).toContain("entered by the coach");
    expect(embed.fields[1]!.value).toContain("rolled by the site");
    // a user-typed team name cannot ping the server
    expect(JSON.stringify(body)).not.toContain("@everyone");
  });

  it("weather with the effect line; coin with the call, result and choice; skip; test matches are marked", () => {
    const weather = recorderAnnouncement({ kind: "weather", match: { ...match, test: true }, events: [e("pg-weather-0", "weather", "home", { pregame: true, roll: 11, dice: [5, 6], result: "Pouring Rain", rolledBy: "site" })] }, { now })!;
    expect(weather.embeds[0]!.title).toBe("[Test] Weather: Pouring Rain");
    expect(weather.embeds[0]!.description).toMatch(/2D6 5 \+ 6 = 11 \(rolled by the site\)\. The ball is slippery/);
    expect(weather.embeds[0]!.url).toBeUndefined();
    const coinEvents = [
      e("pg-coincaller", "coinFlip", "away", { stage: "caller", caller: "away" }),
      e("pg-coinflip", "coinFlip", "home", { mode: "auto", call: "tails", caller: "away", result: "heads", winner: "home" }),
    ];
    expect(recorderAnnouncement({ kind: "coin", match, events: coinEvents })).toBeUndefined(); // no choice yet: nothing to post
    const coin = recorderAnnouncement({ kind: "coin", match, events: [...coinEvents, e("pg-coinchoice", "coinFlip", "home", { stage: "choice", winner: "home", choice: "kick" })] }, { now })!;
    expect(coin.embeds[0]!.title).toBe("Coin flip: Reikland Reavers kicks");
    expect(coin.embeds[0]!.description).toContain("Bob called tails. The coin landed heads. Alice won the toss and chose to kick;");
    const sk = recorderAnnouncement({ kind: "skip", match, events: [e("pg-skip", "pregameSkip", "home", { from: "pregame:fans" }, "Org")] })!;
    expect(sk.embeds[0]!.title).toBe("Pre-game skipped");
  });

  it("inducements and prayers; a milestone without its events posts nothing", () => {
    const ind = recorderAnnouncement({
      kind: "inducements", match,
      events: [e("pg-inducement-away", "inducement", "away", { picks: [{ name: "Bribes", qty: 2 }], total: 100_000 }), e("pg-inducement-home", "inducement", "home", { picks: [], total: 0 })],
    })!;
    expect(ind.embeds[0]!.fields.map((f) => f.value)).toEqual(["None", "2 x Bribes (100k)"]);
    const pr = recorderAnnouncement({ kind: "prayers", match, events: [e("pg-prayer-home-1", "prayer", "home", { roll: 4, name: "Iron Man", rolledBy: "coach" })] })!;
    expect(pr.embeds[0]!.fields[0]!.value).toBe("4: Iron Man");
    for (const kind of ["fans", "weather", "inducements", "prayers", "coin", "skip"] as const) expect(recorderAnnouncement({ kind, match, events: [] })).toBeUndefined();
  });
});

describe("createRecorderWebhook", () => {
  const body = (t: string): DiscordWebhookBody => ({ username: "x", allowed_mentions: { parse: [] }, embeds: [{ title: t, description: "", color: 0, fields: [], footer: { text: "" }, timestamp: "" }] });

  it("off when the URL is unset or not https (and the URL is never logged)", () => {
    const logs: string[] = [];
    expect(createRecorderWebhook({ url: undefined })).toBeUndefined();
    expect(createRecorderWebhook({ url: "  " })).toBeUndefined();
    expect(createRecorderWebhook({ url: "http://discord.test/api/webhooks/1/secret-token", log: (m) => logs.push(m) })).toBeUndefined();
    expect(logs.join(" ")).not.toContain("secret-token");
  });

  it("posts in order with a gap between posts, drops the oldest past the queue cap, and logs failures without the URL", async () => {
    const sent: string[] = [];
    const sleeps: number[] = [];
    const logs: string[] = [];
    let t = 0;
    let fail = false;
    const hook = createRecorderWebhook({
      url: "https://discord.test/api/webhooks/1/secret-token",
      fetch: (async (_u: unknown, init: { body: string }) => {
        if (fail) throw new Error("boom https://discord.test/api/webhooks/1/secret-token");
        sent.push(JSON.parse(init.body).embeds[0].title);
        return { ok: sent.length !== 2, status: 429 } as Response;
      }) as unknown as typeof fetch,
      minGapMs: 1000, maxQueue: 2, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; },
      log: (m) => logs.push(m),
    })!;
    hook.post(body("a"));
    hook.post(body("b"));
    hook.post(body("c"));
    hook.post(body("d")); // queue cap 2: "b" is dropped ("a" is already on its way)
    await hook.idle();
    expect(sent).toEqual(["a", "c", "d"]);
    expect(sleeps).toEqual([1000, 1000]);
    expect(logs).toEqual(["[recorder-webhook] post failed: HTTP 429"]);
    fail = true;
    hook.post(body("e"));
    await hook.idle();
    expect(logs.at(-1)).toBe("[recorder-webhook] post failed: network error");
    expect(logs.join(" ")).not.toContain("secret-token");
  });
});

// Owner ruling 10-30 #6: the final result goes to Discord as one summary embed.
describe("recorderAnnouncement: the result summary", () => {
  const side = (score: number, extra: Record<string, unknown> = {}) => ({ score, casualties: { bh: 0, si: 0, rip: 0 }, conceded: false, scorers: [], mvps: [], ...extra });
  it("both teams, coaches, score, scorers, casualties, MVPs; the footer and the game-page link for the bot", () => {
    const body = recorderAnnouncement({
      kind: "result", match, events: [],
      result: {
        home: side(2, { scorers: [{ name: "Griff @here", touchdowns: 2 }], casualties: { bh: 1, si: 1, rip: 1 }, mvps: ["Griff @here"] }),
        away: side(0, { conceded: true }),
      },
    }, { baseUrl: "https://example.test", now })!;
    const embed = body.embeds[0]!;
    expect(embed.title).toBe("Result: Reikland Reavers 2 - 0 Grim @​everyone Gits");
    expect(embed.description).toContain("Reikland Reavers (Alice) v Grim @​everyone Gits (Bob)");
    expect(embed.description).toContain("Reikland Reavers win. Grim @​everyone Gits (Bob) conceded.");
    expect(embed.fields.map((f) => f.name)).toEqual(["Reikland Reavers (Alice)", "Grim @​everyone Gits (Bob)"]);
    expect(embed.fields[0]!.value).toBe("Score: **2**\nTouchdowns: Griff @​here x2\nCasualties caused: 3 (1 BH, 1 SI, 1 dead)\nMVP: Griff @​here");
    expect(embed.fields[1]!.value).toBe("Score: **0**\nTouchdowns: None\nCasualties caused: 0\nMVP: None\nConceded");
    expect(embed.footer.text).toBe("tabletop:tm_abc | result");
    expect(embed.url).toBe("https://example.test/app/games/tabletop/tm_abc");
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("a test match is marked [Test] and links its recorder (a test match has no public game page); no result, no post", () => {
    const body = recorderAnnouncement({ kind: "result", match: { ...match, test: true }, events: [], result: { home: side(1), away: side(1) } }, { baseUrl: "https://example.test" })!;
    expect(body.embeds[0]!.title).toBe("[Test] Result: Reikland Reavers 1 - 1 Grim @​everyone Gits");
    expect(body.embeds[0]!.description).toContain("A draw.");
    expect(body.embeds[0]!.url).toBe("https://example.test/app/tabletop/tm_abc");
    expect(recorderAnnouncement({ kind: "result", match, events: [] })).toBeUndefined();
  });

  it("goes through the same poster: queued, spaced, never throwing (no network)", async () => {
    const sent: string[] = [];
    let t = 0;
    const hook = createRecorderWebhook({
      url: "https://discord.example/api/webhooks/1/secret-token", minGapMs: 1200, now: () => t,
      sleep: async (ms) => { t += ms; }, fetch: (async (_u: unknown, init: { body: string }) => { sent.push(init.body); return { ok: true, status: 204 }; }) as unknown as typeof fetch,
    })!;
    hook.post(recorderAnnouncement({ kind: "result", match, events: [], result: { home: side(1), away: side(0) } })!);
    await hook.idle();
    expect(sent).toHaveLength(1);
    expect((JSON.parse(sent[0]!) as DiscordWebhookBody).embeds[0]!.footer.text).toBe("tabletop:tm_abc | result");
  });
});
