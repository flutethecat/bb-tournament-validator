import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import {
  changedKeys, COMMENT_MAX, commentLength, DM_NOTICE, groupCatalogue, isDiscordWebhook, JOIN_NOTICE, reachLines, samplesLine, timeZones, webhookLine,
} from "../spa/src/shared/discord";
import { TOURNAMENT_DISCORD_EVENTS, tournamentModeEvents } from "../spa/src/tournaments/wizard";
import { loadProfanitySetting, profanitySetting, saveProfanitySetting, shown } from "../spa/src/shared/profanity";
import { WORDS_ROT13 } from "../src/discord/profanityList";
import { browserTimeZone, TIME_ZONE_NOTE, timeZones as zoneList } from "../spa/src/shared/timeZone";
import { emptyForm, stepPayload } from "../spa/src/leagues/wizard";
import { informationPayload } from "../spa/src/leagues/settings";


/** A listed word, decoded at run time (the list stays out of test names and output). */
const LISTED = WORDS_ROT13[1]!.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));

// SPA competition Discord (league / season / tournament panels, Weekly Digest, recorder coach's comments, registration DM
// notice): the pure helpers, and the components server-rendered against a mocked fetcher. No network; webhook URLs are
// fake and only ever shown masked.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const MASKED = "https://discord.com/api/webhooks/…/•••";
const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("discord helpers", () => {
  it("webhook shape, catalogue groups, changed keys", () => {
    expect(isDiscordWebhook("https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(isDiscordWebhook("https://example.com/hook")).toBe(false);
    const g = groupCatalogue([{ key: "news", label: "News", group: "competition" }, { key: "death", label: "Player death", group: "inGame" }]);
    expect(g.competition.map((r) => r.key)).toEqual(["news"]);
    expect(g.inGame.map((r) => r.key)).toEqual(["death"]);
    expect(changedKeys({ a: true, b: false }, { a: true, b: true })).toEqual({ b: false });
  });

  it("webhook line: own, inherited from the league / series, none", () => {
    expect(webhookLine({ kind: "league", configured: true, maskedUrl: MASKED, inherited: false, parentMaskedUrl: "" })).toBe(`Posting to ${MASKED}`);
    expect(webhookLine({ kind: "season", configured: false, maskedUrl: "", inherited: true, parentMaskedUrl: MASKED })).toContain("the league's webhook");
    expect(webhookLine({ kind: "tournament", configured: false, maskedUrl: "", inherited: true, parentMaskedUrl: MASKED })).toContain("the series's webhook");
    expect(webhookLine({ kind: "tournament", configured: false, maskedUrl: "", inherited: false, parentMaskedUrl: "" })).toContain("nothing posts yet");
    expect(webhookLine({ kind: "league", configured: false, maskedUrl: "", inherited: false, parentMaskedUrl: "" })).toBe("Not connected.");
  });

  it("samples line counts what went through", () => {
    expect(samplesLine({ ok: true, posted: 7, failed: 0, total: 7 })).toBe("Sent 7 samples. Check the channel.");
    expect(samplesLine({ ok: true, posted: 1, failed: 0, total: 1 })).toBe("Sent 1 sample. Check the channel.");
    expect(samplesLine({ ok: true, posted: 3, failed: 4, total: 7 })).toBe("Sent 3 of 7 samples; 4 did not go through.");
  });

  it("registration notice: exact copy; hidden when opted out or unlinked; invite only without a shared server", () => {
    expect(DM_NOTICE).toBe("We'll message you about this event on Discord. You can turn this off in Account.");
    expect(JOIN_NOTICE).toBe("Join the Super FUMBBL Discord to get messages");
    const invite = "https://discord.gg/example";
    expect(reachLines(null)).toEqual({ dm: false, invite: null });
    expect(reachLines({ dm: "off", sharesServer: false, inviteUrl: invite, accountUrl: "" })).toEqual({ dm: false, invite: null });
    expect(reachLines({ dm: "unlinked", sharesServer: null, inviteUrl: invite, accountUrl: "" })).toEqual({ dm: false, invite: null });
    // no bot token yet ("inactive"): the notice never promises DMs that cannot be sent
    expect(reachLines({ dm: "inactive", sharesServer: null, inviteUrl: invite, accountUrl: "" })).toEqual({ dm: false, invite: null });
    expect(reachLines({ dm: "on", sharesServer: true, inviteUrl: invite, accountUrl: "" })).toEqual({ dm: true, invite: null });
    expect(reachLines({ dm: "on", sharesServer: null, inviteUrl: invite, accountUrl: "" })).toEqual({ dm: true, invite: null });
    expect(reachLines({ dm: "on", sharesServer: false, inviteUrl: invite, accountUrl: "" })).toEqual({ dm: true, invite });
    expect(reachLines({ dm: "on", sharesServer: false, inviteUrl: null, accountUrl: "" })).toEqual({ dm: true, invite: null });
  });

  it("time zones include the current one; comment length counts characters", () => {
    expect(timeZones("Mars/Olympus")[0]).toBe("Mars/Olympus");
    expect(timeZones()).toContain("UTC");
    expect(COMMENT_MAX).toBe(120);
    expect(commentLength("héllo")).toBe(5);
  });

  it("tournament wizard Discord group starts in tournament mode", () => {
    const on = Object.entries(tournamentModeEvents()).filter(([, v]) => v).map(([k]) => k).sort();
    expect(on).toEqual(["checkInOpen", "finalStandings", "matchResult", "published", "registrationClosing", "roundPosted", "roundStandings"]);
    expect(TOURNAMENT_DISCORD_EVENTS.filter((e) => !e.on).map((e) => e.key)).toContain("newRegistration");
  });

  it("the webhook never goes into the browser draft, and the panels use password inputs", () => {
    // writeDraft stores only { step, form }; the webhook lives in state.discord
    expect(src("../spa/src/tournaments/wizard.ts")).toMatch(/writeDraft\(\{ step: state\.step, form: state\.form \}\)/);
    expect(src("../spa/src/components/CompetitionDiscordPanel.vue")).toMatch(/v-model="url" type="password"/);
  });
});

describe("league time zone", () => {
  it("browser zone default, note copy, the select always lists the current zone", () => {
    expect(TIME_ZONE_NOTE).toBe("Set your league's time zone. Until then schedules use UTC.");
    expect(browserTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    expect(zoneList("Mars/Olympus")[0]).toBe("Mars/Olympus");
    expect(zoneList()).toContain("UTC");
  });

  it("wizard: the General step defaults to the browser zone and sends it on create and in identity PATCHes", () => {
    const f = emptyForm();
    expect(f.identity.timeZone).toBe(browserTimeZone());
    f.identity.name = "Demo";
    f.identity.timeZone = "America/New_York";
    expect(stepPayload("identity", f)).toMatchObject({ identity: { name: "Demo", timeZone: "America/New_York" } });
  });

  it("settings: the Information payload always carries the time zone", () => {
    const body = informationPayload({ name: "TABBL", fullName: "", description: "", ruleset: "BB2025", rulesetPackage: "", playOnFork: false, timeZone: "America/Chicago", country: "US", region: "", postcode: "", locality: "", street: "" });
    expect(body).toMatchObject({ timeZone: "America/Chicago", address: null, rulesetPackage: null });
  });
});

describe("Filter profanity (display only)", () => {
  it("default on: a listed word shows starred; off: shown as written; the store follows load and save", async () => {
    profanitySetting.on = true;
    expect(shown(`what a ${LISTED} move`)).toBe("what a *** move");
    expect(shown("raccoon pass")).toBe("raccoon pass");
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    let stored = true;
    const api = (async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, ...(init ?? {}) });
      if (init?.method === "POST") stored = (init.body as { profanityFilter: boolean }).profanityFilter;
      return { profanityFilter: stored };
    }) as never;
    await saveProfanitySetting(api, false);
    expect(calls.at(-1)).toMatchObject({ path: "/api/me/display-settings", method: "POST", body: { profanityFilter: false } });
    expect(profanitySetting.on).toBe(false);
    expect(shown(`what a ${LISTED} move`)).toBe(`what a ${LISTED} move`);
    // a failed read keeps (returns to) the default: on
    await loadProfanitySetting((async () => { throw new Error("down"); }) as never, true);
    expect(profanitySetting.on).toBe(true);
    await loadProfanitySetting(api, true);
    expect(profanitySetting.on).toBe(false);
    profanitySetting.on = true;
  });
});

describe("discord components (server-rendered)", () => {
  let vite: ViteDevServer;
  let render: (component: string, props: Record<string, unknown>, routes: Record<string, unknown>) => Promise<string>;

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [renderer, app, vueRouter] = await Promise.all([vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router")]);
    const vue = await import("vue");
    render = async (component, props, routes) => {
      const mod = await vite.ssrLoadModule(component);
      const a = vue.createSSRApp(mod.default, props);
      a.use(vueRouter.createRouter({ history: vueRouter.createMemoryHistory("/app/"), routes: [
        { path: "/", component: { render: () => null } },
        { path: "/leagues/:id/settings", name: "league-settings", component: { render: () => null } },
      ] }));
      a.provide(app.API_KEY, async (path: string) => {
        if (!(path in routes)) throw new Error(`no mock for ${path}`);
        return routes[path];
      });
      return renderer.renderToString(a);
    };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const tournamentView = {
    kind: "tournament", type: "tournament", name: "Spike Open", draft: false, configured: false, maskedUrl: "", inherited: false, parentMaskedUrl: "",
    events: { published: true, registrationClosing: true, checkInOpen: true, roundPosted: true, matchResult: true, roundStandings: true, finalStandings: true, news: false, death: false },
    live: { touchdown: false, casualty: false, injury: false, death: true, foul: false, sentOff: true, mvp: false, hireFire: false },
    endOfGameDigest: false, comments: true,
    catalogue: [
      { key: "published", label: "Published", group: "competition" }, { key: "checkInOpen", label: "Check-in open", group: "competition" },
      { key: "news", label: "News", group: "competition" }, { key: "death", label: "Player death", group: "inGame" },
    ],
  };

  it("tournament panel: tournament-mode ticks, live switch off while its event is off, test + samples disabled without a webhook", async () => {
    const html = await render("/src/components/CompetitionDiscordPanel.vue", { base: "/api/tournaments/t1" }, { "/api/tournaments/t1/discord": { discord: tournamentView } });
    expect(html).toContain("No webhook of its own, and the series has none");
    expect(html).toMatch(/data-event="checkInOpen"[^>]*checked|checked[^>]*data-event="checkInOpen"/);
    expect(html).not.toMatch(/data-event="news"[^>]*checked|checked[^>]*data-event="news"/);
    expect(html).toMatch(/<input[^>]*disabled[^>]*data-live="death"|<input[^>]*data-live="death"[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-samples/);
    expect(html).toContain("Send samples of every event");
    expect(html).toContain("Leave it blank to post to the series&#39;s webhook.");
  });

  it("draft panel says nothing posts until published", async () => {
    const html = await render("/src/components/CompetitionDiscordPanel.vue", { base: "/api/tournaments/t1" }, { "/api/tournaments/t1/discord": { discord: { ...tournamentView, draft: true, configured: true, maskedUrl: MASKED } } });
    expect(html).toContain("This is a draft: nothing posts to Discord until it is published.");
    expect(html).toContain(MASKED);
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-samples/);
  });

  const match = (comments: unknown) => ({
    id: "m1", state: "submitted", home: { coach: "Ann", teamName: "Orcs" }, away: { coach: "Bob", teamName: "Elves" }, postMatch: "none", createdBy: "Ann", confirmations: {},
    comments, commentsEnabled: true,
  });

  it("coach's comment: a seat gets the 120-character field and counter; organisers get Hide / Show; hidden comments are marked", async () => {
    const seat = await render("/src/components/TabletopCoachComments.vue", { match: match({ home: { text: "Good game", at: "x" } }), mySide: "home", organiser: false }, {});
    expect(seat).toContain('maxlength="120"');
    expect(seat).toContain("9/120");
    expect(seat).not.toContain(">Hide</button>");
    const org = await render("/src/components/TabletopCoachComments.vue", { match: match({ home: { text: `Good ${LISTED} game`, at: "x" }, away: { text: "Ugh", at: "x", hidden: { by: "Jay", at: "x" } } }), mySide: null, organiser: true }, {});
    // stored as written, shown starred (Filter profanity is on by default)
    expect(org).toContain("Good *** game");
    expect(org).not.toContain(LISTED);
    expect(org).toContain(">Hide</button>");
    expect(org).toContain(">Show</button>");
    expect(org).toContain('data-hidden="true"');
    expect(org).not.toContain("textarea");
  });

  it("Weekly Digest: schedule fields; the zone is the league's (read only here, linked to General)", async () => {
    const weekly = { enabled: true, trigger: "schedule", day: 0, time: "10:00", everyWeeks: 2, timeZone: "America/Vancouver", timeZoneSet: true, weekdays: [] };
    const html = await render("/src/components/LeagueWeeklyDigest.vue", { leagueId: "tabbl", view: { ...tournamentView, kind: "league", type: "league", weekly } }, {});
    for (const t of ["Weekly Digest", "On a set day", "After each round", ">Preview</button>", ">Post now</button>", "Times are in America/Vancouver."]) expect(html).toContain(t);
    expect(html).not.toContain("League time zone");
    expect(html).toContain('href="/app/leagues/tabbl/settings?tab=information"');
    expect(html).not.toContain("Set your league&#39;s time zone");
    expect(html).toMatch(/<option value="2"[^>]*selected/);
    const unset = await render("/src/components/LeagueWeeklyDigest.vue", { leagueId: "tabbl", view: { ...tournamentView, kind: "league", type: "league", weekly: { ...weekly, timeZone: "UTC", timeZoneSet: false } } }, {});
    expect(unset).toContain("Times are in UTC.");
    expect(unset).toContain("Set your league&#39;s time zone. Until then schedules use UTC.");
  });

  it("recorder and pages wire the pieces in", () => {
    expect(src("../spa/src/views/TabletopRecorderView.vue")).toContain("<TabletopCoachComments");
    expect(src("../spa/src/components/GameReporterView.vue")).toContain("Coach's comments");
    expect(src("../spa/src/components/TournamentManage.vue")).toContain('heading-id="tn-discord-h"');
    expect(src("../spa/src/views/TournamentDetailView.vue")).toContain('{ id: "tn-discord-h", label: "Discord" }');
    expect(src("../spa/src/components/TournamentMyEntry.vue")).toContain("<DiscordDmNotice />");
    expect(src("../spa/src/components/LeagueBuildTeamLink.vue")).toContain("<DiscordDmNotice");
  });
});
