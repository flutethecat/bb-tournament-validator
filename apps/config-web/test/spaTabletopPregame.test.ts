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
  const [renderer, cine, cineC, pickerC, pregameC, rec, queue, feed, cart, sheetFocus] = await Promise.all([
    vite.ssrLoadModule("vue/server-renderer"),
    vite.ssrLoadModule("/src/tabletop/pregameCine.ts"),
    vite.ssrLoadModule("/src/components/TabletopPregameCine.vue"),
    vite.ssrLoadModule("/src/components/TabletopInducementPicker.vue"),
    vite.ssrLoadModule("/src/components/TabletopPregame.vue"),
    vite.ssrLoadModule("/src/tabletop/recorder.ts"),
    vite.ssrLoadModule("/src/tabletop/queue.ts"),
    vite.ssrLoadModule("/src/tabletop/feed.ts"),
    vite.ssrLoadModule("/src/tabletop/inducementCart.ts"),
    vite.ssrLoadModule("/src/tabletop/sheetFocus.ts"),
  ]);
  mods = { renderer, cine, cineC, pickerC, pregameC, rec, queue, feed, cart, sheetFocus };
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

  it("lists pre-filled from the fixture summary show in the cart, unconfirmed: Confirm (not Resubmit), and the underdog waits", async () => {
    const match = { id: "m", state: "recording", home: { coach: "Alice", teamName: "Alice Orcs", teamSaveId: "a" }, away: { coach: "Bob", teamName: "Bob Elves", teamSaveId: "b" }, postMatch: "full", createdBy: "Alice", confirmations: {} };
    const html = await mount(mods.pregameC, {
      match, teams: { home: undefined, away: undefined }, phase: "pregame:inducements", busy: false, error: "", mySide: "home",
      pregame: {
        step: "inducements", inducementOptions: { home: options, away: options },
        inducements: { home: { picks: [{ id: options[0]!.id, name: options[0]!.name, qty: 1 }], lobby: true }, away: { picks: [], lobby: true } },
        budget: { home: { role: "underdog", pettyCash: 200_000, treasury: 0, topUpLimit: 0, spent: 0, submitted: false, lobby: true }, away: { role: "favourite", pettyCash: 0, treasury: 100_000, topUpLimit: 100_000, spent: 0, submitted: false, lobby: true } },
      },
    });
    expect(html).toContain("Pre-filled from the fixture summary");
    expect(html).not.toContain("Chosen");
    expect(html).not.toContain("Resubmit");
    expect(html).toContain("Waiting for Bob Elves (higher team value)");
    expect(html).toContain(`1 x ${options[0]!.name}`);
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

  it("keeps the server's role; swapSeats posts seats/swap (owner ruling 10-30)", async () => {
    const calls: string[] = [];
    let role = "spectator";
    const api = (async (path: string, init: { method?: string } = {}) => {
      calls.push(`${init.method ?? "GET"} ${path}`);
      return init.method === "POST" ? { match: view("pregame:fans").match } : { ...view("pregame:fans"), role };
    }) as Fetcher;
    const r = mods.rec.createRecorder("m1", { api, onSignedOut: () => undefined, storage: mods.queue.memoryStorage() });
    expect(r.state.role).toBeNull();
    await r.refresh();
    expect(r.state.role).toBe("spectator");
    role = "organiser";
    await r.swapSeats();
    expect(calls).toContain("POST /api/tabletop/matches/m1/seats/swap");
    expect(r.state.role).toBe("organiser");
    r.stop();
  });
});

describe("seats: the organiser's swap button and the seat line", () => {
  const fansProps = (pregame: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ match: { id: "m", state: "recording", home: { ...names.home, teamSaveId: "a" }, away: { ...names.away, teamSaveId: "b" }, postMatch: "full", createdBy: "Alice", confirmations: {} }, teams: { home: undefined, away: undefined }, phase: "pregame:fans", pregame: { step: "fans", ...pregame }, busy: false, error: "", ...extra });
  it("an organiser may swap home and away until the first roll; coaches and spectators never see the button", async () => {
    const org = await mount(mods.pregameC, fansProps({ seatsSwappable: true }, { mySide: null, organiser: true }));
    expect(org).toContain(">Swap home and away<");
    expect(org).toContain("Home: Alice Orcs (Alice) · Away: Bob Elves (Bob)");
    expect(await mount(mods.pregameC, fansProps({ seatsSwappable: false }, { mySide: null, organiser: true }))).not.toContain(">Swap home and away<");
    expect(await mount(mods.pregameC, fansProps({ seatsSwappable: true }, { mySide: "home" }))).not.toContain(">Swap home and away<");
    const watching = await mount(mods.pregameC, fansProps({ seatsSwappable: true }, { mySide: null, readOnly: true }));
    expect(watching).not.toContain(">Swap home and away<");
    expect(watching).not.toContain(">Roll for me<");
    expect(watching).toContain("Waiting for the coaches.");
  });
});

describe("match log lines", () => {
  const match = names;
  const teams = { home: { name: "Alice Orcs", players: [] }, away: { name: "Bob Elves", players: [] } };
  const lines = (evs: any[]) => mods.feed.feedRows(evs, evs.map((e) => e.id), teams, {}, match).map((r: any) => `${r.lead}${r.rest}`);

  it("the seat draw and swap, the away caller, coach-entered and site rolls, and the organiser skip are logged", () => {
    // an old match's recorded caller draw now reads like today's derived caller
    expect(lines([caller])[0]).toBe("Away team Bob Elves (Bob) calls the toss.");
    const seats = ev("pg-seats", "seats", "home", { stage: "draw", swapped: true, rolledBy: "site", home: { coach: "Alice", teamName: "Alice Orcs" }, away: { coach: "Bob", teamName: "Bob Elves" } });
    expect(lines([seats])[0]).toBe("The site draws home and away: Alice Orcs (Alice) at home, Bob Elves (Bob) away.");
    const swap = { ...ev("pg-seatswap-1", "seats", "home", { stage: "swap", home: { coach: "Bob", teamName: "Bob Elves" }, away: { coach: "Alice", teamName: "Alice Orcs" } }), by: "Org" };
    expect(lines([swap])[0]).toBe("Org swaps home and away: Bob Elves (Bob) at home, Alice Orcs (Alice) away.");
    expect(mods.feed.feedRows([seats], ["pg-seats"], teams, {}, match)[0]).toMatchObject({ side: "centre", undoable: false });
    const call = ev("pg-coincall", "coinFlip", "away", { stage: "call", mode: "hand", caller: "away", call: "heads" });
    expect(lines([call])[0]).toBe("Away team Bob Elves (Bob) calls the toss: heads, for a real coin.");
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

// ---- Sol 6.1 review, three P2 regressions ----------------------------------------------------------------------
const pgMatch = { id: "m", state: "recording", home: { coach: "Alice", teamName: "Alice Orcs", teamSaveId: "a" }, away: { coach: "Bob", teamName: "Bob Elves", teamSaveId: "b" }, postMatch: "full", createdBy: "Alice", confirmations: {} };
const pgProps = (pregame: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ match: pgMatch, teams: { home: undefined, away: undefined }, phase: "pregame:coin", pregame, busy: false, error: "", ...extra });

describe("P2 #1: a real coin goes call -> result -> choice, each by its own coach", () => {
  it("only the caller sees the call; after a real-coin call either coach enters what the coin showed", async () => {
    // an old match with a drawn home caller still works; today the caller is always the away coach
    const notCaller = await mount(mods.pregameC, pgProps({ step: "coin", coin: { caller: "home" } }, { mySide: "away" }));
    expect(notCaller).toContain("Home team Alice Orcs (Alice) calls the toss");
    expect(notCaller).toContain("Waiting for Alice to call…");
    expect(notCaller).not.toContain("Flipping a real coin?"); // no hand entry that could call for Alice
    expect(notCaller).not.toContain("The coin showed");
    const caller = await mount(mods.pregameC, pgProps({ step: "coin", coin: { caller: "home" } }, { mySide: "home" }));
    expect(caller).toContain("Flipping a real coin? Call it here, then enter the result");
    expect(caller).not.toContain(">Kick<"); // the choice is never part of the call
    const result = await mount(mods.pregameC, pgProps({ step: "coin", coin: { caller: "home", call: "heads", mode: "hand" } }, { mySide: "away" }));
    expect(result).toContain("Alice called <b>HEADS</b> for a real coin");
    expect(result).toContain("What did the coin show?");
    expect(result).not.toContain(">Kick<");
  });
});

describe("P2 #2: the inducement cart follows the other phone without losing a draft", () => {
  it("a remote submission replaces a clean cart, polls keep a draft, a newer remote pick is flagged and reloadable", () => {
    const c = mods.cart.createCartSync([]);
    c.server([{ id: "bribes", qty: 1 }]); // the other phone bought a bribe
    expect(c.state.picks).toEqual({ bribes: 1 });
    expect(c.dirty()).toBe(false);
    c.state.picks.team_mascot = 1; // local draft
    c.server([{ id: "bribes", qty: 1 }]); // an unrelated poll
    expect(c.state.picks).toEqual({ bribes: 1, team_mascot: 1 });
    expect(c.state.remote).toBeNull();
    c.server([{ id: "bribes", qty: 2 }]); // a newer remote submission while drafting
    expect(c.state.picks).toEqual({ bribes: 1, team_mascot: 1 }); // the draft is kept...
    expect(c.state.remote).toEqual({ bribes: 2 }); // ...and the change is flagged
    c.reload();
    expect(c.state.picks).toEqual({ bribes: 2 });
    expect(c.state.remote).toBeNull();
    c.state.picks.team_mascot = 1;
    c.server([{ id: "team_mascot", qty: 1 }, { id: "bribes", qty: 2 }]); // our own submission comes back
    expect(c.dirty()).toBe(false);
    expect(c.state.remote).toBeNull();
    expect(mods.cart.picksKey([{ id: "b", qty: 1 }, { id: "a", qty: 0 }])).toBe("b:1");
  });

  it("the picker starts from the server's submission (no Chosen with an empty cart)", async () => {
    const html = await mount(mods.pickerC, {
      side: "away", teamName: "Bob Elves", coach: "Bob", options: [{ id: "bribes", name: "Bribes", price: 50_000, max: 6 }], busy: false, canEdit: true, submitted: true,
      initial: [{ id: "bribes", qty: 1 }], budget: { role: "favourite", pettyCash: 0, treasury: 100_000, topUpLimit: 100_000, spent: 50_000, submitted: true },
    });
    expect(html).toContain("1<small>/6</small>");
    expect(html).toContain("Spent <b>50k</b>");
    expect(html).toContain("Resubmit Bob Elves");
  });
});

describe("P2 #3: a cine is the top dialog; skipping it never presses a button underneath", () => {
  it("the Kick or receive? dialog waits while a cine plays", async () => {
    const kr = { step: "kickreceive", coin: { caller: "away", call: "tails", result: "heads", winner: "home" } };
    expect(await mount(mods.pregameC, pgProps(kr, { mySide: "home" }))).toContain("Kick or receive?");
    const during = await mount(mods.pregameC, pgProps(kr, { mySide: "home", cinePlaying: true }));
    expect(during).not.toContain("Kick or receive?");
    expect(during).not.toContain(">Receive<");
  });

  it("skip keys are swallowed: no default, no propagation; only keydown closes", () => {
    const key = (k: string, type = "keydown") => {
      const e = { key: k, type, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      return { closes: mods.cine.swallowSkipKey(e), e };
    };
    for (const k of ["Enter", " ", "Escape"]) {
      const down = key(k);
      expect(down.closes).toBe(true);
      expect(down.e.prevented && down.e.stopped).toBe(true);
      const up = key(k, "keyup");
      expect(up.closes).toBe(false);
      expect(up.e.prevented && up.e.stopped).toBe(true);
    }
    const tab = key("Tab");
    expect(tab.closes || tab.e.prevented).toBe(false);
    const src = readFileSync(fileURLToPath(new URL("../spa/src/components/TabletopPregameCine.vue", import.meta.url)), "utf8");
    expect(src).toContain('window.addEventListener("keydown", onKey, true);');
    expect(src).toContain('window.addEventListener("keyup", onKey, true);');
    expect(src).toMatch(/class="tt-cine"[^>]*role="dialog" aria-modal="true"/);
  });

  it("the focus manager keeps the cine on top even when a dialog opens under it later", () => {
    class El {
      children: El[] = []; parentElement: El | null = null; attrs = new Map<string, string>(); dataset: Record<string, string> = {}; isConnected = true;
      constructor(readonly tag: string, readonly cls: string[], readonly ownerDocument: Doc) {}
      add(c: El): El { c.parentElement = this; this.children.push(c); return c; }
      walk(fn: (e: El) => void): void { fn(this); this.children.forEach((c) => c.walk(fn)); }
      get classList() { return { contains: (c: string) => this.cls.includes(c) }; }
      setAttribute(k: string, v: string) { this.attrs.set(k, v); }
      removeAttribute(k: string) { this.attrs.delete(k); }
      hasAttribute(k: string) { return this.attrs.has(k); }
      contains(o: El | null) { for (let n = o; n; n = n.parentElement) if (n === this) return true; return false; }
      closest(sel: string) { const cs = sel.split(",").map((x) => x.trim().slice(1)); for (let n: El | null = this; n; n = n.parentElement) if (cs.some((c) => n!.cls.includes(c))) return n; return null; }
      querySelectorAll(sel: string): El[] {
        const out: El[] = [];
        const classes = sel.trim().startsWith(".") ? sel.split(",").map((x) => x.trim().slice(1)) : null;
        this.children.forEach((c) => c.walk((e) => { if (classes ? classes.some((k) => e.cls.includes(k)) : e.tag === "button") out.push(e); }));
        return out;
      }
      focus() { this.ownerDocument.activeElement = this; }
    }
    class Doc { activeElement: El | null = null; body = new El("body", [], this); defaultView = undefined; addEventListener() {} removeEventListener() {} }
    const doc = new Doc();
    const root = new El("div", ["tt-rec"], doc);
    const feed = root.add(new El("main", ["tt-feed"], doc));
    const cineEl = root.add(new El("div", ["tt-cine"], doc));
    const sf = mods.sheetFocus.createSheetFocus(root as any);
    expect(doc.activeElement).toBe(cineEl); // no buttons in a cine: the cine itself holds focus
    // a remote flip makes this viewer the winner: a dialog with Receive appears in the page, under the cine
    const dialog = feed.add(new El("div", ["tt-modal"], doc));
    const receive = dialog.add(new El("button", ["tt-kr-btn"], doc));
    sf.sync();
    expect(doc.activeElement).toBe(cineEl);
    expect(doc.activeElement).not.toBe(receive);
    expect(cineEl.hasAttribute("inert")).toBe(false);
    expect(feed.hasAttribute("inert")).toBe(true);
    sf.detach();
  });
});
