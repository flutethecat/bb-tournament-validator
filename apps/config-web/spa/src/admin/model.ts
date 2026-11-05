// Admin console v2 (/app/admin, spec-admin-console-v2-2026-11-04): the sections, the old console's hash links, the parity
// checklist (every action of the retired public/admin.js and where it lives now) and the pure helpers the section views share
// (ported from admin.js so their rules stay the same). No DOM.

export const ADMIN_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "teams", label: "Teams" },
  { id: "games", label: "Games" },
  { id: "reports", label: "Reports" },
  { id: "moderation", label: "Moderation" },
  { id: "organisers", label: "Organisers" },
  { id: "privacy-jobs", label: "Privacy jobs" },
  { id: "operations", label: "Operations" },
] as const;
export type AdminSectionId = (typeof ADMIN_SECTIONS)[number]["id"];
/** The router's param pattern for /admin/:section. */
export const ADMIN_SECTION_PATTERN = ADMIN_SECTIONS.map((s) => s.id).join("|");

export const isAdminSection = (v: unknown): v is AdminSectionId => typeof v === "string" && ADMIN_SECTIONS.some((s) => s.id === v);

/** The old console's deep links (admin.html#users / #teams / #games / #reports) as v2 sections; anything else is the Overview. */
export function adminSectionFromHash(hash: string | undefined): AdminSectionId {
  const h = String(hash ?? "").replace(/^#/, "").toLowerCase();
  if (h === "users" || h === "teams" || h === "games" || h === "reports") return h;
  return isAdminSection(h) ? h : "overview";
}

/**
 * Parity checklist (owner 11-04: "every action in the old admin.js must exist in v2 before the old page is retired").
 * `old` is the admin.js action (its data-action or function), `section` the v2 section and `control` the visible label of
 * the control that does it there. test/spaAdminConsole.test.ts renders each section and checks every control is present
 * (`shell` rows live in the site shell: the sign-in prompt and the account menu).
 */
export const PARITY: ReadonlyArray<{ old: string; section: AdminSectionId; control: string; api: string; shell?: true }> = [
  { old: "login / discord-login", section: "overview", control: "Login with Discord", api: "shell sign-in (Discord session)", shell: true },
  { old: "logout", section: "overview", control: "Sign out", api: "shell account menu, POST /api/auth/logout", shell: true },
  { old: "section tabs (users/teams/games/reports)", section: "overview", control: "Users", api: "/app/admin/:section" },
  { old: "refresh (users)", section: "users", control: "Refresh", api: "GET /api/fork/users, /api/admin/identities" },
  { old: "user-filter", section: "users", control: "Filter accounts", api: "client-side filter" },
  { old: "level (player/organizer/admin)", section: "users", control: "Permission level", api: "POST /api/admin/identities {level}" },
  { old: "toggle-banned", section: "users", control: "Allowed", api: "POST /api/admin/identities {banned}" },
  { old: "toggle-silenced", section: "users", control: "Normal", api: "POST /api/admin/identities {silenced}" },
  { old: "edit-identities / cancel-identities", section: "users", control: "Identities", api: "inline identity editor" },
  { old: "save-identities", section: "users", control: "Save admin identities", api: "POST /api/admin/identities {identities}" },
  { old: "save-naf-identity", section: "users", control: "Save NAF identity", api: "POST /api/admin/identities/naf" },
  { old: "merge-identities", section: "users", control: "Merge IDs", api: "POST /api/admin/identities/merge" },
  { old: "reset-password", section: "users", control: "Reset PW", api: "POST /api/fork/user/reset-password" },
  { old: "clear-games", section: "users", control: "Clear", api: "POST /api/fork/user/clear-games" },
  { old: "open-game (in-game badge modal)", section: "users", control: "In game", api: "GET /api/fork/user/:name/games" },
  { old: "user summary rail", section: "users", control: "User summary", api: "derived" },
  { old: "game-action close", section: "games", control: "Close", api: "POST /api/fork/game/:id/close" },
  { old: "game-action delete", section: "games", control: "Delete", api: "POST /api/fork/game/:id/delete" },
  { old: "game-action concede (home/away)", section: "games", control: "Concede home", api: "POST /api/fork/game/:id/concede {teamId}" },
  { old: "refresh (games)", section: "games", control: "Refresh", api: "GET /api/fork/games" },
  { old: "home-away (alternating/random)", section: "games", control: "Alternating", api: "POST /api/fork/matchmaking-settings {homeAwayMode}" },
  { old: "overtime (off/on)", section: "games", control: "Overtime on new scheduled games", api: "POST /api/fork/matchmaking-settings {overtime}" },
  { old: "broadcast", section: "games", control: "Broadcast", api: "POST /api/fork/message" },
  { old: "schedule", section: "games", control: "Schedule", api: "POST /api/fork/schedule" },
  { old: "tournament-launch", section: "games", control: "Launch", api: "POST /api/fork/tournament-match (team list from /api/fork/library)" },
  { old: "team-search-mode (name/id/coach)", section: "teams", control: "Team name", api: "client mode" },
  { old: "team-search", section: "teams", control: "Search", api: "GET /api/admin/teams/search" },
  { old: "select-team / refresh-team", section: "teams", control: "Refresh detail", api: "GET /api/teams/:id/detail, /api/fork/rosters, /api/skills" },
  { old: "rename-team", section: "teams", control: "Check and rename", api: "POST /api/team/checkName, /api/team/rename" },
  { old: "team-resurrection", section: "teams", control: "Resurrection", api: "POST /api/team/setResurrection" },
  { old: "team-mutation rerolls/coaches/cheerleaders/apothecary", section: "teams", control: "Team resources", api: "POST /api/team/<op>" },
  { old: "save-dedicated-fans", section: "teams", control: "Save dedicated fans", api: "POST /api/team/changeDedicatedFans" },
  { old: "save-renumber", section: "teams", control: "Save numbers", api: "POST /api/team/renumber" },
  { old: "player-mutation fire/retire/temp retire/refund/rehire", section: "teams", control: "Temp retire", api: "POST /api/team/<op> {playerId}" },
  { old: "toggle-player-editor", section: "teams", control: "Edit", api: "inline player editor" },
  { old: "add-player-skill / remove-player-skill", section: "teams", control: "Add skill", api: "POST /api/team/player/addSkill|removeSkill" },
  { old: "add-player-injury / remove-player-injury", section: "teams", control: "Injury text", api: "POST /api/team/player/addInjury|removeInjury" },
  { old: "save-player-stat", section: "teams", control: "Modifier", api: "POST /api/team/player/setStatModifier" },
  { old: "add-player (hire)", section: "teams", control: "Add player", api: "POST /api/team/addPlayer" },
  { old: "ready-team / unready", section: "teams", control: "Unready", api: "POST /api/team/ready|unready" },
  { old: "select-report / refresh-report", section: "reports", control: "Report queue", api: "GET /api/bug-reports/:id (+ /screenshot)" },
  { old: "refresh-reports", section: "reports", control: "Refresh", api: "GET /api/bug-reports" },
  { old: "save-report-triage (status, root cause, reason)", section: "reports", control: "Save triage", api: "PATCH /api/bug-reports/:id" },
  { old: "reply to reporter + fixed in (Visible to the player)", section: "reports", control: "Visible to the player", api: "PATCH /api/bug-reports/:id {reply, fixedIn}" },
];

// ---- users (admin.js mergedUsers / identityRecord) ----

export type Level = "player" | "organizer" | "admin";
export interface IdentityValues { discordUserId?: string; discordUsername?: string; tournamentCoachId?: string; nafName?: string; nafId?: string }
export interface IdentityOverlay { ffbCoachId?: string; level?: string; banned?: boolean; silenced?: boolean; identities?: IdentityValues }
export interface ForkGameRow { gameId?: string | number; id?: string | number; status?: string; half?: number; turn?: number; started?: string;
  homeTeamId?: string | number; homeTeamName?: string; homeTeam?: string; homeCoach?: string;
  awayTeamId?: string | number; awayTeamName?: string; awayTeam?: string; awayCoach?: string }
export interface ForkUser { fumbblName: string; linked?: { discordUserId?: string; nafName?: string; nafId?: string | number; id?: string | number } | null; games: ForkGameRow[] }

export const nameKey = (v: unknown): string => String(v ?? "").trim().toLowerCase();
export const safeArray = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);
export const gameIdOf = (g: ForkGameRow | undefined): string => String(g?.gameId ?? g?.id ?? "");

export function identityRecord(user: ForkUser, identities: Record<string, IdentityOverlay>): { ffbCoachId: string; level: Level; banned: boolean; silenced: boolean; identities: IdentityValues } {
  const overlay = identities[nameKey(user.fumbblName)];
  const linked = user.linked
    ? { discordUserId: String(user.linked.discordUserId ?? ""), nafName: String(user.linked.nafName ?? ""), nafId: String(user.linked.nafId ?? ""), tournamentCoachId: String(user.linked.id ?? "") }
    : {};
  const level = overlay?.level === "organizer" || overlay?.level === "admin" ? overlay.level : "player";
  return { ffbCoachId: String(overlay?.ffbCoachId ?? user.fumbblName ?? ""), level, banned: overlay?.banned === true, silenced: overlay?.silenced === true, identities: { ...linked, ...(overlay?.identities ?? {}) } };
}

/** Fork accounts plus identity-library rows with no fork account; in-game accounts first, then by name. */
export function mergedUsers(users: unknown, identities: Record<string, IdentityOverlay>): ForkUser[] {
  const byName = new Map<string, ForkUser>();
  for (const u of safeArray<Partial<ForkUser>>(users)) {
    const name = String(u?.fumbblName ?? "").trim();
    if (name) byName.set(nameKey(name), { ...u, fumbblName: name, linked: u.linked ?? null, games: safeArray(u.games) });
  }
  for (const [key, rec] of Object.entries(identities)) {
    if (!byName.has(key) && rec?.ffbCoachId) byName.set(key, { fumbblName: String(rec.ffbCoachId), linked: null, games: [] });
  }
  return [...byName.values()].sort((a, b) => (Number(b.games.length > 0) - Number(a.games.length > 0)) || a.fumbblName.localeCompare(b.fumbblName, undefined, { sensitivity: "base" }));
}

export function filterUsers(all: ForkUser[], identities: Record<string, IdentityOverlay>, filter: string): ForkUser[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return all;
  return all.filter((u) => u.fumbblName.toLowerCase().includes(needle)
    || Object.values(identities[nameKey(u.fumbblName)]?.identities ?? {}).some((v) => String(v ?? "").toLowerCase().includes(needle)));
}

export function identityChips(values: IdentityValues): string[] {
  const chips: string[] = [];
  if (values.discordUsername) chips.push(`Discord @${values.discordUsername}`);
  if (values.discordUserId) chips.push(`Discord ID ${values.discordUserId}`);
  if (values.nafName || values.nafId) chips.push(`NAF ${values.nafName || "account"}${values.nafId ? ` #${values.nafId}` : ""}`);
  if (values.tournamentCoachId) chips.push(`Tournament ${values.tournamentCoachId}`);
  return chips;
}

// ---- games ----

export interface GameView { gameId: string; status: string; half: number; turn: number; started: string; homeTeamId: string; homeTeamName: string; homeCoach: string; awayTeamId: string; awayTeamName: string; awayCoach: string }

export function normalizedGame(game: ForkGameRow | undefined, detail?: ForkGameRow): GameView {
  return {
    gameId: gameIdOf(game) || gameIdOf(detail),
    status: String(game?.status ?? detail?.status ?? "active"),
    half: Number(game?.half ?? detail?.half ?? 0),
    turn: Number(game?.turn ?? detail?.turn ?? 0),
    started: String(game?.started ?? detail?.started ?? ""),
    homeTeamId: String(game?.homeTeamId ?? detail?.homeTeamId ?? ""),
    homeTeamName: String(game?.homeTeamName ?? game?.homeTeam ?? detail?.homeTeamName ?? detail?.homeTeam ?? "Home team"),
    homeCoach: String(game?.homeCoach ?? detail?.homeCoach ?? ""),
    awayTeamId: String(game?.awayTeamId ?? detail?.awayTeamId ?? ""),
    awayTeamName: String(game?.awayTeamName ?? game?.awayTeam ?? detail?.awayTeamName ?? detail?.awayTeam ?? "Away team"),
    awayCoach: String(game?.awayCoach ?? detail?.awayCoach ?? ""),
  };
}

/** The live games list, filled in from the per-user rows (which carry more detail). */
export function gameList(games: unknown, users: ForkUser[]): GameView[] {
  const details = new Map<string, ForkGameRow>();
  for (const u of users) for (const g of u.games) if (gameIdOf(g)) details.set(gameIdOf(g), g);
  return safeArray<ForkGameRow>(games).map((g) => normalizedGame(g, details.get(gameIdOf(g))));
}

export const goldLabel = (v: unknown): string => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== "" ? `${n.toLocaleString()} gold` : "unknown treasury"; };

// ---- teams (admin.js roster helpers) ----

export interface RosterPosition { positionId: string | number; name: string; cost?: number; max?: number; isStar?: boolean; type?: string; MA?: unknown; ST?: unknown; AG?: unknown; PA?: unknown; AV?: unknown }
export interface Roster { raceName?: string; positions?: RosterPosition[] }

export function rosterStat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const m = String(value ?? "").match(/^\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

export const STAT_FIELDS: ReadonlyArray<readonly ["MA" | "ST" | "AG" | "PA" | "AV", string]> = [["MA", "movement"], ["ST", "strength"], ["AG", "agility"], ["PA", "passing"], ["AV", "armour"]];

/** Positive = improvement, negative = lasting injury (AG and PA count down). null when either side is unknown. */
export function playerStatModifier(player: Record<string, unknown>, position: RosterPosition | null | undefined, stat: "MA" | "ST" | "AG" | "PA" | "AV", field: string): number | null {
  const base = rosterStat(position?.[stat]);
  const raw = player?.[field];
  const current = raw === null || raw === undefined ? Number.NaN : Number(raw);
  if (base === null || base < 1 || !Number.isFinite(current) || current < 1) return null;
  return stat === "AG" || stat === "PA" ? base - current : current - base;
}

export const isTempRetired = (status: unknown): boolean => /temporarilyretired/i.test(String(status ?? "").replace(/[\s_-]+/g, ""));

/** Hireable positions of the team's roster (no stars or staff). */
export function hireablePositions(roster: Roster | null | undefined): RosterPosition[] {
  return safeArray<RosterPosition>(roster?.positions).filter((p) => p?.isStar !== true && !/star|staff/i.test(String(p?.type ?? "")));
}

// ---- reports ----

export const REPORT_STATUSES = ["new", "triaged", "in-progress", "resolved", "closed"] as const;

export function reportTriage(r: { triage?: Record<string, unknown> } | null | undefined): { status: string; rootCause: string; reason: string; updatedAt: string; updatedBy: string } {
  const t = r?.triage ?? {};
  return { status: String(t.status ?? "new"), rootCause: String(t.rootCause ?? ""), reason: String(t.reason ?? ""), updatedAt: String(t.updatedAt ?? ""), updatedBy: String(t.updatedBy ?? "") };
}

export function reportPlayerUpdate(r: { playerUpdate?: Record<string, unknown> } | null | undefined): { reply: string; replyAt: string; fixedIn: string; updatedAt: string } {
  const u = r?.playerUpdate ?? {};
  return { reply: String(u.reply ?? ""), replyAt: String(u.replyAt ?? ""), fixedIn: String(u.fixedIn ?? ""), updatedAt: String(u.updatedAt ?? "") };
}

export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

export const formatBytes = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** The one PATCH /api/bug-reports/:id body: the private triage and the player-visible reply / Fixed-in together. */
export function triageBody(form: { status: string; rootCause: string; reason: string; reply: string; fixedIn: string }): { status: string; rootCause: string; reason: string; reply: string; fixedIn: string } {
  return { status: form.status, rootCause: form.rootCause, reason: form.reason, reply: form.reply, fixedIn: form.fixedIn };
}
