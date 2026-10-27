import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Shared stand-in DOM for the organiser pages (tournament-rules.js / admin.js are dependency-free browser
// scripts). Elements record innerHTML + listeners; fetch answers from a fixed route table.

export const publicDir = new URL("../public/", import.meta.url);
export const repoRoot = new URL("../../../", import.meta.url);

export function readPublic(name: string): string {
  return readFileSync(new URL(name, publicDir), "utf8");
}

export function readPackage(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`tournament-packages/${name}.json`, repoRoot), "utf8"));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export interface StubElement {
  id: string;
  innerHTML: string;
  textContent: string;
  className: string;
  hidden: boolean;
  href: string;
  open?: boolean;
  dataset: Record<string, string>;
  listeners: Record<string, ((event: unknown) => void)[]>;
  classList: { toggle(): void; add(): void; remove(): void };
  addEventListener(type: string, fn: (event: unknown) => void): void;
  querySelectorAll(selector: string): StubElement[];
  querySelector(selector: string): StubElement | null;
  appendChild(child: unknown): void;
  setAttribute(): void;
}

export function stubElement(id: string): StubElement {
  const listeners: StubElement["listeners"] = {};
  return {
    id,
    innerHTML: "",
    textContent: "",
    className: "",
    hidden: true,
    href: "",
    dataset: {},
    listeners,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    appendChild() {},
    setAttribute() {},
  };
}

export const CATALOG = {
  teams: [
    { name: "Halfling", defaultTier: 4 },
    { name: "High Elf", defaultTier: 1 },
    { name: "Orc", defaultTier: 1 },
  ],
  stars: [
    { name: "Crumbleberry", pairedWith: "Grak" },
    { name: "Grak", pairedWith: "Crumbleberry", pairPrimary: true },
    { name: "Morg 'n' Thorg" },
  ],
  skills: {
    elite: [{ name: "Block", category: "General" }, { name: "Guard", category: "Strength" }],
    general: [{ name: "Sure Hands", category: "General" }, { name: "Wrestle", category: "General" }],
  },
};

export interface Page {
  context: Record<string, Any>;
  elements: Record<string, StubElement>;
  adminLinks: StubElement[];
  fetched: string[];
}

/** Run a public script against the stand-in DOM. `routes` maps request paths to JSON bodies. */
export function runPage(script: string, ids: string[], routes: Record<string, unknown>, adminLinkCount = 0): Page {
  const elements: Record<string, StubElement> = Object.fromEntries(ids.map((id) => [`#${id}`, stubElement(id)]));
  const adminLinks = Array.from({ length: adminLinkCount }, (_, index) => stubElement(`admin-link-${index}`));
  const fetched: string[] = [];
  const document = {
    readyState: "complete",
    body: stubElement("body"),
    documentElement: stubElement("html"),
    activeElement: null,
    querySelector: (selector: string) => elements[selector] ?? null,
    querySelectorAll: (selector: string) => (selector === "[data-admin-only]" ? adminLinks : []),
    getElementById: (id: string) => elements[`#${id}`] ?? null,
    addEventListener() {},
    createElement: () => stubElement("created"),
  };
  const fetch = async (path: string) => {
    fetched.push(path);
    const known = Object.prototype.hasOwnProperty.call(routes, path);
    return {
      ok: known,
      status: known ? 200 : 404,
      json: async () => (known ? JSON.parse(JSON.stringify(routes[path])) : { error: "not found" }),
      text: async () => "",
    };
  };
  const context: Record<string, Any> = {
    console,
    document,
    fetch,
    location: { hostname: "127.0.0.1", pathname: "/", hash: "", search: "", assign() {} },
    localStorage: { getItem: () => null, setItem() {} },
    window: { prompt: () => null, confirm: () => false, open: () => null, setTimeout },
    setTimeout,
    clearTimeout,
    URLSearchParams,
  };
  runInNewContext(script, context);
  return { context, elements, adminLinks, fetched };
}

export function rulesRoutes(session: Record<string, unknown>): Record<string, unknown> {
  return {
    "/api/auth/session": session,
    "/api/packages": [],
    "/api/presets": [],
    "/api/skills": CATALOG.skills,
    "/api/stars": CATALOG.stars,
    "/api/teams": CATALOG.teams,
  };
}

export const RULES_IDS = ["toolbar", "package-shelf", "editor", "right-rail", "connection-state", "fork-admin-link"];

/** Boot tournament-rules.js with the catalogs loaded; resolves once initialize() settles. */
export async function bootRules(session: Record<string, unknown> = { authenticated: false }): Promise<Page & { core: Any }> {
  const page = runPage(readPublic("tournament-rules.js"), RULES_IDS, rulesRoutes(session), 4);
  const core = page.context.TournamentRulesCore;
  await core.ready;
  return { ...page, core };
}

export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
