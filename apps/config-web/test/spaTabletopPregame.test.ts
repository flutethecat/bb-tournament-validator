import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSSRApp } from "vue";
import type { ViteDevServer } from "vite";
import type { Fetcher } from "../spa/src/session";

// Recorder pre-game in the SPA (spec docs/artifact-orchestration/spec-recorder-pregame-2026-10-30.md): the cines and
// their queue, the inducement picker, the recorder's skip and socket refresh, and the match-log lines. Server-rendered
// through the SPA's own Vite config (no port, no jsdom), like spaTabletop.test.ts.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
let vite: ViteDevServer;
let mods: Record<string, any>;

beforeAll(async () => {
  const { createServer } = await import("vite");
  vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
  const [renderer, cine, cineC, pickerC, pregameC, rec, queue, feed] = await Promise.all([
    vite.ssrLoadModule("vue/server-renderer"),
    vite.ssrLoadModule("/src/tabletop/pregameCine.ts"),
    vite.ssrLoadModule("/src/components/TabletopPregameCine.vue"),
    vite.ssrLoadModule("/src/components/TabletopInducementPicker.vue"),
    vite.ssrLoadModule("/src/components/TabletopPregame.vue"),
    vite.ssrLoadModule("/src/tabletop/recorder.ts"),
    vite.ssrLoadModule("/src/tabletop/queue.ts"),
    vite.ssrLoadModule("/src/tabletop/feed.ts"),
  ]);
  mods = { renderer, cine, cineC, pickerC, pregameC, rec, queue, feed };
}, 60_000);
afterAll(async () => { await vite?.close(); });

const mount = async (comp: { default: unknown }, props: Record<string, unknown>): Promise<string> =>
  (await mods.renderer.renderToString(createSSRApp(comp.default as object, props))) as string;

const names = { home: { coach: "Alice", teamName: "Alice Orcs" }, away: { coach: "Bob", teamName: "Bob Elves" } };
const ev = (id: string, type: string, team: "home" | "away", payload: Record<string, unknown>) => ({ id, type, team, payload });
const fans = [ev("pg-fans-home", "fans", "home", { roll: 3, dedicatedFans: 2, total: 5, rolledBy: "site" }), ev("pg-fans-away", "fans", "away", { roll: 1, dedicatedFans: 2, total: 3, rolledBy: "coach", enteredBy: "Bob" })];
const weather = ev("pg-weather-0", "weather", "home", { pregame: true, roll: 11, dice: [5, 6], result: "Pouring Rain", rolledBy: "site" });
const caller = ev("pg-coincaller", "coinFlip", "away", { stage: "caller", caller: "away", rolledBy: "site" });
const flip = ev("pg-coinflip", "coinFlip", "home", { mode: "auto", call: "tails", caller: "away", result: "heads", winner: "home", rolledBy: "site" });
const choice = ev("pg-coinchoice", "coinFlip", "home", { stage: "choice", winner: "home", choice: "kick" });

describe("cines", () => {
  it("cinesFor: one cine per new milestone, built only from the server's events", () => {
    const all = [...fans, weather, caller, flip, choice];
    const items = mods.cine.cinesFor(new Set(all.map((e) => e.id)), all, names);
    expect(items.map((c: { kind: string }) => c.kind)).toEqual(["fans", "weather", "coin", "kickreceive"]);
    expect(items[0]).toMatchObject({ leader: "home", diff: 2, home: { team: "Alice Orcs", roll: 3, total: 5 }, away: { total: 3 } });
    expect(items[1]).toMatchObject({ dice: [5, 6], total: 11, name: "Pouring Rain", effect: expect.stringContaining("slippery") });
    expect(items[2]).toMatchObject({ callerCoach: "Bob", call: "tails", result: "heads", winnerCoach: "Alice", hand: false });
    expect(items[3]).toMatchObject({ winnerTeam: "Alice Orcs", choice: "kick", otherTeam: "Bob Elves" });
    // the caller draw alone plays nothing; a hand flip with its choice plays the coin then kick/receive
    expect(mods.cine.cinesFor(new Set(["pg-coincaller"]), [caller], names)).toEqual([]);
    const hand = ev("pg-coinflip", "coinFlip", "away", { mode: "hand", call: "heads", caller: "away", result: "heads", winner: "away", choice: "receive" });
    expect(mods.cine.cinesFor(new Set(["pg-coinflip"]), [caller, hand], names).map((c: { kind: string }) => c.kind)).toEqual(["coin", "kickreceive"]);
    expect(Math.max(...Object.values(mods.cine.CINE_MS as Record<string, number>))).toBeLessThanOrEqual(mods.cine.CINE_MAX_MS);
    expect(mods.cine.CINE_MAX_MS).toBe(2500);
  });

  it("the queue never replays on opening a match, then plays new milestones in order", () => {
    const q = mods.cine.createCineQueue();
    expect(q.see([...fans], names)).toBe(false); // first load: marks only
    expect(q.current).toBeUndefined();
    expect(q.see([...fans, weather], names)).toBe(true);
    expect(q.current.kind).toBe("weather");
    q.see([...fans, weather, caller, flip], names);
    expect(q.length).toBe(2);
    q.next();
    expect(q.current.kind).toBe("coin");
    q.see([...fans, weather, caller, flip], names); // the same answer again queues nothing
    expect(q.length).toBe(1);
  });

  it("each cine renders the client's layout in our own markup, with tap to skip", async () => {
    const all = [...fans, weather, caller, flip, choice];
    const [f, w, c, kr] = mods.cine.cinesFor(new Set(all.map((e) => e.id)), all, names);
    const fh = await mount(mods.cineC, { item: f });
    expect(fh).toContain('data-kind="fans"');
    expect(fh).toContain("The Fans");
    expect(fh).toContain("2 dedicated + D3 3 = <b>5</b>");
    expect(fh).toContain("Alice Orcs has <b>+2</b> fan factor");
    expect(fh).toContain("Tap to skip");
    const wh = await mount(mods.cineC, { item: w });
    expect(wh).toContain("Weather Roll");
    expect(wh).toContain('class="tt-cine-die from-north"');
    expect(wh).toContain("Pouring Rain");
    expect(wh).toContain("The ball is slippery");
    const ch = await mount(mods.cineC, { item: c });
    expect(ch).toContain("Bob calls <b>TAILS</b>");
    expect(ch).toContain('data-result="heads"');
    expect(ch).toContain("HEADS - Alice wins the toss");
    const kh = await mount(mods.cineC, { item: kr });
    expect(kh).toContain("Alice Orcs</span> kicks");
    expect(kh).toContain("Bob Elves receives");
  });

  it("CSS: cines are short, skippable and still under reduced motion; no third-party art", () => {
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    const block = css.slice(css.indexOf("/* ---- pre-game flow"), css.indexOf("PHONE (below 760 px)"));
    expect(block).toContain(".tt-cine { position: fixed; inset: 0; z-index: 80;");
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.tt-cine, \.tt-cine \*, \.tt-coin-spinner, \.tt-dots i \{ animation: none !important; \}/);
    const ms = [...block.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
    expect(Math.max(...ms)).toBeLessThanOrEqual(2500);
    expect(block).not.toMatch(/url\(/);
  });
});

describe("inducement picker", () => {
  const options = [{ id: "bribes", name: "Bribes", price: 50_000, max: 6 }, { id: "team_mascot", name: "Team Mascot", price: 25_000, max: 1 }];
  const base = { side: "home", teamName: "Alice Orcs", coach: "Alice", options, busy: false, canEdit: true, submitted: false, icons: { bribes: "icons/inducements/bribe.png" } };

  it("catalogue with icon, price and limit; cart with petty cash, treasury and what is left", async () => {
    const html = await mount(mods.pickerC, { ...base, budget: { role: "underdog", pettyCash: 200_000, treasury: 80_000, topUpLimit: 50_000, spent: 0, submitted: false } });
    expect(html).toContain("Buy inducements");
    expect(html).toContain('src="/icons/inducements/bribe.png"');
    expect(html).toContain("Bribes");
    expect(html).toContain("50k");
    expect(html).toContain("0<small>/6</small>");
    expect(html).toContain("Petty cash <b>200k</b>");
    expect(html).toContain("(up to 50k)");
    expect(html).toContain("Left <b>250k</b>");
    expect(html).toContain("Lower team value");
    expect(html).toContain("Nothing picked.");
    expect(html).toContain("Confirm Alice Orcs");
  });

  it("the underdog waits for the favourite; a viewer without rights sees no buttons; equal values buy nothing", async () => {
    const wait = await mount(mods.pickerC, { ...base, waitingFor: "Bob Elves", budget: { role: "underdog", pettyCash: 100_000, treasury: 0, topUpLimit: 0, spent: 0, submitted: false } });
    expect(wait).toContain("Waiting for Bob Elves (higher team value) to choose first");
    expect(wait).toMatch(/<button[^>]*disabled[^>]*>No inducements<\/button>/);
    const ro = await mount(mods.pickerC, { ...base, canEdit: false });
    expect(ro).not.toContain("Confirm Alice Orcs");
    const eq = await mount(mods.pickerC, { ...base, budget: { role: "equal", pettyCash: 0, treasury: 50_000, topUpLimit: 0, spent: 0, submitted: false } });
    expect(eq).toContain("Team values are equal");
  });

  it("the pre-game card orders the higher-value team first", async () => {
    const match = { id: "m", state: "recording", home: { coach: "Alice", teamName: "Alice Orcs", teamSaveId: "a" }, away: { coach: "Bob", teamName: "Bob Elves", teamSaveId: "b" }, postMatch: "full", createdBy: "Alice", confirmations: {} };
    const html = await mount(mods.pregameC, {
      match, teams: { home: undefined, away: undefined }, phase: "pregame:inducements", busy: false, error: "", mySide: "home",
      pregame: { step: "inducements", inducementOptions: { home: options, away: options }, budget: { home: { role: "underdog", pettyCash: 200_000, treasury: 0, topUpLimit: 0, spent: 0, submitted: false }, away: { role: "favourite", pettyCash: 0, treasury: 100_000, topUpLimit: 100_000, spent: 0, submitted: false } } },
    });
    expect(html.indexOf('data-side="away"')).toBeLessThan(html.indexOf('data-side="home"'));
    expect(html).toContain("Waiting for Bob Elves (higher team value)");
  });
});

describe("recorder controller", () => {
  const view = (phase: string) => ({ match: { id: "m", state: "recording", home: names.home, away: names.away }, events: [], effectiveEventIds: [], teams: {}, phase, pregame: { step: phase.slice(8) } });

  it("skipPregame posts pregame/skip; a socket push during the pre-game reloads the match", async () => {
    const calls: string[] = [];
    let phase = "pregame:fans";
    const api = (async (path: string, init: { method?: string } = {}) => {
      calls.push(`${init.method ?? "GET"} ${path}`);
      return init.method === "POST" ? { match: view(phase).match } : view(phase);
    }) as Fetcher;
    const r = mods.rec.createRecorder("m1", { api, onSignedOut: () => undefined, storage: mods.queue.memoryStorage() });
    await r.refresh();
    await r.skipPregame();
    expect(calls).toContain("POST /api/tabletop/matches/m1/pregame/skip");
    calls.length = 0;
    phase = "pregame:weather";
    r.onClockMessage({ feature: "tabletop-clock", payload: { half: 1, turn: 0, activeTeam: "home", phase: "pregame:weather", serverNow: new Date().toISOString() } });
    await new Promise((res) => setTimeout(res, 0));
    expect(calls).toEqual(["GET /api/tabletop/matches/m1"]);
    expect(r.state.phase).toBe("pregame:weather");
    r.stop();
  });
});

describe("match log lines", () => {
  const match = names;
  const teams = { home: { name: "Alice Orcs", players: [] }, away: { name: "Bob Elves", players: [] } };
  const lines = (evs: any[]) => mods.feed.feedRows(evs, evs.map((e) => e.id), teams, {}, match).map((r: any) => `${r.lead}${r.rest}`);

  it("the caller draw, coach-entered and site rolls, and the organiser skip are logged", () => {
    expect(lines([caller])[0]).toBe("The site draws Bob (Bob Elves) to call the toss.");
    expect(lines([fans[1]])[0]).toBe("Bob Elves brings 3 fans (rolled 1, rolled at the table, entered by Bob).");
    expect(lines([fans[0]])[0]).toBe("Alice Orcs brings 5 fans (rolled 3, site roll).");
    expect(lines([weather])[0]).toBe("Weather: Pouring Rain (5 + 6, site roll)");
    expect(lines([ev("p1", "prayer", "home", { roll: 4, name: "Iron Man", rolledBy: "coach", enteredBy: "Alice" })])[0]).toBe("Alice Orcs prays to Nuffle: Iron Man (4, rolled at the table, entered by Alice).");
    expect(lines([{ ...ev("pg-skip", "pregameSkip", "home", { from: "pregame:fans" }), by: "Org" }])[0]).toBe("Org skipped the pre-game.");
    const rows = mods.feed.feedRows([caller], ["pg-coincaller"], teams, {}, match);
    expect(rows[0]).toMatchObject({ side: "centre", undoable: false });
  });
});

describe("Testing Suite card", () => {
  it("asks for the full pre-game unless Skip pre-game is ticked", () => {
    const src = readFileSync(fileURLToPath(new URL("../spa/src/components/TabletopTestMatchCard.vue", import.meta.url)), "utf8");
    expect(src).toContain('pregame: skipPregame.value ? "skip" : "full"');
    expect(src).toContain("Skip pre-game (start at the kick-off)");
    expect(src).toContain("const skipPregame = ref(false);");
  });
});
