/**
 * Config pane HTTP server — zero framework (Node built-in http), so it hosts
 * anywhere Node runs. Serves the static wizard (public/) + a small JSON API.
 *
 * Binds to 127.0.0.1 by default. To expose it, set HOST=0.0.0.0 AND ADMIN_PASSWORD
 * (Basic auth). Over a public network put it behind TLS — Basic auth is plaintext.
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeTeam,
  composeTeamIntrinsic,
  findPosition,
  findRoster,
  loadPackage,
  renderArtPrompt,
  renderPackageHtml,
  rosterOptions,
  rosterOptionsIntrinsic,
  skillAccess,
  validate,
  type ComposeIntrinsicResult,
  type Roster,
  type TeamPick,
  type TournamentPackage,
} from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import {
  adminCache,
  adminClose,
  adminConcede,
  adminDelete,
  adminList,
  adminListLive,
  adminMessage,
  buildForkJnlp,
  createForkAccount,
  createForkAccountDigest,
  coachSecretDigest,
  forkAdminConfigFromEnv,
  forkConfigFromEnv,
  forkDbConfigFromEnv,
  HOME_AWAY_MODES,
  type HomeAwayMode,
  fetchForkTeam,
  ingestForkTeam,
  findLibraryTeamByName,
  isLoadedOnFork,
  jnlpFilename,
  libraryCoaches,
  listForkCoaches,
  Matchmaker,
  listCoachGames,
  type CoachGameScope,
  queryCoaches,
  readLibrary,
  reloadFork,
  retireLibraryTeam,
  scheduleForkGame,
  upsertLibraryTeam,
  verifyCoachPassword,
  verifyCoachDigest,
} from "@bb/fork-ops";
import { PackageFiles, readCoachRegistry, readCoaches, skillCatalog, starList, teamList } from "./data";
import { packageResponseInfo, packageRulesInfo, resolveBuilderPackage } from "./teamBuilderPackage.js";
import { PRESETS } from "./presets";
import { handleAuthPortal } from "./auth/portal.js";
import { requireSession, type SessionIdentity } from "./auth/requireSession.js";
import { coachLogin, sendCoachLogin } from "./auth/coachLogin.js";
import { bearerTokenFromRequest, getSession, sessionTokenFromRequest } from "./auth/session.js";
import { BANNED_ACCOUNT_MESSAGE, coachLevel, isAdmin, isBanned, isOrganizer } from "./auth/access.js";
import {
  normalizeForkName,
  readIdentities,
  upsertIdentity,
  type CoachIdentities,
  type CoachIdentityRecord,
  type CoachLevel,
} from "./auth/identitiesStore.js";
import { legacyPasswordAuthCounts, noteLegacyPasswordAuth } from "./auth/deprecation.js";
import { attachSuper } from "./super/index.js";
import { createSiteBackend } from "./site-backend/index.js";
import { teamBuilderWireError } from "./teamBuilderWire.js";
import { corsDecision, parseAllowedOrigins } from "./cors.js";
import { forkGamesEndpoint } from "./forkGames.js";
import {
  BUG_REPORT_BODY_CAP,
  BodyTooLargeError,
  bugReportAccessError,
  getBugReport,
  listBugReports,
  readJsonCapped,
  submitBugReport,
} from "./bugReports.js";

/**
 * Endpoints reachable without ADMIN_PASSWORD even when it's set, AND always sent
 * with CORS headers (allowlist-reflected origin — SR-260 ④) on every response — success or error.
 * The FUMBBL40k client fetches these machine-to-machine (no user, no Basic-auth
 * credentials, no same-origin page to inherit cookies from), so gating behind Basic
 * auth or omitting CORS on an error path would just silently break the client flow
 * (a browser can't even READ a response body without CORS, error or not). Neither
 * route touches package/roster data — only caller-supplied coach/team/game values —
 * so leaving them open is a low-stakes tradeoff for a same-machine/LAN dev tool.
 * Revisit if this server is ever exposed beyond that.
 */
const PUBLIC_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/session",
  // Coach credential exchange (owner ruling 08-17). Public BY NATURE — it is the door you knock on
  // WITHOUT a token, and it is the only route that should ever see a coach password.
  "/api/fork/login",
  // Internally true-admin-gated; listed here so sidecar-off admin Bearer tokens can reach the handler.
  "/api/admin/identities",
  "/api/skills",
  "/api/stars",
  "/api/teams",
  "/api/presets",
  "/api/packages",
  "/api/export",
  "/api/artprompt",
  "/api/fork/jnlp",
  "/api/fork/register",
  "/api/fork/library",
  "/api/fork/library/ingest",
  // Retire Team (owner ruling 08-18): coach-scoped, does its own admin-OR-coach-password
  // auth in-handler exactly like team-builder/build below.
  "/api/fork/library/retire",
  "/api/fork/coaches",
  "/api/fork/challenge",
  "/api/fork/matchstatus",
  "/api/fork/cancel",
  "/api/fork/reload",
  // Team Builder V2 (in-client): reachable without the ADMIN password so a tester's client
  // can fetch/preview/build via its config-web seam. rosters+preview are open reads; build
  // does its own admin-OR-coach-password auth in-handler (see the build route).
  "/api/fork/rosters",
  "/api/fork/team-builder/legal-skills",
  "/api/fork/team-builder/preview",
  "/api/fork/team-builder/build",
  // #210 "your games in progress" (in-client lobby panel): reachable without the ADMIN password;
  // does its own admin-OR-coach-password auth in-handler (SR-197 TP-1 — list scoped to the
  // AUTHENTICATED coach, never an arbitrary ?coach= param).
  "/api/fork/my-games",
  // Session-gated in-handler; bypasses the separate legacy ADMIN_PASSWORD gate.
  "/api/fork/games",
  // Bug-report ingestion (owner feature 08-18): POST does its own coach auth in-handler
  // (session token OR coach creds — a report must be attributable); the GET listing/read
  // on the same path is organizer/admin-gated in-handler, fail closed (see bugReports.ts).
  "/api/bug-reports",
]);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(HERE, "../public");
const PORT = Number(process.env.PORT ?? 4310);
const HOST = process.env.HOST ?? "127.0.0.1";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
// SR-260 ④: browser origins allowed cross-origin access. Unset ⇒ same-origin/no-Origin only.
const CORS_ALLOWLIST = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
const AUTH_SIDECAR = process.env.AUTH_SIDECAR_ENABLED === "1";
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const sessionTokens = new Map<string, number>();
const PACKAGES_DIR = resolve(process.env.PACKAGES_DIR || join(HERE, "../../../tournament-packages"));
const VALIDATED_CSV = resolve(
  process.env.VALIDATED_CSV || join(HERE, "../../discord-bot/data-store/validated-rosters.csv"),
);
// Same-file read of the bot's coach identity registry (fumbblName/nafName/discordUserId) —
// lets the users panel link a fork account to its tournament identity by name, without
// config-web taking a code dependency on the discord-bot app.
const COACH_REGISTRY_JSON = resolve(
  process.env.COACH_REGISTRY_JSON || join(HERE, "../../discord-bot/data-store/coaches.json"),
);
// Fork team libraries (one JSON file per coach). Defaults under config-web's data-store.
const LIBRARY_DIR = resolve(process.env.FORK_LIBRARY_DIR || join(HERE, "../data-store/library"));
// Bug reports land here (one folder per report) for later ingestion by the owner.
const BUG_REPORTS_DIR = resolve(process.env.BUG_REPORTS_DIR || join(HERE, "../bug-reports"));
// Tracks the last successful fork (game server) reload — see @bb/fork-ops's forkReload.
const FORK_STATE_DIR = resolve(join(HERE, "../data-store"));

const packages = new PackageFiles(PACKAGES_DIR);
// Process-local matchmaking state (poll-based delivery, ~10min TTL) — see @bb/fork-ops.
// When FORK_ADMIN_PASSWORD is configured, pairing schedules a real game via the fork's own
// admin API (an authoritative gameId, same mechanism the owner used by hand) instead of
// relying solely on both sides guessing a shared gameName; falls back automatically
// (inside Matchmaker.pair) on any scheduling failure, so this is additive, not a hard
// dependency.
const forkAdminCfg = forkAdminConfigFromEnv();
// Authenticates /api/fork/challenge against the fork DB when it's configured, so
// "mutual consent" can't be spoofed by one caller issuing both sides under someone
// else's name (Yularen's #admin-gate-security amendment §4b). Off (open, dev-mode) when
// FORK_DB_HOST isn't set — same opt-in gate the other DB-backed routes already use.
const challengeDbCfg = forkDbConfigFromEnv();

// Persisted matchmaker settings (home/away policy) — survives a config-web restart so the
// admin's control-panel choice isn't lost. Tiny JSON in the same data-store as fork state.
const MATCHMAKING_SETTINGS_FILE = resolve(join(FORK_STATE_DIR, "matchmaking-settings.json"));
function loadMatchmakingSettings(): { homeAwayMode?: HomeAwayMode; overtime: boolean } {
  try {
    const raw = JSON.parse(readFileSync(MATCHMAKING_SETTINGS_FILE, "utf8")) as {
      homeAwayMode?: string;
      overtime?: boolean;
    };
    return {
      homeAwayMode: HOME_AWAY_MODES.find((m) => m === raw.homeAwayMode),
      overtime: raw.overtime === true,
    };
  } catch {
    return { overtime: false }; // no file / unreadable → matchmaker defaults, overtime off
  }
}
function saveMatchmakingSettings(): void {
  mkdirSync(FORK_STATE_DIR, { recursive: true });
  const settings = { homeAwayMode: matchmaker.getHomeAwayMode(), overtime: overtimeEnabled };
  writeFileSync(MATCHMAKING_SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
}

const initialSettings = loadMatchmakingSettings();
// Per-game OVERTIME opt-in (default off): mutable so the schedule closure below and the
// direct /api/fork/schedule handler read the CURRENT toggle value, not a startup snapshot.
let overtimeEnabled = initialSettings.overtime;

const matchmaker = new Matchmaker({
  scheduleGame: forkAdminCfg
    ? (teamHomeId, teamAwayId) => scheduleForkGame(forkAdminCfg, teamHomeId, teamAwayId, { overtime: overtimeEnabled })
    : undefined,
  // Digest form: matchmaking reduces either credential carrier to md5(pw) at admission,
  // so the clear text never reaches this check (owner security ruling 08-17).
  verifyChallenger: challengeDbCfg
    ? (coach, passwordMd5) => verifyCoachDigest(challengeDbCfg, coach, passwordMd5)
    : undefined,
  homeAwayMode: initialSettings.homeAwayMode,
});

// --- Team Builder (V1) ---
// Baseline ruleset for standalone builds (owner-ruled): open-league, 1000k gold, no SP, no
// stars. Enforces CORE roster legality only (position caps, team size, gold, big-guy caps) —
// tournament-layer constraints (e.g. the Insignificant-trait ratio) are relaxed so a plain
// build of an inherently-Insignificant roster (Snotling, Halfling…) is legal. When the
// tournament-provisioning flow calls the composer later it swaps in the TO package — same
// validate(), different pkg.
const { pkg: TEAM_BUILDER_BASELINE } = loadPackage({
  name: "Team Builder Baseline",
  goldBudget: 1_000_000,
  eligibleRosters: ["*"],
  special: { insignificantTraitConstraint: false },
});

/** The base BB2025 rosters on disk, keyed by rosterId. "Base" = a non-numeric rosterId
 *  (imported team rosters carry numeric ids) whose race the dataset resolves. */
function loadBaseForkRosters(teamsDir: string): Map<string, string> {
  const dir = join(dirname(teamsDir), "rosters");
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".xml")) continue;
    try {
      const xml = readFileSync(join(dir, f), "utf8");
      const opts = rosterOptions(xml, bb2025);
      if (opts.rosterId && /\D/.test(opts.rosterId) && opts.positions.length > 0 && !out.has(opts.rosterId)) {
        out.set(opts.rosterId, xml);
      }
    } catch {
      /* skip unreadable / non-roster xml */
    }
  }
  return out;
}

/** A Secret League rosterId is the numeric fork team-id fallback (`1064979`); base BB2025 rosters
 *  carry a slug id (`snotling.bb2025`). This is the discriminator between the dataset path and the
 *  roster-intrinsic path (#52 A). */
const isSlRosterId = (id: string): boolean => /^\d+$/.test(id);

/** Secret League / imported rosters the bb2025 dataset can't resolve (numeric rosterId), keyed by
 *  rosterId. Parsed roster-intrinsically (stats/cost/caps from the XML itself) — the parallel of
 *  {@link loadBaseForkRosters} for off-dataset races (#52 A). */
function loadSecretLeagueForkRosters(teamsDir: string): Map<string, string> {
  const dir = join(dirname(teamsDir), "rosters");
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".xml")) continue;
    try {
      const xml = readFileSync(join(dir, f), "utf8");
      const opts = rosterOptionsIntrinsic(xml);
      if (opts.rosterId && isSlRosterId(opts.rosterId) && opts.positions.length > 0 && !out.has(opts.rosterId)) {
        out.set(opts.rosterId, xml);
      }
    } catch {
      /* skip unreadable / non-roster xml */
    }
  }
  return out;
}

/**
 * Register a Team-Builder-created team in the coach's LIBRARY (#52 stage-5 bounce, TK-421).
 *
 * A built team was written to `teams/` + fork-reloaded, but the challenge route resolves a coach's
 * teams from the per-coach library JSON (`readLibrary`, `bb-fork-ops/library.ts`) — NOT from `teams/`.
 * `upsertLibraryTeam` had exactly ONE call site (the team-IMPORT path), so EVERY builder-created team
 * (base AND Secret League) was unplayable: the challenge 400s with "Team <id> isn't in <coach>'s
 * library." This mirrors the import path's upsert so a built team is actually challengeable.
 *
 * ⚠ `ingestedAt` MUST be stamped BEFORE the fork reload: the challenge route's `isLoadedOnFork` gates
 * on `ingestedAt <= lastReloadAt`, so a timestamp taken after the reload would 409 ("isn't loaded on
 * the fork yet") until the next reload.
 * ⚠ `teamValue` is TV in THOUSANDS (LibraryTeam's contract). It's derived from the composed summary,
 * not parsed back off our XML: the composer writes `<currentTeamValue>` in fork-native 10k units
 * (830k ⇒ 83), which `parseTeamXmlMeta`'s `>= 10000` heuristic would read as a literal 83.
 */
/**
 * Reject a team NAME that collides with any already-created team, globally (FUMBBL names
 * are unique fork-wide, not per-coach — see findLibraryTeamByName). `excludeTeamId` lets a
 * resubmission of the SAME team (same teamId) pass through without tripping on its own row;
 * currently every team-builder build mints a fresh teamId (mintTeamId), so this exclusion
 * is a no-op today but is kept for whenever a true in-place-update path exists.
 */
function duplicateTeamNameError(teamName: string, excludeTeamId?: string): string | undefined {
  const clash = findLibraryTeamByName(LIBRARY_DIR, teamName, excludeTeamId);
  if (!clash) return undefined;
  return `A team named "${teamName.trim()}" already exists — choose another name.`;
}

function registerBuiltTeam(
  roster: Roster,
  teamId: string,
  totalGold: number,
  ingestedAt: string,
  forkLoadable: boolean,
): void {
  upsertLibraryTeam(LIBRARY_DIR, roster.coach, {
    teamId,
    teamName: roster.teamName,
    race: roster.rosterName,
    coach: roster.coach,
    teamValue: Math.round(totalGold / 1000),
    gold: 0, // a freshly built team has no treasury
    rerolls: roster.sideline.reRolls,
    fanFactor: roster.sideline.dedicatedFans,
    apothecary: roster.sideline.apothecary,
    forkLoadable,
    ingestedAt,
  });
}

interface TeamBuilderBody {
  rosterId?: string;
  coach?: string;
  teamName?: string;
  picks?: TeamPick[];
  reRolls?: number;
  apothecary?: boolean;
  cheerleaders?: number;
  assistantCoaches?: number;
  dedicatedFans?: number;
  specialRule?: string;
  /** Secret League path only: the TO-configured TV budget cap in gold (the fixed 1000k baseline
   *  can't fit SL TVs). Omitted ⇒ no budget check (the TO gates the cap out-of-band). */
  budget?: number;
  /** V2 coach-auth on the build path — the caller's fork-join password (not used by compose). */
  password?: string;
  /** Custom UAT mode (owner 08-04): apply ANY chosen skill/trait to a base roster with NO legality
   *  or budget validation — preview/build never reject. Gating comes later. */
  custom?: boolean;
  /** Tournament ruleset picker (owner GO): validate against this saved package instead of the
   *  standalone baseline. Omitted ⇒ current baseline behavior, byte-identical. Unknown name ⇒ 4xx. */
  packageName?: string;
}

/** Resolve a Secret League builder request to a composed team + roster-intrinsic legality (#52 A).
 *  Legality is enforced by the composer (off-dataset ⇒ dataset `validate()` can't run) — the caller
 *  checks `.legal`/`.issues`, never the dataset validator. */
function composeIntrinsicFromBody(teamsDir: string, body: TeamBuilderBody): ComposeIntrinsicResult {
  if (!body.rosterId) throw new Error("rosterId is required.");
  if (!body.coach?.trim()) throw new Error("coach is required.");
  if (!body.teamName?.trim()) throw new Error("teamName is required.");
  if (!Array.isArray(body.picks) || body.picks.length === 0) throw new Error("At least one player pick is required.");
  const xml = loadSecretLeagueForkRosters(teamsDir).get(body.rosterId);
  if (!xml) throw new Error(`Unknown Secret League rosterId "${body.rosterId}".`);
  return composeTeamIntrinsic({
    forkRosterXml: xml,
    coach: body.coach.trim(),
    teamName: body.teamName.trim(),
    picks: body.picks,
    reRolls: body.reRolls ?? 0,
    apothecary: body.apothecary === true,
    cheerleaders: body.cheerleaders,
    assistantCoaches: body.assistantCoaches,
    dedicatedFans: body.dedicatedFans,
    budget: body.budget,
  });
}

/** Resolve a builder request to a composed team (throws with a client-safe message on bad input). */
function composeFromBody(teamsDir: string, body: TeamBuilderBody) {
  if (!body.rosterId) throw new Error("rosterId is required.");
  if (!body.coach?.trim()) throw new Error("coach is required.");
  if (!body.teamName?.trim()) throw new Error("teamName is required.");
  if (!Array.isArray(body.picks) || body.picks.length === 0) throw new Error("At least one player pick is required.");
  const xml = loadBaseForkRosters(teamsDir).get(body.rosterId);
  if (!xml) throw new Error(`Unknown rosterId "${body.rosterId}".`);
  return composeTeam(
    {
      forkRosterXml: xml,
      coach: body.coach.trim(),
      teamName: body.teamName.trim(),
      picks: body.picks,
      reRolls: body.reRolls ?? 0,
      apothecary: body.apothecary === true,
      cheerleaders: body.cheerleaders,
      assistantCoaches: body.assistantCoaches,
      dedicatedFans: body.dedicatedFans,
      specialRule: body.specialRule,
      custom: body.custom === true,
    },
    bb2025,
  );
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
};

function authorized(req: IncomingMessage, pathname: string): boolean {
  if (!ADMIN_PASSWORD) return true; // open when no password set (localhost default)
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/api/packages/")) return true;
  // Public rules-builder surface: the TO ruleset editor authenticates IN-UI via a bearer
  // token (POST /api/auth/login → gate on POST /api/packages), so its page + static deps
  // must load without the admin Basic-auth prompt. GET/HEAD only, on the specific
  // rules-builder paths + shared /assets/ + the "/" landing and /index.html (they redirect
  // to the public editor, the default landing — owner 2026-08-05). The users/tournaments
  // panels stay Basic-gated; writes remain token/Basic-gated in-handler.
  {
    const method = req.method ?? "GET";
    if (
      (method === "GET" || method === "HEAD") &&
      (pathname === "/" ||
        pathname === "/index.html" ||
        pathname === "/tournament-rules.html" ||
        pathname === "/tournament-rules.css" ||
        pathname === "/tournament-rules.js" ||
        pathname === "/admin.html" ||
        pathname === "/admin.css" ||
        pathname === "/admin.js" ||
        pathname.startsWith("/assets/"))
    )
      return true;
  }
  const header = req.headers.authorization ?? "";
  const m = header.match(/^Basic (.+)$/);
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return password === ADMIN_PASSWORD;
}

/**
 * Gate for the admin-panel/proxy routes (§5/§6 of ForVeers-admin-schedule-panel-spec.md):
 * these expose real admin power (close/delete/concede/broadcast a live game) and must
 * NOT ride on `authorized()`'s open-by-default behavior. `authorized()` returns `true`
 * for everything when `ADMIN_PASSWORD` is unset (the historical "open on localhost dev"
 * default) — fine for reads, wrong for admin mutations on a box that's bound 0.0.0.0
 * with testers actively connected (Yularen's #admin-gate-security amendment §5b). So
 * these routes independently require `ADMIN_PASSWORD` to be configured, on top of
 * whatever `authorized()` already enforced to get this far.
 */
function requireAdminGate(res: ServerResponse, auth?: SessionIdentity): boolean {
  if (AUTH_SIDECAR) {
    if (auth) return true;
    sendJson(res, 401, { error: "Authentication required." });
    return false;
  }
  if (!ADMIN_PASSWORD) {
    sendJson(res, 503, {
      error: "Admin routes require ADMIN_PASSWORD to be set on this host (real auth, not open-by-default).",
    });
    return false;
  }
  return true;
}

/**
 * Is this request carrying the admin Basic-auth password? Mirrors `authorized()`'s check,
 * but usable INSIDE a handler for a PUBLIC_PATHS route (which `authorized()` waves through) —
 * lets the Team Builder V2 build route accept the TO/admin path OR fall through to coach-auth.
 */
function isAdminAuthed(req: IncomingMessage): boolean {
  if (!ADMIN_PASSWORD) return false;
  const m = (req.headers.authorization ?? "").match(/^Basic (.+)$/);
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  return decoded.slice(decoded.indexOf(":") + 1) === ADMIN_PASSWORD;
}

/**
 * Coach identity proven by `Authorization: Bearer <token>` from POST /api/fork/login. Distinct from
 * `isTokenAuthed` below, which reads the ADMIN token store (`sessionTokens`) — the two Bearer stores
 * never overlap, so an admin token yields no coach identity and a coach token no admin rights.
 */
function bearerIdentity(req: IncomingMessage): SessionIdentity | undefined {
  const session = getSession(bearerTokenFromRequest(req));
  return session
    ? {
        coach: session.coach,
        organizer: coachLevel(session.coach) !== "player" || isOrganizer(session.coach),
        admin: isAdmin(session.coach),
      }
    : undefined;
}

function isTokenAuthed(req: IncomingMessage): boolean {
  const m = (req.headers.authorization ?? "").match(/^Bearer (.+)$/);
  if (!m) return false;
  const token = m[1]!;
  const expiry = sessionTokens.get(token);
  if (expiry === undefined) return false;
  if (expiry <= Date.now()) {
    sessionTokens.delete(token);
    return false;
  }
  return true;
}

function requireAdminLevel(req: IncomingMessage, res: ServerResponse, auth?: SessionIdentity): boolean {
  if (auth?.admin === true || isAdminAuthed(req) || isTokenAuthed(req)) return true;
  sendJson(res, auth ? 403 : 401, { error: auth ? "Admin access required." : "Authentication required." });
  return false;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  // prevent path traversal
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const buf = await readFile(full);
    res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isOrganizerWrite(method: string, pathname: string): boolean {
  if (!WRITE_METHODS.has(method)) return false;
  return (
    pathname === "/api/packages" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/api/admin/") ||
    pathname === "/api/fork/schedule" ||
    pathname === "/api/fork/message" ||
    pathname === "/api/fork/matchmaking-settings" ||
    pathname === "/api/fork/user/reset-password" ||
    pathname === "/api/fork/user/clear-games" ||
    /^\/api\/fork\/game\/[^/]+\/(close|delete|concede)$/.test(pathname) ||
    /^\/api\/(users|tournaments|schedule)(\/|$)/.test(pathname)
  );
}

function isStateChangingApiWrite(method: string, pathname: string): boolean {
  if (!pathname.startsWith("/api/") || !WRITE_METHODS.has(method)) return false;
  return (
    isOrganizerWrite(method, pathname) ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/fork/team-builder/build" ||
    pathname === "/api/bug-reports" ||
    pathname === "/api/admin/identities"
  );
}

function libraryOwnerForTeam(teamId: string): string | undefined {
  try {
    for (const libraryCoach of libraryCoaches(LIBRARY_DIR)) {
      const team = readLibrary(LIBRARY_DIR, libraryCoach).find((entry) => entry?.teamId === teamId);
      if (team) return (typeof team.coach === "string" ? team.coach.trim() : "") || libraryCoach;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams,
  auth?: SessionIdentity,
): Promise<void> {
  const method = req.method ?? "GET";

  if (path === "/api/auth/session" && (method === "GET" || method === "HEAD")) {
    if (!auth) return sendJson(res, 200, { authenticated: false });
    const session = getSession(sessionTokenFromRequest(req));
    return sendJson(res, 200, {
      authenticated: true,
      coach: auth.coach,
      organizer: auth.organizer,
      admin: auth.admin,
      ...(session ? { expiresAt: new Date(session.expiry).toISOString() } : {}),
    });
  }

  if (path === "/api/admin/identities" && method === "GET") {
    if (!requireAdminLevel(req, res, auth)) return;
    return sendJson(res, 200, { coaches: readIdentities().coaches });
  }

  if (path === "/api/admin/identities" && method === "POST") {
    if (!requireAdminLevel(req, res, auth)) return;
    const rawBody = await readBody(req);
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody))
      return sendJson(res, 400, { error: "A JSON object is required." });
    const body = rawBody as Record<string, unknown>;
    const forkName = typeof body.forkName === "string" ? body.forkName.trim() : "";
    if (!forkName) return sendJson(res, 400, { error: "forkName is required." });
    const levels: CoachLevel[] = ["player", "organizer", "admin"];
    if (body.level !== undefined && !levels.includes(body.level as CoachLevel))
      return sendJson(res, 400, { error: "level must be player, organizer, or admin." });
    if (body.banned !== undefined && typeof body.banned !== "boolean")
      return sendJson(res, 400, { error: "banned must be a boolean." });
    if (body.silenced !== undefined && typeof body.silenced !== "boolean")
      return sendJson(res, 400, { error: "silenced must be a boolean." });
    if (body.note !== undefined && typeof body.note !== "string")
      return sendJson(res, 400, { error: "note must be a string." });
    if (body.identities !== undefined && (!body.identities || typeof body.identities !== "object" || Array.isArray(body.identities)))
      return sendJson(res, 400, { error: "identities must be an object." });

    const key = normalizeForkName(forkName);
    const previous = readIdentities().coaches[key];
    const identities: CoachIdentities = { ...(previous?.identities ?? {}) };
    const identityPatch = (body.identities ?? {}) as Record<string, unknown>;
    for (const field of ["discordUserId", "discordUsername", "nafName", "nafId", "tournamentCoachId"] as const) {
      const value = identityPatch[field];
      if (value === undefined) continue;
      if (typeof value !== "string") return sendJson(res, 400, { error: `identities.${field} must be a string.` });
      identities[field] = value;
    }
    const record: CoachIdentityRecord = {
      forkName,
      level: (body.level as CoachLevel | undefined) ?? previous?.level ?? "player",
      banned: (body.banned as boolean | undefined) ?? previous?.banned ?? false,
      silenced: (body.silenced as boolean | undefined) ?? previous?.silenced ?? false,
      note: (body.note as string | undefined) ?? previous?.note ?? "",
      identities,
      updatedAt: new Date().toISOString(),
      updatedBy: auth?.coach ?? "admin",
    };
    try {
      const store = upsertIdentity(record);
      return sendJson(res, 200, { ok: true, coach: store.coaches[key] });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  if (path === "/api/skills" && method === "GET") return sendJson(res, 200, skillCatalog());

  if (path === "/api/teams" && method === "GET") return sendJson(res, 200, teamList());

  if (path === "/api/stars" && method === "GET") return sendJson(res, 200, starList());

  if (path === "/api/presets" && method === "GET")
    return sendJson(res, 200, PRESETS.map((p) => ({ id: p.id, label: p.label, pkg: p.pkg })));

  if (path === "/api/auth/login" && method === "POST") {
    if (!ADMIN_PASSWORD)
      return sendJson(res, 503, { error: "Login is unavailable: ADMIN_PASSWORD is not configured on this host." });
    const body = (await readBody(req)) as { password?: string } | null;
    if (body?.password !== ADMIN_PASSWORD) return sendJson(res, 401, { error: "Invalid password." });
    const token = randomBytes(32).toString("hex");
    const expiry = Date.now() + TOKEN_TTL_MS;
    sessionTokens.set(token, expiry);
    return sendJson(res, 200, { token, expiresAt: new Date(expiry).toISOString() });
  }

  if (path === "/api/packages" && method === "GET") return sendJson(res, 200, packages.list());

  if (path === "/api/packages" && method === "POST") {
    if (!AUTH_SIDECAR && ADMIN_PASSWORD && !isAdminAuthed(req) && !isTokenAuthed(req)) return sendJson(res, 401, { error: "Saving a package requires login (bearer token) or admin auth." });
    const body = (await readBody(req)) as Partial<TournamentPackage>;
    if (!body || typeof body.name !== "string" || !body.name.trim())
      return sendJson(res, 400, { error: "A package name is required." });
    const { path: filePath, pkg, problems } = packages.save(body);
    return sendJson(res, 200, { ok: true, savedAs: filePath, name: pkg.name, problems });
  }

  const pkgMatch = path.match(/^\/api\/packages\/(.+)$/);
  if (pkgMatch && method === "GET") {
    const found = packages.get(decodeURIComponent(pkgMatch[1]!));
    if (!found) return sendJson(res, 404, { error: "Package not found." });
    // `rules` (additive): the derived tier summary + (with ?roster=) that race's effective
    // rules and budget — lets the Slot Builder show the ruleset and lock the build budget
    // WITHOUT a preview round-trip (a preview needs picks + coach + team name first).
    return sendJson(res, 200, {
      pkg: found.pkg,
      problems: found.problems,
      rules: packageRulesInfo(found.pkg, query.get("roster")),
    });
  }

  if (path === "/api/export" && method === "POST") {
    const body = (await readBody(req)) as Partial<TournamentPackage>;
    if (!body || typeof body.name !== "string" || !body.name.trim())
      return sendJson(res, 400, { error: "A package name is required." });
    const { pkg } = loadPackage(body);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderPackageHtml(pkg));
    return;
  }

  if (path === "/api/artprompt" && method === "POST") {
    const body = (await readBody(req)) as Partial<TournamentPackage>;
    if (!body || typeof body.name !== "string" || !body.name.trim())
      return sendJson(res, 400, { error: "A package name is required." });
    const { pkg } = loadPackage(body);
    return sendJson(res, 200, { prompt: renderArtPrompt(pkg) });
  }

  if (path === "/api/coaches" && method === "GET") {
    const pkg = query.get("package") ?? undefined;
    return sendJson(res, 200, readCoaches(VALIDATED_CSV, pkg));
  }

  // Coach credential exchange → session token (owner security ruling 08-17). See auth/coachLogin.ts:
  // this is the ONE route a coach password may travel on; every guarded route below prefers the
  // resulting `Authorization: Bearer <token>` and treats a password param as deprecated back-compat.
  if (path === "/api/fork/login" && method === "POST") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON request body." });
    }
    const result = await coachLogin(req, {
      body,
      authenticationAvailable: challengeDbCfg !== undefined,
      verifyCoachDigest: (coach, passwordMd5) =>
        challengeDbCfg ? verifyCoachDigest(challengeDbCfg, coach, passwordMd5) : Promise.resolve(false),
    });
    return sendCoachLogin(res, result);
  }

  // Migration telemetry (never credentials — see auth/deprecation.ts). Admin-gated: it tells a TO
  // whether any client in the field still sends passwords, i.e. whether the back-compat path can go.
  if (path === "/api/fork/legacy-password-auth" && method === "GET") {
    if (!requireAdminGate(res, auth)) return;
    return sendJson(res, 200, { counts: legacyPasswordAuthCounts() });
  }

  // FUMBBL40k client's one-click Launch: fetch a fork-join JNLP directly (no Discord
  // round-trip). Machine-to-machine — see PUBLIC_PATHS for why this bypasses auth
  // (CORS is set centrally in the server handler, covering this route's errors too).
  if (path === "/api/fork/jnlp" && method === "GET") {
    const coach = query.get("coach")?.trim();
    const teamId = query.get("teamId")?.trim();
    const gameName = query.get("gameName")?.trim();
    if (!coach || !teamId || !gameName)
      return sendJson(res, 400, { error: "coach, teamId and gameName are required." });
    if (isBanned(coach)) return sendJson(res, 403, { error: BANNED_ACCOUNT_MESSAGE });
    // Dual-accept: `passwordMd5` (current clients) or `password` (deprecated). The JNLP
    // carries whichever we end up with as `-passwordMd5`, so the clear text no longer
    // lands in a file on the coach's disk. See buildForkJnlp for why this argument is
    // ours to rename (upstream has no password argument at all).
    let jnlpDigest: string | undefined;
    try {
      const reduced = coachSecretDigest({
        passwordMd5: query.get("passwordMd5")?.trim() || undefined,
        password: query.get("password")?.trim() || undefined,
      });
      jnlpDigest = reduced.digest;
      if (reduced.legacy) noteLegacyPasswordAuth("fork/jnlp");
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
    const jnlp = buildForkJnlp({ coach, teamId, gameName, passwordMd5: jnlpDigest });
    res.writeHead(200, {
      "content-type": "application/x-java-jnlp-file; charset=utf-8",
      "content-disposition": `attachment; filename="${jnlpFilename(gameName, coach)}"`,
    });
    res.end(jnlp);
    return;
  }

  // FUMBBL40k client's "Register this coach on the fork" button (Connection pane).
  // Idempotent upsert — same fork coach, calling it again just resets the password.
  // The client (case 428) sends the coach's chosen password; if omitted we fall back
  // to the fixed test password "12345" (backwards compatible with the old caller).
  if (path === "/api/fork/register" && method === "GET") {
    const coach = query.get("coach")?.trim();
    if (!coach) return sendJson(res, 400, { error: "coach is required." });
    const cfg = forkDbConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork DB not configured on this host (set FORK_DB_HOST)." });
    try {
      // Dual-accept, same as login. This route SETS the password, so a clear-text
      // `password=` here used to put the coach's chosen secret into the query string of
      // every access and proxy log on the way; `passwordMd5` ends that.
      const { digest, legacy } = coachSecretDigest({
        passwordMd5: query.get("passwordMd5")?.trim() || undefined,
        password: query.get("password")?.trim() || undefined,
      });
      if (legacy) noteLegacyPasswordAuth("fork/register");
      await createForkAccountDigest(cfg, coach, digest);
      return sendJson(res, 200, { ok: true, coach });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // List a coach's fork team library. Retired teams (see /library/retire below) are dropped
  // from this list — the row is kept on disk (audit trail, never deleted) but a retired team
  // has no business showing up as pickable inventory.
  if (path === "/api/fork/library" && method === "GET") {
    const coach = query.get("coach")?.trim();
    if (!coach) return sendJson(res, 400, { error: "coach is required." });
    return sendJson(res, 200, { teams: readLibrary(LIBRARY_DIR, coach).filter((t) => !t.retired) });
  }

  // Retire a team from a coach's fork library (owner ruling 08-18 "Retire Team", mirroring
  // upstream FUMBBL's site-side retirement). RESEARCH FINDING: the FFB game-server DOES define
  // a TeamStatus.RETIRED enum value (ffb-common TeamStatus.java / TeamStatusFactory.java, id 4)
  // but nothing in the fork's server code ever sets it — retirement is a FUMBBL SITE function,
  // not an FFB wire action, so there is no game-server call to mirror. The fork's own MariaDB
  // has no teams table either (only `ffb_coaches` — team state lives as XML under
  // FORK_TEAMS_DIR, loaded at reload time), so this fork's actual authority over "does this
  // team still count" is config-web's library JSON. Retirement here is therefore a soft-delete
  // at that layer: the LIBRARY row is flagged `retired` (see retireLibraryTeam) — never deleted,
  // so a played game's history keeps resolving the same teamId — and the coach-scoped listing
  // above drops it. Same auth shape as team-builder/build: Bearer session, OR admin auth, OR
  // coach name + fork password (deprecated back-compat) — and ONLY the owning coach may retire
  // their own team (auth.coach / the verified coach name IS the library key we look the team up
  // under, so there is no path to retiring someone else's team).
  if (path === "/api/fork/library/retire" && method === "GET") {
    const bodyCoach = query.get("coach")?.trim();
    const teamId = query.get("team")?.trim();
    const password = query.get("password")?.trim() || undefined;
    if (!teamId) return sendJson(res, 400, { error: "team is required." });
    let coach: string;
    if (auth) {
      coach = auth.coach;
    } else if (isAdminAuthed(req)) {
      if (!bodyCoach) return sendJson(res, 400, { error: "coach is required." });
      coach = bodyCoach;
    } else {
      if (!bodyCoach || !password) {
        return sendJson(res, 401, {
          error: "Retire requires a session token (POST /api/fork/login), or admin auth, or your coach name + fork password.",
        });
      }
      if (!challengeDbCfg) return sendJson(res, 503, { error: "Coach auth unavailable (fork DB not configured); admin auth required." });
      // DEPRECATED back-compat (owner ruling 08-17) — the token path above is the supported one.
      noteLegacyPasswordAuth("/api/fork/library/retire");
      if (!(await verifyCoachPassword(challengeDbCfg, bodyCoach, password)))
        return sendJson(res, 401, { error: "Coach authentication failed (wrong coach or password)." });
      coach = bodyCoach;
    }
    const team = readLibrary(LIBRARY_DIR, coach).find((t) => t.teamId === teamId);
    if (!team) return sendJson(res, 404, { error: `Team ${teamId} isn't in ${coach}'s library.` });
    if (team.retired) return sendJson(res, 200, { ok: true, team }); // idempotent
    // Best-effort in-progress-game guard: only checkable when the fork admin API is configured
    // (FORK_ADMIN_PASSWORD). Unreachable/unconfigured admin API doesn't block retirement — it's
    // a diagnostic-only check layered on top of the library-only source of truth.
    if (forkAdminCfg) {
      try {
        const live = await adminListLive(forkAdminCfg);
        if (live.some((g) => g.homeTeamId === teamId || g.awayTeamId === teamId)) {
          return sendJson(res, 409, { error: `"${team.teamName}" has a game in progress and can't be retired yet.` });
        }
      } catch {
        // fork admin unreachable — proceed; this check is advisory, not authoritative.
      }
    }
    const retired = retireLibraryTeam(LIBRARY_DIR, coach, teamId);
    if (!retired) return sendJson(res, 404, { error: `Team ${teamId} isn't in ${coach}'s library.` });
    return sendJson(res, 200, { ok: true, team: retired });
  }

  // Ingest a FUMBBL team (id or /t/<id> URL) into a coach's library: fetch → re-coach →
  // save team + roster XML into the fork's dirs → upsert the LibraryTeam row → attempt an
  // automatic fork reload so the ingest is actually joinable without a manual restart
  // (closes the ingest→challenge race — see @bb/fork-ops's forkReload / R3). Needs FORK_TEAMS_DIR.
  if (path === "/api/fork/library/ingest" && method === "GET") {
    const coach = query.get("coach")?.trim();
    const team = query.get("team")?.trim();
    if (!coach || !team) return sendJson(res, 400, { error: "coach and team are required." });
    const cfg = forkConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." });
    try {
      // Peek the FUMBBL team's name/id BEFORE persisting anything, so a name collision with an
      // already-created team is declined instead of silently landing two same-named teams in the
      // library (FUMBBL names are globally unique; excludeTeamId lets a re-ingest of the SAME
      // team — ownership move / refresh — pass through without tripping on its own row).
      const peek = await fetchForkTeam(team);
      const dupError = duplicateTeamNameError(peek.teamName, peek.teamId);
      if (dupError) return sendJson(res, 409, { error: dupError });
      const result = await ingestForkTeam(cfg, LIBRARY_DIR, coach, team, FORK_STATE_DIR);
      const reload = await reloadFork(cfg, FORK_STATE_DIR);
      if (reload.reloaded) {
        result.team.forkLoadable = true;
        upsertLibraryTeam(LIBRARY_DIR, coach, result.team);
        result.needsRestart = false;
      }
      return sendJson(res, 200, { ok: true, ...result, reload });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // Manually trigger a fork (game server) reload — e.g. after a batch of ingests, or to
  // retry a reload that was skipped because the fork looked busy. No-ops safely (returns
  // {reloaded:false,reason}) rather than force-killing a live game.
  if (path === "/api/fork/reload" && method === "GET") {
    const cfg = forkConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." });
    try {
      return sendJson(res, 200, await reloadFork(cfg, FORK_STATE_DIR));
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // Opponent-name autocomplete against fork coach names.
  if (path === "/api/fork/coaches" && method === "GET") {
    const q = query.get("q") ?? "";
    const limit = Number(query.get("limit") ?? 10);
    const exclude = query.get("coach")?.trim() || undefined;
    const cfg = forkDbConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork DB not configured on this host (set FORK_DB_HOST)." });
    try {
      return sendJson(res, 200, { coaches: await queryCoaches(cfg, q, limit, exclude) });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  if (path === "/api/fork/games" && method === "GET") {
    const result = await forkGamesEndpoint(auth !== undefined, forkAdminCfg);
    return sendJson(res, result.status, result.body);
  }

  // Enter matchmaking: record my pending challenge. Instant reciprocal matches are
  // delivered via the next matchstatus poll (both sides), so this always returns waiting.
  // Gated on the team being roster-loadable on the CURRENTLY RUNNING fork (re-derived fresh,
  // not trusting a possibly-stale library flag) — refusing here is what prevents the silent
  // join-timeout: a team whose roster isn't loaded yet must never be allowed into a challenge.
  // ⚠ The credential here is NOT (only) an auth credential: matchmaking.ts carries it into the
  // matched side's fork-join JNLP, i.e. it IS the FFB game-server join credential, so a session
  // token cannot replace it. But it does NOT have to be cleartext: the fork's standalone join
  // handler compares the CLIENT_JOIN field verbatim against `ffb_coaches.password`, which IS
  // md5(pw) hex — so the digest is exactly what the join needs. (An earlier note here called this
  // path "upstream wire" that "needs cleartext"; upstream's ClientParameters has no password
  // argument at all, so it is fork-local and ours to change. See the client-repo audit
  // docs/credential-plaintext-audit.md §3.) Dual-accept `passwordMd5` / `password` as elsewhere.
  if (path === "/api/fork/challenge" && method === "GET") {
    const coach = query.get("coach")?.trim();
    const teamId = query.get("teamId")?.trim();
    const opponent = query.get("opponent")?.trim();
    const password = query.get("password")?.trim() || undefined;
    const passwordMd5 = query.get("passwordMd5")?.trim() || undefined;
    if (password && !passwordMd5) noteLegacyPasswordAuth("fork/challenge");
    if (!coach || !teamId || !opponent)
      return sendJson(res, 400, { error: "coach, teamId and opponent are required." });
    if (isBanned(coach))
      return sendJson(res, 403, { error: BANNED_ACCOUNT_MESSAGE, side: "coach", coach });
    if (isBanned(opponent))
      return sendJson(res, 403, { error: BANNED_ACCOUNT_MESSAGE, side: "opponent", coach: opponent });
    const team = readLibrary(LIBRARY_DIR, coach).find((t) => t.teamId === teamId);
    if (!team) return sendJson(res, 400, { error: `Team ${teamId} isn't in ${coach}'s library.` });
    if (!isLoadedOnFork(FORK_STATE_DIR, team.ingestedAt)) {
      return sendJson(res, 409, {
        error: `"${team.teamName}" isn't loaded on the fork yet — it needs a reload after being ingested. Try again shortly, or ask an admin to run a reload.`,
      });
    }
    try {
      return sendJson(res, 200, await matchmaker.challenge({ coach, teamId, opponent, password, passwordMd5 }));
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // Poll for a match. Returns {status:"waiting"} or {status:"matched",gameName,opponent,jnlp}.
  if (path === "/api/fork/matchstatus" && method === "GET") {
    const coach = query.get("coach")?.trim();
    if (!coach) return sendJson(res, 400, { error: "coach is required." });
    return sendJson(res, 200, matchmaker.matchstatus(coach));
  }

  // Drop my pending challenge.
  if (path === "/api/fork/cancel" && method === "GET") {
    const coach = query.get("coach")?.trim();
    if (!coach) return sendJson(res, 400, { error: "coach is required." });
    matchmaker.cancel(coach);
    return sendJson(res, 200, { ok: true });
  }

  // --- Admin panel / proxy routes (ForVeers-admin-schedule-panel-spec.md §5/§6) ---
  // Real admin power (see requireAdminGate) — never added to PUBLIC_PATHS, and gated
  // independently of authorized()'s open-by-default behavior. Raw fork XML is returned
  // as-is (not yet parsed into normalized JSON): the admin `list`/`cache` response shape
  // hasn't been verified live against the fork the way `challenge`/`schedule` have been,
  // so surfacing the real XML now beats guessing a JSON shape that might not match.

  if (path === "/api/fork/games" && method === "GET") {
    if (!requireAdminGate(res, auth)) return;
    if (!forkAdminCfg) return sendJson(res, 503, { error: "Fork admin API not configured on this host (set FORK_ADMIN_PASSWORD)." });
    const status = query.get("status") ?? "all";
    try {
      const xml = await (status === "cache" ? adminCache(forkAdminCfg) : adminList(forkAdminCfg, status));
      return sendJson(res, 200, { xml });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // Direct/manual schedule (TO-driven matchmaking from the panel) — distinct from the
  // challenge-gated auto-schedule in /api/fork/challenge, same underlying admin call.
  if (path === "/api/fork/schedule" && method === "POST") {
    if (!requireAdminGate(res, auth)) return;
    if (!forkAdminCfg) return sendJson(res, 503, { error: "Fork admin API not configured on this host (set FORK_ADMIN_PASSWORD)." });
    const body = (await readBody(req)) as { homeTeamId?: string; awayTeamId?: string };
    if (!body.homeTeamId || !body.awayTeamId)
      return sendJson(res, 400, { error: "homeTeamId and awayTeamId are required." });
    for (const [side, teamId] of [
      ["home", body.homeTeamId],
      ["away", body.awayTeamId],
    ] as const) {
      const owner = libraryOwnerForTeam(teamId);
      if (!owner) {
        console.warn(`[ban-enforcement] Could not resolve ${side} team ${teamId} to a coach; allowing schedule.`);
        continue;
      }
      if (isBanned(owner))
        return sendJson(res, 403, { error: BANNED_ACCOUNT_MESSAGE, side, coach: owner });
    }
    try {
      return sendJson(res, 200, await scheduleForkGame(forkAdminCfg, body.homeTeamId, body.awayTeamId, { overtime: overtimeEnabled }));
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  const gameMatch = path.match(/^\/api\/fork\/game\/([^/]+)\/(close|delete|concede)$/);
  if (gameMatch && method === "POST") {
    if (!requireAdminGate(res, auth)) return;
    if (!forkAdminCfg) return sendJson(res, 503, { error: "Fork admin API not configured on this host (set FORK_ADMIN_PASSWORD)." });
    const [, gameId, op] = gameMatch;
    try {
      let xml: string;
      if (op === "close") xml = await adminClose(forkAdminCfg, gameId!);
      else if (op === "delete") xml = await adminDelete(forkAdminCfg, gameId!);
      else {
        const body = (await readBody(req)) as { teamId?: string };
        if (!body.teamId) return sendJson(res, 400, { error: "teamId is required to concede." });
        xml = await adminConcede(forkAdminCfg, gameId!, body.teamId);
      }
      return sendJson(res, 200, { ok: true, xml });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  if (path === "/api/fork/message" && method === "POST") {
    if (!requireAdminGate(res, auth)) return;
    if (!forkAdminCfg) return sendJson(res, 503, { error: "Fork admin API not configured on this host (set FORK_ADMIN_PASSWORD)." });
    const body = (await readBody(req)) as { text?: string };
    if (!body.text?.trim()) return sendJson(res, 400, { error: "text is required." });
    try {
      return sendJson(res, 200, { ok: true, xml: await adminMessage(forkAdminCfg, body.text) });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // --- Matchmaking settings (home/away policy toggle) ---
  // Read is admin-gated (it's a control-panel setting); the current mode + the available
  // choices back the panel's toggle. Change persists so it survives a config-web restart.
  if (path === "/api/fork/matchmaking-settings" && method === "GET") {
    if (!requireAdminGate(res, auth)) return;
    return sendJson(res, 200, { homeAwayMode: matchmaker.getHomeAwayMode(), modes: HOME_AWAY_MODES, overtime: overtimeEnabled });
  }
  if (path === "/api/fork/matchmaking-settings" && method === "POST") {
    if (!requireAdminGate(res, auth)) return;
    const body = (await readBody(req)) as { homeAwayMode?: string; overtime?: boolean };
    // homeAwayMode and overtime are independently optional — a toggle POST may set either.
    if (body.homeAwayMode !== undefined) {
      const mode = HOME_AWAY_MODES.find((m) => m === body.homeAwayMode);
      if (!mode)
        return sendJson(res, 400, { error: `homeAwayMode must be one of: ${HOME_AWAY_MODES.join(", ")}.` });
      matchmaker.setHomeAwayMode(mode);
    }
    if (body.overtime !== undefined) {
      if (typeof body.overtime !== "boolean")
        return sendJson(res, 400, { error: "overtime must be a boolean." });
      overtimeEnabled = body.overtime;
    }
    try {
      saveMatchmakingSettings();
      return sendJson(res, 200, { ok: true, homeAwayMode: matchmaker.getHomeAwayMode(), overtime: overtimeEnabled });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // --- Team Builder (V1): compose a legal team from picks → fork-loadable XML ---
  // List the base BB2025 rosters + their pickable positions (cost/cap/stats) for the builder.
  if (path === "/api/fork/rosters" && method === "GET") {
    // V2: open read (non-mutating, public BB2025 roster data) — reachable by a coach's client.
    const cfg = forkConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." });
    const rosters = [...loadBaseForkRosters(cfg.teamsDir).values()]
      .map((xml) => rosterOptions(xml, bb2025))
      .sort((a, b) => a.raceName.localeCompare(b.raceName));
    // Secret League / imported rosters the bb2025 dataset can't resolve (#52 A): parsed
    // roster-intrinsically. Budget is TO-configurable per roster (not the fixed 1000k), so the
    // client supplies `budget` on preview/build for these.
    const slRosters = [...loadSecretLeagueForkRosters(cfg.teamsDir).values()]
      .map((xml) => rosterOptionsIntrinsic(xml))
      .sort((a, b) => a.raceName.localeCompare(b.raceName));
    return sendJson(res, 200, { rosters, slRosters, goldBudget: 1_000_000, slBudgetConfigurable: true });
  }

  if (path === "/api/fork/team-builder/legal-skills" && method === "GET") {
    const cfg = forkConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." });
    const rosterId = query.get("rosterId")?.trim();
    const positionId = query.get("positionId")?.trim();
    if (!rosterId || !positionId)
      return sendJson(res, 400, { error: "rosterId and positionId are required." });

    const ro = [...loadBaseForkRosters(cfg.teamsDir).values()]
      .map((xml) => rosterOptions(xml, bb2025))
      .find((candidate) => candidate.rosterId === rosterId);
    if (!ro) return sendJson(res, 400, { error: `rosterId "${rosterId}" not found.` });

    const opt = ro.positions.find((position) => position.positionId === positionId);
    if (!opt) return sendJson(res, 400, { error: `positionId "${positionId}" not in roster ${rosterId}.` });
    const positionName = opt.name;

    if (isSlRosterId(rosterId)) {
      return sendJson(res, 200, {
        rosterId,
        positionId,
        positionName,
        primary: [],
        secondary: [],
        alreadyPrinted: opt.skills,
        intrinsic: true,
      });
    }

    const dsRoster = findRoster(bb2025, ro.raceName);
    const dsPos = dsRoster ? findPosition(dsRoster, positionName) : undefined;
    if (!dsPos)
      return sendJson(res, 400, { error: `position "${positionName}" not resolvable in the bb2025 dataset.` });

    const alreadyPrinted = new Set(dsPos.skills.map((skill) => skill.trim().toLowerCase()));
    const primary = [];
    const secondary = [];
    for (const [skillName, meta] of Object.entries(bb2025.skills)) {
      if (meta.trait || alreadyPrinted.has(skillName.trim().toLowerCase())) continue;
      const access = skillAccess(bb2025, dsPos, skillName);
      const skill = { skill: skillName, category: meta.category, elite: !!meta.elite };
      if (access === "primary") primary.push(skill);
      else if (access === "secondary") secondary.push(skill);
    }
    primary.sort((a, b) => a.skill.localeCompare(b.skill));
    secondary.sort((a, b) => a.skill.localeCompare(b.skill));

    return sendJson(res, 200, {
      rosterId,
      positionId,
      positionName,
      primary,
      secondary,
      alreadyPrinted: opt.skills,
    });
  }

  // Preview: compose + validate, no write. Returns legality findings + the recomputed summary.
  if (path === "/api/fork/team-builder/preview" && method === "POST") {
    // V2: open (non-mutating) — the caller previews their own picks; reveals nothing sensitive.
    const cfg = forkConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." });
    try {
      const body = (await readBody(req)) as TeamBuilderBody;
      const wireError = teamBuilderWireError(body);
      if (wireError) return sendJson(res, 400, { error: wireError });
      // Custom mode (owner 08-19): open to any fork player — no organizer/admin gate. Preview is
      // non-mutating, and the build route still authenticates the coach before any write.
      const resolvedPkg = resolveBuilderPackage(packages, TEAM_BUILDER_BASELINE, body.packageName);
      if ("error" in resolvedPkg) return sendJson(res, 400, { error: resolvedPkg.error });
      // Secret League path (#52 A): off-dataset roster → compose + validate roster-intrinsically.
      // (Packages don't apply here — the dataset validator can't run for an off-dataset race.)
      if (body.rosterId && isSlRosterId(body.rosterId)) {
        const composed = composeIntrinsicFromBody(cfg.teamsDir, body);
        return sendJson(res, 200, {
          valid: composed.legal,
          errors: composed.issues.map((i) => i.message),
          warnings: [],
          summary: composed.roster.summary,
          players: composed.roster.players.length,
          intrinsic: true,
        });
      }
      const composed = composeFromBody(cfg.teamsDir, body);
      const result = validate(composed.roster, resolvedPkg.pkg, bb2025);
      const packageInfo = packageResponseInfo(resolvedPkg, composed.roster.rosterName);
      // Custom UAT mode: never block — always valid, findings surfaced as informational warnings.
      return sendJson(res, 200, {
        valid: body.custom ? true : result.valid,
        errors: body.custom ? [] : result.errors,
        warnings: body.custom ? [...result.errors, ...result.warnings] : result.warnings,
        summary: result.recomputedSummary,
        players: composed.roster.players.length,
        ...(body.custom ? { custom: true } : {}),
        ...(packageInfo ? { package: packageInfo } : {}),
      });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // #210 "your games in progress": server-derived rows from ffb_games_info (the ratified source —
  // Pipeline §3.4 measurement, Meero SR-195/SR-197). AUTH (SR-197 TP-1, V2-build-route precedent):
  // admin Basic-auth may list for any coach (TO support view); otherwise {coach, password} is
  // verified against ffb_coaches and the list is scoped to THE AUTHENTICATED coach only — the
  // coach filter derives from proven identity, never from an unauthenticated parameter.
  // Rows carry gameId = the #211 rejoin handle (id-join needs NO teamId — SR-197 convergence).
  // Additive `scope` (replay-launcher history feature): omitted/anything-but-"finished" =
  // the original active-set query, byte-identical response — existing callers see NO change.
  // `scope: "finished"` swaps in the coach's finished/uploaded/backuped games (newest-finished
  // first, capped) with an added `finished` timestamp per row (see `listCoachGames`).
  if (path === "/api/fork/my-games" && method === "POST") {
    if (!challengeDbCfg)
      return sendJson(res, 503, { error: "Fork DB not configured on this host (set FORK_DB_HOST)." });
    const body = (await readBody(req)) as { coach?: string; password?: string; scope?: string };
    const coach = auth?.coach ?? body.coach?.trim();
    if (!coach) return sendJson(res, 400, { error: "coach is required" });
    if (!auth && !isAdminAuthed(req)) {
      if (!body.password)
        return sendJson(res, 401, { error: "Listing your games requires a session token (POST /api/fork/login), or your coach name + fork password (or admin auth)." });
      // DEPRECATED back-compat (owner ruling 08-17): accepted this release for clients in the field.
      noteLegacyPasswordAuth("/api/fork/my-games");
      if (!(await verifyCoachPassword(challengeDbCfg, coach, body.password)))
        return sendJson(res, 401, { error: "Coach authentication failed (wrong coach or password)." });
    }
    const scope: CoachGameScope = body.scope === "finished" ? "finished" : "active";
    try {
      return sendJson(res, 200, { coach, games: await listCoachGames(challengeDbCfg, coach, scope) });
    } catch (e) {
      return sendJson(res, 500, { error: (e as Error).message });
    }
  }

  // --- Bug-report ingestion (owner feature 08-18) --- see bugReports.ts for auth/limits.
  if (path === "/api/bug-reports" && method === "POST") {
    let body: unknown;
    try {
      // Route-specific 15MB cap, enforced while reading (readBody has no cap; this route
      // carries multi-MB logs, so it gets its own guarded reader — others are untouched).
      body = await readJsonCapped(req, BUG_REPORT_BODY_CAP);
    } catch (e) {
      if (e instanceof BodyTooLargeError) return sendJson(res, 413, { error: e.message });
      return sendJson(res, 400, { error: "Invalid JSON request body." });
    }
    const result = await submitBugReport(body, auth, {
      dir: BUG_REPORTS_DIR,
      authenticationAvailable: challengeDbCfg !== undefined,
      verifyCoachDigest: (coach, passwordMd5) =>
        challengeDbCfg ? verifyCoachDigest(challengeDbCfg, coach, passwordMd5) : Promise.resolve(false),
    });
    if (result.headers) res.writeHead(result.status, { "content-type": "application/json; charset=utf-8", ...result.headers }).end(JSON.stringify(result.body));
    else sendJson(res, result.status, result.body);
    return;
  }

  // Organizer/admin listing + read (fail closed — same idiom as custom:true, SR-260 ③).
  if ((path === "/api/bug-reports" || path.startsWith("/api/bug-reports/")) && method === "GET") {
    const gateError = bugReportAccessError({ organizer: auth?.organizer === true, adminAuthed: isAdminAuthed(req) || isTokenAuthed(req) });
    if (gateError) return sendJson(res, 403, { error: gateError });
    if (path === "/api/bug-reports") return sendJson(res, 200, { reports: listBugReports(BUG_REPORTS_DIR) });
    const report = getBugReport(BUG_REPORTS_DIR, decodeURIComponent(path.slice("/api/bug-reports/".length)));
    if (!report) return sendJson(res, 404, { error: "Bug report not found." });
    return sendJson(res, 200, { report });
  }

  // Build: re-validate SERVER-SIDE (never trust the client), then write team XML + hot-reload.
  // V2 auth (owner-ruled): TO path = admin Basic-auth (unchanged); else a coach may build a team
  // ONLY for their own authenticated coach — verify {coach, password} against ffb_coaches
  // (verifyCoachPassword, same md5 the fork uses), and the built team's coach must equal it.
  if (path === "/api/fork/team-builder/build" && method === "POST") {
    const cfg = forkConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." });
    const body = (await readBody(req)) as TeamBuilderBody;
    const wireError = teamBuilderWireError(body);
    if (wireError) return sendJson(res, 400, { error: wireError });
    // Custom mode (owner 08-19): open to any fork player — no organizer/admin gate. The coach-auth
    // block below still runs, so a custom team can only be written by an authenticated fork coach
    // (under their own name), or admin. Custom just skips the legality/budget validation, not auth.
    const resolvedPkg = resolveBuilderPackage(packages, TEAM_BUILDER_BASELINE, body.packageName);
    if ("error" in resolvedPkg) return sendJson(res, 400, { error: resolvedPkg.error });
    if (auth) {
      body.coach = auth.coach;
    } else if (!isAdminAuthed(req)) {
      const coach = body.coach?.trim();
      if (!coach || !body.password)
        return sendJson(res, 401, { error: "Build requires a session token (POST /api/fork/login), or admin auth, or your coach name + fork password." });
      if (!challengeDbCfg)
        return sendJson(res, 503, { error: "Coach auth unavailable (fork DB not configured); admin auth required." });
      // DEPRECATED back-compat (owner ruling 08-17) — the token path above is the supported one.
      noteLegacyPasswordAuth("/api/fork/team-builder/build");
      if (!(await verifyCoachPassword(challengeDbCfg, coach, body.password)))
        return sendJson(res, 401, { error: "Coach authentication failed (wrong coach or password)." });
      // The built team's coach === the authenticated coach: composeFromBody uses body.coach, and we
      // just verified body.password for body.coach — so a coach can only build under their own name.
    }
    try {
      // Secret League path (#52 A): off-dataset → compose + enforce roster-intrinsic legality here
      // (the dataset `validate()` can't run for a race the dataset doesn't carry). Same write+reload.
      if (body.rosterId && isSlRosterId(body.rosterId)) {
        const composed = composeIntrinsicFromBody(cfg.teamsDir, body);
        if (!composed.legal) {
          return sendJson(res, 400, {
            error: "Team is not legal — fix the findings and rebuild.",
            errors: composed.issues.map((i) => i.message),
            summary: composed.roster.summary,
          });
        }
        const dupError = duplicateTeamNameError(composed.roster.teamName, composed.teamId);
        if (dupError) return sendJson(res, 409, { error: dupError });
        mkdirSync(cfg.teamsDir, { recursive: true });
        const coachTag = composed.roster.coach.replace(/[^\w.-]+/g, "_") || "coach";
        const file = join(cfg.teamsDir, `team_${coachTag}_${composed.teamId}.xml`);
        writeFileSync(file, composed.xml, "utf8");
        const ingestedAt = new Date().toISOString(); // before the reload — see registerBuiltTeam
        const reload = await reloadFork(cfg, FORK_STATE_DIR);
        registerBuiltTeam(composed.roster, composed.teamId, composed.roster.summary!.total, ingestedAt, reload.reloaded);
        return sendJson(res, 200, { ok: true, teamId: composed.teamId, path: file, reload, summary: composed.roster.summary, intrinsic: true });
      }
      const composed = composeFromBody(cfg.teamsDir, body);
      const result = validate(composed.roster, resolvedPkg.pkg, bb2025);
      const packageInfo = packageResponseInfo(resolvedPkg, composed.roster.rosterName);
      // Custom UAT mode (owner 08-04): apply the choice, no validation gate — never reject.
      if (!body.custom && !result.valid) {
        return sendJson(res, 400, { error: "Team is not legal — fix the findings and rebuild.", errors: result.errors, summary: result.recomputedSummary, ...(packageInfo ? { package: packageInfo } : {}) });
      }
      const dupError = duplicateTeamNameError(composed.roster.teamName, composed.teamId);
      if (dupError) return sendJson(res, 409, { error: dupError });
      mkdirSync(cfg.teamsDir, { recursive: true });
      const coachTag = composed.roster.coach.replace(/[^\w.-]+/g, "_") || "coach";
      const file = join(cfg.teamsDir, `team_${coachTag}_${composed.teamId}.xml`);
      writeFileSync(file, composed.xml, "utf8");
      const ingestedAt = new Date().toISOString(); // before the reload — see registerBuiltTeam
      const reload = await reloadFork(cfg, FORK_STATE_DIR);
      // goldUsed = the validator's RECOMPUTED total (validate() ran on this path — prefer it over the
      // composer's own figure). The SL branch uses the composed summary, its strongest available number.
      registerBuiltTeam(composed.roster, composed.teamId, result.recomputedSummary.goldUsed, ingestedAt, reload.reloaded);
      return sendJson(res, 200, { ok: true, teamId: composed.teamId, path: file, reload, summary: result.recomputedSummary, ...(packageInfo ? { package: packageInfo } : {}) });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // --- Users control panel (master table: fork accounts <-> tournament identity) ---

  // Master table: every `ffb_coaches` fork account, left-joined (by case-insensitive
  // name match) against the tournament coach registry's `fumbblName`, annotated with
  // whether that coach is currently in a live game (see LIVE_GAME_STATUSES — there is
  // no single "all games" admin call, so this queries every in-play status and merges).
  if (path === "/api/fork/users" && method === "GET") {
    if (!requireAdminGate(res, auth)) return;
    const dbCfg = forkDbConfigFromEnv();
    if (!dbCfg) return sendJson(res, 503, { error: "Fork DB not configured on this host (set FORK_DB_HOST)." });
    try {
      const [forkNames, registry] = await Promise.all([
        listForkCoaches(dbCfg),
        Promise.resolve(readCoachRegistry(COACH_REGISTRY_JSON)),
      ]);
      const registryByName = new Map(
        registry.filter((e) => e.fumbblName).map((e) => [e.fumbblName!.trim().toLowerCase(), e]),
      );
      let liveGames: Awaited<ReturnType<typeof adminListLive>> = [];
      if (forkAdminCfg) {
        try {
          liveGames = await adminListLive(forkAdminCfg);
        } catch {
          // Fork admin unreachable — the table still renders, just without live-status.
        }
      }
      const gamesByCoach = new Map<string, (typeof liveGames)[number][]>();
      for (const g of liveGames) {
        for (const [coach, side] of [
          [g.homeCoach, "home"],
          [g.awayCoach, "away"],
        ] as const) {
          const key = coach.trim().toLowerCase();
          if (!key) continue;
          if (!gamesByCoach.has(key)) gamesByCoach.set(key, []);
          gamesByCoach.get(key)!.push({ ...g, mySide: side } as (typeof liveGames)[number] & { mySide: string });
        }
      }
      const seen = new Set<string>();
      const rows = forkNames.map((name) => {
        const key = name.trim().toLowerCase();
        seen.add(key);
        const linked = registryByName.get(key);
        return {
          fumbblName: name,
          linked: linked
            ? {
                id: linked.id,
                discordUserId: linked.discordUserId,
                nafName: linked.nafName,
                nafId: linked.nafId,
                teamCount: linked.teams.length,
              }
            : null,
          games: gamesByCoach.get(key) ?? [],
        };
      });
      // Registry entries with a fumbblName that ISN'T a fork account — surfaced so a
      // linked tournament identity is never silently hidden just because the coach
      // hasn't created (or hasn't yet re-created) their fork account.
      for (const e of registry) {
        const key = e.fumbblName?.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        rows.push({
          fumbblName: e.fumbblName!,
          linked: { id: e.id, discordUserId: e.discordUserId, nafName: e.nafName, nafId: e.nafId, teamCount: e.teams.length },
          games: [],
        });
      }
      rows.sort((a, b) => a.fumbblName.localeCompare(b.fumbblName));
      return sendJson(res, 200, { users: rows });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // Live games for one coach (home or away, case-insensitive) — backs the "In-Game" popup.
  const userGamesMatch = path.match(/^\/api\/fork\/user\/([^/]+)\/games$/);
  if (userGamesMatch && method === "GET") {
    if (!requireAdminGate(res, auth)) return;
    if (!forkAdminCfg) return sendJson(res, 503, { error: "Fork admin API not configured on this host (set FORK_ADMIN_PASSWORD)." });
    const name = decodeURIComponent(userGamesMatch[1]!).trim().toLowerCase();
    try {
      const games = (await adminListLive(forkAdminCfg)).filter(
        (g) => g.homeCoach.trim().toLowerCase() === name || g.awayCoach.trim().toLowerCase() === name,
      );
      return sendJson(res, 200, { games });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // Reset (or create) a fork account's password. Reuses the same upsert the client's
  // "Register this coach" button drives — a password reset IS just re-issuing that call.
  if (path === "/api/fork/user/reset-password" && method === "POST") {
    if (!requireAdminGate(res, auth)) return;
    const dbCfg = forkDbConfigFromEnv();
    if (!dbCfg) return sendJson(res, 503, { error: "Fork DB not configured on this host (set FORK_DB_HOST)." });
    const body = (await readBody(req)) as { username?: string; password?: string };
    if (!body.username?.trim()) return sendJson(res, 400, { error: "username is required." });
    try {
      await createForkAccount(dbCfg, body.username, body.password);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // Clear every live game (any in-play status) this coach is part of, home or away.
  // Deletes rather than closes — "clear" is meant to fully reset a stuck coach, not
  // leave finished-looking rows behind. Reports which gameIds were cleared and any
  // per-game delete failures rather than failing the whole request on one bad id.
  if (path === "/api/fork/user/clear-games" && method === "POST") {
    if (!requireAdminGate(res, auth)) return;
    if (!forkAdminCfg) return sendJson(res, 503, { error: "Fork admin API not configured on this host (set FORK_ADMIN_PASSWORD)." });
    const body = (await readBody(req)) as { username?: string };
    if (!body.username?.trim()) return sendJson(res, 400, { error: "username is required." });
    const name = body.username.trim().toLowerCase();
    try {
      const games = (await adminListLive(forkAdminCfg)).filter(
        (g) => g.homeCoach.trim().toLowerCase() === name || g.awayCoach.trim().toLowerCase() === name,
      );
      const cleared: string[] = [];
      const failed: { gameId: string; error: string }[] = [];
      for (const g of games) {
        try {
          await adminDelete(forkAdminCfg, g.gameId);
          cleared.push(g.gameId);
        } catch (e) {
          failed.push({ gameId: g.gameId, error: (e as Error).message });
        }
      }
      return sendJson(res, 200, { ok: failed.length === 0, cleared, failed });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  sendJson(res, 404, { error: "Unknown endpoint." });
}

// Dialect-1 `xml:` site-backend (spec-team-portal §3). Flag-gated (SITE_BACKEND_ENABLED) + additive:
// undefined unless the flag is set AND fork teams-dir + DB are configured, in which case it claims only
// the NEW `/xml:*` + fumbbl-client `/api/{clientoptions,name}` paths. Nothing config-web serves today
// hits those, so an un-flagged deploy is byte-behaviour-identical (strand-proof).
const siteBackend = createSiteBackend();

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      // The fork calls these machine-to-machine (a Java HTTP client, no Basic-auth) — dispatch BEFORE
      // authorized() so an ADMIN_PASSWORD'd host doesn't 401 the fork. Returns false for non-xml paths.
      if (siteBackend && (await siteBackend.handle(req, res, url.pathname, url.searchParams))) return;
      // SR-260 ④: allowlist CORS replacing the old wildcard. Set headers before any handler
      // writes, so they ride EVERY response — success or error (a browser can't read either
      // without them). No-Origin callers (curl, tauriFetch, the fork's Java client) are
      // untouched; an allowed origin is reflected (never *); any other Origin on an /api
      // path is refused outright — fail closed.
      const cors = corsDecision(req.headers.origin, req.headers.host, CORS_ALLOWLIST);
      if (cors.kind === "allowed") {
        res.setHeader("access-control-allow-origin", cors.origin);
        res.setHeader("vary", "origin");
        res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type,authorization,x-cw-auth");
      } else if (cors.kind === "denied" && url.pathname.startsWith("/api/")) {
        if (req.method === "OPTIONS") {
          res.writeHead(403).end();
          return;
        }
        return sendJson(res, 403, { error: "Origin not allowed (CORS_ALLOWED_ORIGINS)." });
      }
      // Preflight: answer for allowed origins, plus the historical no-Origin 204 on public paths.
      if (req.method === "OPTIONS" && (cors.kind === "allowed" || PUBLIC_PATHS.has(url.pathname))) {
        res.writeHead(204).end();
        return;
      }
      if (AUTH_SIDECAR) {
        if (
          await handleAuthPortal(req, res, url, {
            authenticationAvailable: challengeDbCfg !== undefined,
            verifyCoachPassword: (username, password) =>
              challengeDbCfg ? verifyCoachPassword(challengeDbCfg, username, password) : Promise.resolve(false),
          })
        )
          return;

        const decision = requireSession(req, url.pathname, url.search);
        if (decision.kind === "redirect") {
          res.writeHead(302, { location: decision.location, "cache-control": "no-store" }).end();
          return;
        }
        if (decision.kind === "unauthorized") {
          if (url.pathname.startsWith("/api/")) return sendJson(res, 401, { error: "Authentication required." });
          res.writeHead(401).end("auth required");
          return;
        }

        const method = req.method ?? "GET";
        const auth = decision.identity;
        if (isOrganizerWrite(method, url.pathname) && !auth?.organizer) {
          return sendJson(res, auth ? 403 : 401, {
            error: auth ? "Organizer access required." : "Authentication required.",
          });
        }
        // X-CW-Auth is a CSRF guard, and CSRF is a COOKIE problem: a cross-site form can make the
        // browser attach cw_session, but it cannot set an Authorization header. A request that
        // authenticated by Bearer is therefore exempt (owner ruling 08-17 — the FUMBBL40k client
        // carries a token, not a cookie, and must not need a second ceremonial header).
        if (auth && !bearerTokenFromRequest(req) && isStateChangingApiWrite(method, url.pathname) && req.headers["x-cw-auth"] !== "1") {
          return sendJson(res, 403, { error: "Missing required X-CW-Auth header." });
        }
        if (url.pathname.startsWith("/api/"))
          return await handleApi(req, res, url.pathname, url.searchParams, auth);
        await serveStatic(res, url.pathname);
        return;
      } else {
        if (!authorized(req, url.pathname)) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="BB Config"' }).end("auth required");
          return;
        }
      }
      // Sidecar-OFF path (the live host: ADMIN_PASSWORD mode). The coach session store is NOT
      // sidecar-gated — the owner's ruling has to land where the testers actually are — so resolve a
      // Bearer identity here too. It only ever ADDS proven identity: routes that consult `auth`
      // (my-games, team-builder/build) previously required a password param instead, and
      // requireAdminGate ignores `auth` entirely unless AUTH_SIDECAR is on, so no admin surface widens.
      if (url.pathname.startsWith("/api/"))
        return await handleApi(req, res, url.pathname, url.searchParams, bearerIdentity(req));
      await serveStatic(res, url.pathname);
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  })();
});

function isLocalBind(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1" || normalizedHost === "[::1]";
}

// Owner directive 08-05: expose config-web publicly over plain HTTP to unblock tester create-game.
// AUTH_SIDECAR_ALLOW_INSECURE_PUBLIC=1 consciously overrides the plain-HTTP-refuse guard so the sidecar
// may bind a non-localhost HOST. Safe for the tester box: it is already port-forwarded, every create-game
// route is in PUBLIC_PATHS, and organizer writes still require a session. Cleartext-over-HTTP is the
// accepted tester posture; TLS is still owed before any competitive/non-tester exposure (Meero SR-260).
const ALLOW_INSECURE_PUBLIC = process.env.AUTH_SIDECAR_ALLOW_INSECURE_PUBLIC === "1";
const LISTEN_HOST = AUTH_SIDECAR && !isLocalBind(HOST) && !ALLOW_INSECURE_PUBLIC ? "127.0.0.1" : HOST;
if (AUTH_SIDECAR && LISTEN_HOST !== HOST) {
  console.error(
    `[auth-sidecar] Refusing non-localhost HOST=${HOST} because config-web serves plain HTTP; binding to ${LISTEN_HOST}. Set AUTH_SIDECAR_ALLOW_INSECURE_PUBLIC=1 to override.`,
  );
} else if (AUTH_SIDECAR && ALLOW_INSECURE_PUBLIC && !isLocalBind(HOST)) {
  console.warn(
    `[auth-sidecar] AUTH_SIDECAR_ALLOW_INSECURE_PUBLIC=1 — binding ${HOST}:${PORT} over PLAIN HTTP; session cookies + coach creds travel in cleartext (TLS owed pre-competitive).`,
  );
}

server.listen(PORT, LISTEN_HOST, () => {
  console.log(`Config pane on http://${LISTEN_HOST}:${PORT}`);
  console.log(`  packages : ${PACKAGES_DIR}`);
  console.log(`  coaches  : ${VALIDATED_CSV}`);
  console.log(
    `  auth     : ${AUTH_SIDECAR ? "session sidecar enabled" : ADMIN_PASSWORD ? "password required" : "OPEN (set ADMIN_PASSWORD to lock)"}`,
  );
});

// Super Module (presentation sidecar) — flag-gated + double-guarded on config presence. attachSuper is
// a no-op unless SUPER_ENABLED=1, and construction failure disables Super without touching the HTTP
// server (SM-3). config-web serving is unaffected in every case.
if (challengeDbCfg && forkAdminCfg) {
  attachSuper(server, { dbCfg: challengeDbCfg, forkCfg: forkAdminCfg });
} else if (process.env.SUPER_ENABLED === "1") {
  console.log("[super] SUPER_ENABLED set but fork DB/admin config missing — Super stays OFF.");
}
