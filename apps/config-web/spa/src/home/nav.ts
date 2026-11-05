// Sidebar model (owner 10-30): Home, then collapsible categories Leagues / Tournaments / Leaderboards / Help /
// Resources, and Testing for site admins only. Each top-level item has an original pixel icon in
// /icons/nav/ (README there). Which categories are open is remembered per category in localStorage when the browser
// allows it, never required.

export type NavCategoryId = "leagues" | "tournaments" | "clubs" | "leaderboards" | "help" | "resources" | "testing";

export interface NavLink { label: string; to: string }
export interface ExternalLink { label: string; href: string; icon: string }

/** Categories drawn with one of our existing icons from another set (no new art: law 16). */
const NAV_ICON_FROM: Readonly<Record<string, string>> = { clubs: "/icons/panel/friends.png" };
export const NAV_ICON = (name: string): string => NAV_ICON_FROM[name] ?? `/icons/nav/${name}.png`;

export const HOME_LINK: NavLink = { label: "Home", to: "/home" };

/** Leagues have no page of their own yet: the header opens the tournament list with a leagues hint. */
export const LEAGUES_TO = "/leagues";

/** Resources: external sites, each opened in a new tab. */
export const RESOURCES: ExternalLink[] = [
  { label: "Blood Bowl Base", href: "https://bloodbowlbase.ru", icon: "bloodbowlbase" },
  { label: "Blood Bowl Dave", href: "https://bloodbowldave.com", icon: "bloodbowldave" },
  { label: "TABBL", href: "https://tabbl.org", icon: "tabbl" },
  { label: "FUMBBL", href: "https://fumbbl.com", icon: "fumbbl" },
];

/** Testing (owner 10-30): the old Pages entries, for site admins only. Account lives in the top-bar menu. */
export const TESTING_TOOLS: NavLink[] = [
  { label: "Lobby", to: "/lobby" },
  { label: "Tabletop", to: "/tabletop" },
  { label: "Team Builder", to: "/team-builder" },
  { label: "Roster Builder", to: "/tournament-team-builder" },
  // Admin console v2 (owner 11-04): users, teams, games, reports, moderation, organisers, privacy jobs and operations.
  { label: "Admin console", to: "/admin/overview" },
];

export const NAV_OPEN_STORAGE_KEY = "sf.navOpen";

/** Every category starts open except Resources and Testing. */
export const NAV_OPEN_DEFAULTS: Readonly<Record<NavCategoryId, boolean>> = {
  leagues: true, tournaments: true, clubs: true, leaderboards: true, help: true, resources: false, testing: false,
};

// Resolved inside each function's try: in a sandboxed frame or with site data blocked, merely reading
// `localStorage` throws, and that must never break rendering.
const browserStorage = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** The remembered open state merged over the defaults; anything unreadable falls back to the defaults. */
export function readNavOpen(storage?: Pick<Storage, "getItem">): Record<NavCategoryId, boolean> {
  const out = { ...NAV_OPEN_DEFAULTS };
  try {
    const raw = (storage ?? browserStorage())?.getItem(NAV_OPEN_STORAGE_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : undefined;
    if (saved && typeof saved === "object") {
      for (const id of Object.keys(out) as NavCategoryId[]) {
        const v = (saved as Record<string, unknown>)[id];
        if (typeof v === "boolean") out[id] = v;
      }
    }
  } catch { /* no storage or bad JSON: defaults */ }
  return out;
}

export function rememberNavOpen(open: Record<NavCategoryId, boolean>, storage?: Pick<Storage, "setItem">): void {
  try { (storage ?? browserStorage())?.setItem(NAV_OPEN_STORAGE_KEY, JSON.stringify(open)); } catch { /* no storage */ }
}

/** The click a rail icon takes over (expand the rail, open the category): only an unmodified primary click on the
 * collapsed desktop rail. Ctrl/Meta/Shift/Alt or middle clicks keep the browser's own behaviour (a new tab). */
export function railIntercepts(
  e: Pick<MouseEvent, "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "defaultPrevented">,
  ui: { collapsed: boolean; narrow: boolean },
): boolean {
  if (!ui.collapsed || ui.narrow || e.defaultPrevented) return false;
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}
