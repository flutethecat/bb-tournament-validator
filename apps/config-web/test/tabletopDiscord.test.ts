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
