import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Plugin, ViteDevServer } from "vite";

// League Standings (league pages treatment, Sol fix round 2): the phase selector and the filter box the coach is operating
// keep keyboard focus (and so the caret) through every change: one division <-> several, a single phase <-> all phases,
// with and without a filter, divisions hiding as the filter narrows. The repo has no jsdom, so the component is compiled
// for the browser (not for server rendering) and MOUNTED by Vue's own DOM renderer over a small fake DOM below. Removing a
// focused node moves focus to <body>, as a browser does: a swapped control fails the test.
const SPA_ROOT = fileURLToPath(new URL("../spa/", import.meta.url));

// ---- a minimal DOM: just what Vue's runtime-dom, v-model and the test touch ----
class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  constructor(public nodeType: number, public ownerDocument: FakeDocument, public data = "") {}
  get nextSibling(): FakeNode | null { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null; }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get nodeValue(): string { return this.data; }
  set nodeValue(v: string) { this.data = v; }
  get textContent(): string { return this.nodeType === 1 ? this.childNodes.map((c) => c.textContent).join("") : this.data; }
  set textContent(v: string) {
    if (this.nodeType !== 1) { this.data = v; return; }
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v) this.appendChild(this.ownerDocument.createTextNode(v));
  }
  get isConnected(): boolean { let n: FakeNode | null = this; while (n) { if (n === this.ownerDocument.body) return true; n = n.parentNode; } return false; }
  contains(n: FakeNode | null): boolean { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(child); else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    return child;
  }
  appendChild(child: FakeNode): FakeNode { return this.insertBefore(child, null); }
  removeChild(child: FakeNode): FakeNode {
    const doc = this.ownerDocument;
    if (doc.activeElement && child.contains(doc.activeElement)) doc.activeElement = doc.body; // as a browser does
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
}
class FakeElement extends FakeNode {
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(e: unknown) => void>>();
  style: Record<string, unknown> = { setProperty() {}, removeProperty() {} };
  dataset: Record<string, string> = {};
  value = "";
  className = "";
  constructor(public tagName: string, doc: FakeDocument) { super(1, doc); }
  setAttribute(k: string, v: string): void { this.attributes.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attributes.get(k) ?? null; }
  removeAttribute(k: string): void { this.attributes.delete(k); }
  hasAttribute(k: string): boolean { return this.attributes.has(k); }
  addEventListener(t: string, f: (e: unknown) => void): void { this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]); }
  removeEventListener(t: string, f: (e: unknown) => void): void { this.listeners.set(t, (this.listeners.get(t) ?? []).filter((x) => x !== f)); }
  dispatch(type: string): void { const e = { type, target: this, _vts: Date.now() + 60_000 }; for (const f of this.listeners.get(type) ?? []) f(e); }
  focus(): void { this.ownerDocument.activeElement = this; }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  /** Depth-first: every descendant element passing the test. */
  findAll(test: (e: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode) => { for (const c of n.childNodes) { if (c instanceof FakeElement) { if (test(c)) out.push(c); walk(c); } } };
    walk(this);
    return out;
  }
}
class FakeDocument {
  body: FakeElement;
  activeElement: FakeElement | null = null;
  constructor() { this.body = new FakeElement("BODY", this); this.activeElement = this.body; }
  createElement(tag: string): FakeElement { return new FakeElement(tag.toUpperCase(), this); }
  createElementNS(_ns: string, tag: string): FakeElement { return new FakeElement(tag, this); }
  createTextNode(t: string): FakeNode { return new FakeNode(3, this, t); }
  createComment(t: string): FakeNode { return new FakeNode(8, this, t); }
  querySelector(sel: string): FakeElement | null { return sel === "body" ? this.body : null; }
  // page scripts the module graph pulls in look for their own page and stop (team-builder.js)
  getElementById(): null { return null; }
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** plugin-vue compiling for the browser even under ssrLoadModule (only the module loading is server-side). */
function clientVue(p: Plugin): Plugin {
  const wrap = (hook: unknown) => {
    if (!hook) return hook;
    const fn = typeof hook === "function" ? hook : (hook as { handler: (...a: unknown[]) => unknown }).handler;
    const handler = function (this: unknown, ...a: unknown[]) { const opt = (a.at(-1) && typeof a.at(-1) === "object" ? a.at(-1) : {}) as object; return fn.call(this, ...a.slice(0, -1), { ...opt, ssr: false }); };
    return typeof hook === "function" ? handler : { ...(hook as object), handler };
  };
  return { ...p, load: wrap(p.load) as Plugin["load"], transform: wrap(p.transform) as Plugin["transform"] };
}

const row = (team: string, coach: string, rank: number) => ({ group: "", rank, team, teamId: team, race: "Orc", coach, coachId: coach, points: 3, played: 1, wins: 1, draws: 0, losses: 0, tdFor: 1, tdAgainst: 0, casFor: 0, casAgainst: 0 });
const SEASON = {
  id: "season-6", leagueId: "harbour", number: 6, name: "Season 6", sourceSlug: "s6", ruleset: "BB2025", status: "active", importedAt: "2026-10-01T00:00:00.000Z",
  phases: [
    { id: "pre", category: "Season", name: "Pre", groups: [""], standingsSource: "computed", standings: [row("Pre Alpha", "Ann", 1), row("Pre Beta", "Bo", 2)] },
    { id: "regular", category: "Season", name: "Regular", groups: [""], standingsSource: "computed", standings: [row("Reg Gamma", "Cy", 1), row("Reg Delta", "Di", 2), row("Reg Epsilon", "Ed", 3)] },
  ],
  fixtures: [
    { id: "f1", phaseId: "pre", phase: "Pre", category: "Season", group: "", round: 1, table: 1, suspended: false, home: { team: "Pre Alpha", coach: "Ann", race: "Orc", score: 1, cas: 0 }, away: { team: "Pre Beta", coach: "Bo", race: "Orc", score: 0, cas: 0 } },
    { id: "f2", phaseId: "regular", phase: "Regular", category: "Season", group: "", round: 1, table: 1, suspended: false, home: { team: "Reg Gamma", coach: "Cy", race: "Orc", score: 1, cas: 0 }, away: { team: "Reg Delta", coach: "Di", race: "Orc", score: 0, cas: 0 } },
  ],
  participants: [], teams: [], honours: [], awards: [],
};

describe("Standings: the control in use keeps focus (mounted, fake DOM)", () => {
  let vite: ViteDevServer | undefined;
  const doc = new FakeDocument();
  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    g.document = doc; // before Vue's runtime-dom loads (it reads document once)
    g.history = g.history ?? { state: {}, replaceState() {}, pushState() {} }; // vue-router sees a document and saves scroll
    g.scrollTo = g.scrollTo ?? (() => {});
    g.SVGElement = g.SVGElement ?? class {}; // runtime-dom asks whether the mount root is SVG / MathML
    g.MathMLElement = g.MathMLElement ?? class {};
    g.Element = g.Element ?? FakeElement; // app.mount clears an Element container
    g.window = g.window ?? globalThis; // page scripts register on window (team-builder.js: window.TeamBuilderCore)
    const { createServer } = await import("vite");
    const vue = (await import("@vitejs/plugin-vue")).default;
    vite = await createServer({ root: SPA_ROOT, configFile: false, logLevel: "silent", appType: "custom", plugins: [clientVue(vue() as Plugin)], server: { middlewareMode: true, hmr: false, ws: false } });
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  it("phase selector and filter input survive single <-> several divisions, all phases and divisions hiding", async () => {
    const [{ createApp, nextTick }, vueRouter, Standings] = await Promise.all([import("vue"), vite!.ssrLoadModule("vue-router"), vite!.ssrLoadModule("/src/components/LeagueStandings.vue")]);
    const router = vueRouter.createRouter({ history: vueRouter.createMemoryHistory("/app/"), routes: [{ path: "/:p(.*)*", component: { render: () => null } }] });
    await router.push("/leagues/harbour?tab=standings");
    await router.isReady();
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const app = createApp(Standings.default, { season: SEASON, leagueId: "" });
    app.use(router);
    app.mount(host as never);
    const settle = async () => { for (let i = 0; i < 4; i++) { await nextTick(); await new Promise((r) => setTimeout(r, 0)); } };
    await settle();

    const sections = () => host.findAll((e) => e.tagName === "SECTION").length;
    const select = host.findAll((e) => e.tagName === "SELECT" && e.hasAttribute("data-standings-phase"));
    const input = host.findAll((e) => e.tagName === "INPUT" && e.hasAttribute("data-standings-filter"));
    expect(select).toHaveLength(1);
    expect(input).toHaveLength(1);
    const sel = select[0]!;
    const box = input[0]!;
    expect(sections()).toBe(1); // the current phase (Regular): one division

    const pickPhase = async (v: string) => { sel.focus(); sel.value = v; sel.dispatch("change"); await settle(); };
    const type = async (v: string) => { box.focus(); box.value = v; box.dispatch("input"); await settle(); };
    // compare identities as booleans: a failing toBe would try to print the cyclic fake DOM
    const where = (): string => (doc.activeElement === doc.body ? "body" : doc.activeElement?.tagName ?? "nothing");
    const focusedSelect = () => { expect(doc.activeElement === sel, `focus is on ${where()}, not the phase selector`).toBe(true); expect(sel.isConnected).toBe(true); };
    const focusedInput = () => { expect(doc.activeElement === box, `focus is on ${where()}, not the filter box`).toBe(true); expect(box.isConnected).toBe(true); };

    await pickPhase("all"); // one division -> several
    expect(sections()).toBe(2);
    focusedSelect();
    await pickPhase("pre"); // several -> one, another phase
    expect(sections()).toBe(1);
    focusedSelect();
    await pickPhase("all");
    focusedSelect();

    await type("gamma"); // several -> one shown: the Pre division hides
    expect(sections()).toBe(1);
    focusedInput();
    await type("zebra"); // -> none at all
    expect(sections()).toBe(0);
    expect(host.findAll((e) => e.hasAttribute("data-standings-none"))).toHaveLength(1);
    focusedInput();
    await type("o"); // -> several again (every team's race is Orc)
    expect(sections()).toBe(2);
    focusedInput();

    await type("alpha");
    await pickPhase("regular"); // with a filter that matches nothing in this phase
    expect(sections()).toBe(0);
    focusedSelect();
    await pickPhase("all");
    expect(sections()).toBe(1);
    focusedSelect();
    await type("");
    expect(sections()).toBe(2);
    focusedInput();
    app.unmount();
  });
});
