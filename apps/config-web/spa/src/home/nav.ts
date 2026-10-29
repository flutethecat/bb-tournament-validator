// Sidebar model (owner 10-30): Home, then collapsible categories Leagues / Tournaments / Leaderboards / Help /
// Useful resources, and Testing Tools for site admins only. Each top-level item has an original pixel icon in
// /icons/nav/ (README there). Which categories are open is remembered per category in localStorage when the browser
// allows it, never required.

export type NavCategoryId = "leagues" | "tournaments" | "leaderboards" | "help" | "resources" | "testing";

export interface NavLink { label: string; to: string }
export interface ExternalLink { label: string; href: string; icon: string }

export const NAV_ICON = (name: string): string => `/icons/nav/${name}.png`;

export const HOME_LINK: NavLink = { label: "Home", to: "/home" };

/** Leagues have no page of their own yet: the header opens the tournament list with a leagues hint. */
export const LEAGUES_TO = "/tournaments?hint=leagues";

export const HELP_ROWS: NavLink[] = [{ label: "What's new", to: "/whats-new" }];
export const LEADERBOARD_ROWS: NavLink[] = [{ label: "Tabletop standings", to: "/standings" }];

/** Useful resources: external sites, each opened in a new tab. */
export const RESOURCES: ExternalLink[] = [
  { label: "Blood Bowl Base", href: "https://bloodbowlbase.ru", icon: "bloodbowlbase" },
  { label: "Blood Bowl Dave", href: "https://bloodbowldave.com", icon: "bloodbowldave" },
  { label: "TABBL", href: "https://tabbl.org", icon: "tabbl" },
  { label: "FUMBBL", href: "https://fumbbl.com", icon: "fumbbl" },
];

/** Testing Tools (owner 10-30): the old Pages entries, for site admins only. Account lives in the top-bar menu. */
export const TESTING_TOOLS: NavLink[] = [
  { label: "Lobby", to: "/lobby" },
  { label: "Tabletop", to: "/tabletop" },
  { label: "Team Builder", to: "/team-builder" },
  { label: "Tournament Builder", to: "/tournament-team-builder" },
];

export const NAV_OPEN_STORAGE_KEY = "sf.navOpen";

/** Every category starts open except Useful resources and Testing Tools. */
export const NAV_OPEN_DEFAULTS: Readonly<Record<NavCategoryId, boolean>> = {
  leagues: true, tournaments: true, leaderboards: true, help: true, resources: false, testing: false,
};

/** The remembered open state merged over the defaults; anything unreadable falls back to the defaults. */
export function readNavOpen(storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): Record<NavCategoryId, boolean> {
  const out = { ...NAV_OPEN_DEFAULTS };
  try {
    const raw = storage?.getItem(NAV_OPEN_STORAGE_KEY);
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

export function rememberNavOpen(open: Record<NavCategoryId, boolean>, storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): void {
  try { storage?.setItem(NAV_OPEN_STORAGE_KEY, JSON.stringify(open)); } catch { /* no storage */ }
}
