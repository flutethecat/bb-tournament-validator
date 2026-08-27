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
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  acknowledgeForkCacheReload,
  acknowledgeRecoveredTeamTransactions,
  acknowledgeRestoredTeamXmlTransaction,
  acquireTeamNameWriteLock,
  acquireTeamWriteLock,
  atomicWriteTextFile,
  beginTeamXmlTransaction,
  buildForkJnlp,
  coachExists,
  createForkAccount,
  createForkAccountDigest,
  createForkAccountDigestIfAvailable,
  coachSecretDigest,
  commitTeamXmlTransaction,
  forkAdminConfigFromEnv,
  forkCoachPasswordDigest,
  forkConfigFromEnv,
  forkCacheReloadRequired,
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
  markForkCacheReloadRequired,
  Matchmaker,
  listCoachGames,
  type CoachGameScope,
  queryCoaches,
  readLibrary,
  recoverTeamFileTransactions,
  restoreTeamXmlTransaction,
  reloadFork,
  retireLibraryTeam,
  scheduleForkGame,
  upsertLibraryTeam,
  updateTeamXmlTransactionLibraryTeam,
  verifyCoachPassword,
  verifyCoachDigest,
  type LibraryTeam,
} from "@bb/fork-ops";
import { PackageFiles, readCoachRegistry, readCoaches, skillCatalog, starList, teamList } from "./data";
import { packageResponseInfo, packageRulesInfo, resolveBuilderPackage } from "./teamBuilderPackage.js";
import { PRESETS } from "./presets";
import { handleAuthPortal } from "./auth/portal.js";
import { requireSession, type SessionIdentity } from "./auth/requireSession.js";
import { coachLogin, sendCoachLogin } from "./auth/coachLogin.js";
import {
  bearerTokenFromRequest,
  buildSessionCookie,
  createSession,
  getSession,
  parseCookies,
  requestUsesTls,
  sessionFromRequest,
  sessionTokenFromRequest,
} from "./auth/session.js";
import { BANNED_ACCOUNT_MESSAGE, coachLevel, isAdmin, isBanned, isOrganizer } from "./auth/access.js";
import {
  normalizeFfbCoachId,
  ownIdentityRecord,
  readIdentities,
  updateOwnAccount,
  upsertIdentity,
  type CoachIdentities,
  type CoachIdentityRecord,
  type CoachLevel,
} from "./auth/identitiesStore.js";
import { legacyPasswordAuthCounts, noteLegacyPasswordAuth } from "./auth/deprecation.js";
import { attachSuper } from "./super/index.js";
import { createSiteBackend } from "./site-backend/index.js";
import { replayDeferredGameResults } from "./site-backend/banking.js";
import { teamBuilderWireError } from "./teamBuilderWire.js";
import { builtLibraryTeam, registerBuiltTeam, resolveTeamBuilderBuildTarget, retargetComposedTeam } from "./teamBuilderBuild.js";
import { teamBuilderInducementCatalog } from "./teamBuilderInducements.js";
import { teamBuilderTierCatalog } from "./teamBuilderTiers.js";
import { corsDecision, parseAllowedOrigins } from "./cors.js";
import { teamEditingError } from "./customGate.js";
import { forkGamesEndpoint } from "./forkGames.js";
import {
  coachNamesEqual,
  storedTeamCoach,
  storedTeamFile,
  teamDetailEndpoint,
  teamDetailIdFromPath,
} from "./teamDetail.js";
import { advancementPath, teamAdvancementEndpoint } from "./teamAdvancement.js";
import { libraryIngestOwnershipError, parseLibraryIngestRequest } from "./teamIngestSecurity.js";
import {
  DEFAULT_JSON_BODY_CAP,
  JsonBodyError,
  MUTATION_JSON_BODY_CAP,
  readJsonBody,
} from "./requestBody.js";
import {
  BUG_REPORT_BODY_CAP,
  BodyTooLargeError,
  bugReportAccessError,
  getBugReport,
  listBugReports,
  readJsonCapped,
  submitBugReport,
} from "./bugReports.js";
import {
  TournamentMatchAccessError,
  TournamentMatchStore,
  buildInstructions,
  ensureTournamentInducementSetXml,
  instructionsForSession,
  teamSpecialRulesFromXml,
  type TournamentMatchMetadata,
} from "./tournamentMatch.js";
import {
  DISCORD_OAUTH_STATE_COOKIE,
  DISCORD_PENDING_COOKIE,
  DiscordOauthStateStore,
  PendingSsoStore,
  buildClearDiscordOauthStateCookie,
  buildClearDiscordPendingCookie,
  buildDiscordOauthStateCookie,
  buildDiscordPendingCookie,
  coachNameAvailable,
  completeDiscordCoachAssociation,
  discordAvatarUrl,
  discordAuthorizeUrl,
  discordCompletionErrorUrl,
  discordOauthConfigFromEnv,
  discordSsoEnabled,
  discordOauthStateMatches,
  discordStartHostGuard,
  fetchDiscordIdentity,
  sessionOwnsCoach,
  shouldBlockExistingRegistration,
  validatedNextPath,
} from "./auth/discordSso.js";

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
  "/api/auth/discord/start",
  "/api/auth/discord/callback",
  "/api/auth/discord/pending",
  "/api/auth/discord/complete",
  "/api/fork/name-available",
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
  // can fetch/preview/build via its config-web seam. rosters/catalog/preview are open reads; build
  // does its own admin-OR-coach-password auth in-handler (see the build route).
  "/api/fork/rosters",
  "/api/fork/team-builder/legal-skills",
  "/api/fork/team-builder/inducements",
  "/api/fork/team-builder/tiers",
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
const discordOauthStates = new DiscordOauthStateStore();
const pendingDiscordSso = new PendingSsoStore();
const TEAM_ADVANCEMENT_TOKEN_SECRET = randomBytes(32).toString("hex");
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
const tournamentMatches = new TournamentMatchStore(FORK_STATE_DIR);

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
 * Reject a team NAME that collides with any already-created team, globally (FUMBBL names
 * are unique fork-wide, not per-coach — see findLibraryTeamByName). `excludeTeamId` lets a
 * resubmission of the SAME team (same teamId) pass through without tripping on its own row.
 */
function duplicateTeamNameError(teamName: string, excludeTeamId?: string): string | undefined {
  const clash = findLibraryTeamByName(LIBRARY_DIR, teamName, excludeTeamId);
  if (!clash) return undefined;
  return `A team named "${teamName.trim()}" already exists — choose another name.`;
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
  /** Existing coach-owned library team to replace. Omitted mints a new team as before. */
  teamId?: string;
  /** Tournament-only predefined inducements. */
  rosteredInducements?: Array<{ key: string; count: number }>;
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
      rosteredInducements: body.rosteredInducements,
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

function tournamentInstructionsGameId(pathname: string): string | undefined {
  const encoded = pathname.match(/^\/api\/fork\/match\/([^/]+)\/instructions$/)?.[1];
  if (!encoded) return undefined;
  try { return decodeURIComponent(encoded); } catch { return undefined; }
}

function authorized(req: IncomingMessage, pathname: string): boolean {
  if (!ADMIN_PASSWORD) return true; // open when no password set (localhost default)
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Dynamic coach-scoped route: bypass legacy Basic auth, then enforce the proven session in-handler.
  if (tournamentInstructionsGameId(pathname)) return true;
  if (pathname.startsWith("/api/packages/")) return true;
  if ((req.method === "GET" || req.method === "HEAD") && teamDetailIdFromPath(pathname)) return true;
  if (req.method === "POST" && advancementPath(pathname)) return true;
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
        pathname === "/discord-complete.html" ||
        pathname === "/discord-complete.js" ||
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
function requestIdentity(req: IncomingMessage): SessionIdentity | undefined {
  const session = sessionFromRequest(req);
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

const readBody = (req: IncomingMessage, maxBytes = DEFAULT_JSON_BODY_CAP): Promise<unknown> =>
  readJsonBody(req, maxBytes);

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
    pathname === "/api/fork/tournament-match" ||
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
    pathname === "/api/fork/library/ingest" ||
    pathname === "/api/fork/library/retire" ||
    pathname === "/api/fork/reload" ||
    pathname === "/api/fork/team-builder/build" ||
    pathname === "/api/bug-reports" ||
    pathname === "/api/admin/identities" ||
    pathname === "/api/account" ||
    /^\/api\/teams\/[^/]+\/advancement$/.test(pathname)
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

function libraryTeamForId(teamId: string): LibraryTeam | undefined {
  try {
    for (const libraryCoach of libraryCoaches(LIBRARY_DIR)) {
      const team = readLibrary(LIBRARY_DIR, libraryCoach).find((entry) => entry?.teamId === teamId);
      if (team) return team;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function ffbCoachIdForDiscordId(discordId: string): string | undefined {
  return Object.values(readIdentities().coaches).find(
    (record) => record.identities?.discordUserId === discordId,
  )?.ffbCoachId;
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams,
  auth?: SessionIdentity,
): Promise<void> {
  const method = req.method ?? "GET";
  const cacheGateCfg = forkConfigFromEnv();
  const gameStartDelivery = [
    "/api/fork/challenge",
    "/api/fork/matchstatus",
    "/api/fork/my-games",
    "/api/fork/schedule",
    "/api/fork/tournament-match",
    "/api/fork/jnlp",
  ].includes(path);
  const gameStartGenerationLock = gameStartDelivery && cacheGateCfg
    ? acquireTeamNameWriteLock(cacheGateCfg.teamsDir)
    : undefined;
  if (gameStartDelivery && cacheGateCfg && !gameStartGenerationLock) {
    return sendJson(res, 409, { error: "A team/cache generation update is in progress; game start delivery is temporarily paused." });
  }
  try {
  const requiresCoherentTeamCache = /^\/api\/teams\/[^/]+\/advancement$/.test(path) || [
    "/api/fork/library/ingest",
    "/api/fork/library/retire",
    "/api/fork/team-builder/build",
    ...(gameStartDelivery ? [path] : []),
  ].includes(path);
  if (requiresCoherentTeamCache && cacheGateCfg && forkCacheReloadRequired(cacheGateCfg.teamsDir)) {
    return sendJson(res, 503, { error: "The fork team cache requires recovery reload; team mutations and game starts are temporarily disabled." });
  }

  if (path === "/api/auth/session" && (method === "GET" || method === "HEAD")) {
    const ssoEnabled = discordSsoEnabled();
    if (!auth) return sendJson(res, 200, { authenticated: false, discordSsoEnabled: ssoEnabled });
    const session = getSession(sessionTokenFromRequest(req));
    return sendJson(res, 200, {
      authenticated: true,
      discordSsoEnabled: ssoEnabled,
      coach: auth.coach,
      organizer: auth.organizer,
      admin: auth.admin,
      ...(session ? { expiresAt: new Date(session.expiry).toISOString() } : {}),
    });
  }

  if (path === "/api/auth/discord/start" && method === "GET") {
    const config = discordOauthConfigFromEnv();
    if (!config) return sendJson(res, 503, { error: "Discord SSO not configured" });
    const hostGuard = discordStartHostGuard(config, req.headers.host, query);
    if (hostGuard.kind === "redirect") {
      res.writeHead(hostGuard.status, { location: hostGuard.location, "cache-control": "no-store" });
      res.end();
      return;
    }
    const state = discordOauthStates.create(validatedNextPath(query.get("next")));
    res.writeHead(302, {
      location: discordAuthorizeUrl(config, state),
      "set-cookie": buildDiscordOauthStateCookie(state, requestUsesTls(req)),
      "cache-control": "no-store",
    });
    res.end();
    return;
  }

  if (path === "/api/auth/discord/callback" && method === "GET") {
    const config = discordOauthConfigFromEnv();
    if (!config) return sendJson(res, 503, { error: "Discord SSO not configured" });
    const secure = requestUsesTls(req);
    const cookies = parseCookies(req.headers.cookie);
    const expectedState = cookies.get(DISCORD_OAUTH_STATE_COOKIE);
    const submittedState = query.get("state");
    const failState = (error: "host-browser-mismatch" | "expired" | "invalid-state") => {
      res.writeHead(302, {
        location: discordCompletionErrorUrl(config, error),
        "set-cookie": buildClearDiscordOauthStateCookie(secure),
        "cache-control": "no-store",
      });
      res.end();
    };
    if (!expectedState) {
      failState(submittedState && discordOauthStates.has(submittedState)
        ? "host-browser-mismatch"
        : "expired");
      return;
    }
    if (!discordOauthStateMatches(expectedState, submittedState)) {
      discordOauthStates.delete(expectedState);
      failState("invalid-state");
      return;
    }
    const next = discordOauthStates.consume(expectedState);
    if (!next) {
      failState("expired");
      return;
    }
    const code = query.get("code");
    if (!code) {
      res.setHeader("set-cookie", buildClearDiscordOauthStateCookie(secure));
      return sendJson(res, 400, { error: "Discord OAuth code is required." });
    }
    try {
      const identity = await fetchDiscordIdentity(config, code);
      const pendingToken = pendingDiscordSso.create({ ...identity, next });
      res.writeHead(302, {
        location: "/discord-complete.html",
        "set-cookie": [
          buildClearDiscordOauthStateCookie(secure),
          buildDiscordPendingCookie(pendingToken, secure),
        ],
        "cache-control": "no-store",
      });
      res.end();
      return;
    } catch (error) {
      res.setHeader("set-cookie", buildClearDiscordOauthStateCookie(secure));
      const message = error instanceof Error ? error.message : "Discord OAuth failed.";
      return sendJson(res, 502, { error: message });
    }
  }

  if (path === "/api/auth/discord/pending" && method === "GET") {
    res.setHeader("cache-control", "no-store");
    if (!discordSsoEnabled()) return sendJson(res, 503, { error: "Discord SSO not configured" });
    const token = parseCookies(req.headers.cookie).get(DISCORD_PENDING_COOKIE);
    const pending = pendingDiscordSso.get(token);
    if (!pending) return sendJson(res, 404, { pending: false });
    return sendJson(res, 200, {
      pending: true,
      discordId: pending.discordId,
      discordUsername: pending.discordUsername,
      avatar: discordAvatarUrl(pending.discordId, pending.discordAvatarHash) ?? null,
      email: pending.email ?? null,
      existingFfbCoachId: ffbCoachIdForDiscordId(pending.discordId) ?? null,
    });
  }

  if (path === "/api/auth/discord/complete" && method === "POST") {
    res.setHeader("cache-control", "no-store");
    if (!discordSsoEnabled()) return sendJson(res, 503, { error: "Discord SSO not configured" });
    const secure = requestUsesTls(req);
    const pendingToken = parseCookies(req.headers.cookie).get(DISCORD_PENDING_COOKIE);
    const pending = pendingDiscordSso.get(pendingToken);
    if (!pending) return sendJson(res, 401, { error: "Discord verification expired or is missing." });

    let rawBody: unknown;
    try {
      rawBody = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON request body." });
    }
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody))
      return sendJson(res, 400, { error: "A JSON object is required." });
    const existingFfbCoachId = ffbCoachIdForDiscordId(pending.discordId);
    const dbCfg = forkDbConfigFromEnv();
    try {
      const result = await completeDiscordCoachAssociation(
        req,
        pending,
        rawBody as Record<string, unknown>,
        existingFfbCoachId,
        {
          fork: dbCfg ? {
            coachExists: (coach) => coachExists(dbCfg, coach),
            verifyCoachDigest: (coach, passwordMd5) => verifyCoachDigest(dbCfg, coach, passwordMd5),
            createForkAccountDigestIfAvailable: (coach, passwordMd5) =>
              createForkAccountDigestIfAvailable(dbCfg, coach, passwordMd5),
          } : undefined,
          identityForCoach: (coach) => readIdentities().coaches[normalizeFfbCoachId(coach)],
          isCoachBanned: isBanned,
          upsertIdentity: (record) => { upsertIdentity(record); },
          createSessionToken: (coach, now) => createSession(coach, now).token,
        },
      );
      for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
      if (result.status !== 200 || !result.sessionToken) {
        return sendJson(res, result.status, result.body);
      }

      pendingDiscordSso.delete(pendingToken);
      res.setHeader("set-cookie", [
        buildClearDiscordPendingCookie(secure),
        buildSessionCookie(result.sessionToken, secure),
      ]);
      return sendJson(res, result.status, result.body);
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
  }

  if (path === "/api/account" && method === "GET") {
    if (!auth) return sendJson(res, 401, { error: "Authentication required." });
    try {
      const record = ownIdentityRecord(auth.coach);
      return sendJson(res, 200, {
        ...record,
        discordAvatarUrl: discordAvatarUrl(
          record.identities.discordUserId ?? "",
          record.identities.discordAvatarHash,
        ),
      });
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
  }

  if (path === "/api/account" && method === "PATCH") {
    if (!auth) return sendJson(res, 401, { error: "Authentication required." });
    let rawBody: unknown;
    try {
      rawBody = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON request body." });
    }
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody))
      return sendJson(res, 400, { error: "A JSON object is required." });
    try {
      return sendJson(res, 200, updateOwnAccount(auth.coach, rawBody));
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
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
    const ffbCoachId = typeof body.ffbCoachId === "string" ? body.ffbCoachId.trim() : "";
    if (!ffbCoachId) return sendJson(res, 400, { error: "ffbCoachId is required." });
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

    const key = normalizeFfbCoachId(ffbCoachId);
    const previous = readIdentities().coaches[key];
    const identities: CoachIdentities = { ...(previous?.identities ?? {}) };
    const identityPatch = (body.identities ?? {}) as Record<string, unknown>;
    for (const field of ["discordUserId", "discordUsername", "email", "nafName", "nafId", "tournamentCoachId"] as const) {
      const value = identityPatch[field];
      if (value === undefined) continue;
      if (typeof value !== "string") return sendJson(res, 400, { error: `identities.${field} must be a string.` });
      identities[field] = value;
    }
    const record: CoachIdentityRecord = {
      ffbCoachId,
      level: (body.level as CoachLevel | undefined) ?? previous?.level ?? "player",
      banned: (body.banned as boolean | undefined) ?? previous?.banned ?? false,
      silenced: (body.silenced as boolean | undefined) ?? previous?.silenced ?? false,
      note: (body.note as string | undefined) ?? previous?.note ?? "",
      profile: previous?.profile ?? {},
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

  const detailTeamId = teamDetailIdFromPath(path);
  if (detailTeamId && method === "GET") {
    const result = teamDetailEndpoint(auth, detailTeamId, {
      libraryDir: LIBRARY_DIR,
      teamsDir: forkConfigFromEnv()?.teamsDir,
      tokenSecret: TEAM_ADVANCEMENT_TOKEN_SECRET,
    });
    return sendJson(res, result.status, result.body);
  }

  const advancementTeamId = advancementPath(path);
  if (advancementTeamId && method === "POST") {
    const cfg = forkConfigFromEnv();
    const body = await readBody(req, MUTATION_JSON_BODY_CAP);
    const result = await teamAdvancementEndpoint(auth, advancementTeamId, body, {
      libraryDir: LIBRARY_DIR,
      teamsDir: cfg?.teamsDir,
      tokenSecret: TEAM_ADVANCEMENT_TOKEN_SECRET,
      reload: cfg ? () => reloadFork(cfg, FORK_STATE_DIR) : undefined,
      isTeamActive: forkAdminCfg ? async (teamId) => {
        const live = await adminListLive(forkAdminCfg);
        return live.some((game) => game.homeTeamId === teamId || game.awayTeamId === teamId);
      } : undefined,
    });
    return sendJson(res, result.status, result.body);
  }

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
    const sessionCoach = auth?.coach;
    if (!jnlpDigest && sessionOwnsCoach(sessionCoach, coach)) {
      const dbCfg = forkDbConfigFromEnv();
      if (!dbCfg) return sendJson(res, 503, { error: "Fork DB not configured on this host (set FORK_DB_HOST)." });
      try {
        jnlpDigest = await forkCoachPasswordDigest(dbCfg, sessionCoach!);
      } catch (error) {
        return sendJson(res, 400, { error: (error as Error).message });
      }
      if (!jnlpDigest) return sendJson(res, 404, { error: "Fork coach account not found." });
    }
    const jnlp = buildForkJnlp({ coach, teamId, gameName, passwordMd5: jnlpDigest });
    res.writeHead(200, {
      "content-type": "application/x-java-jnlp-file; charset=utf-8",
      "content-disposition": `attachment; filename="${jnlpFilename(gameName, coach)}"`,
      "cache-control": "no-store",
    });
    res.end(jnlp);
    return;
  }

  if (path === "/api/fork/name-available" && method === "GET") {
    const coach = query.get("coach")?.trim();
    if (!coach) return sendJson(res, 400, { error: "coach is required." });
    if (coach.length > 40) return sendJson(res, 400, { error: "coach must be at most 40 characters." });
    const cfg = forkDbConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork DB not configured on this host (set FORK_DB_HOST)." });
    try {
      return sendJson(res, 200, {
        available: await coachNameAvailable(coach, (name) => coachExists(cfg, name)),
      });
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
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
      const exists = await coachExists(cfg, coach);
      const requesterCoach = auth?.coach ?? getSession(sessionTokenFromRequest(req))?.coach;
      if (shouldBlockExistingRegistration({
        exists,
        requestedCoach: coach,
        sessionCoach: requesterCoach,
        adminAuthed: isAdminAuthed(req) || isTokenAuthed(req) || auth?.admin === true,
      })) {
        return sendJson(res, 403, {
          error: "That account already exists — sign in or use Discord to reset its password.",
        });
      }
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
    return sendJson(res, 405, { error: "Retirement is a state-changing POST operation." });
  }
  if (path === "/api/fork/library/retire" && method === "POST") {
    const adminAuthed = isAdminAuthed(req) || isTokenAuthed(req);
    if (!auth && !adminAuthed) return sendJson(res, 401, { error: "Authentication required." });
    const body = await readBody(req, MUTATION_JSON_BODY_CAP);
    if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "A JSON object is required." });
    const fields = Object.keys(body as Record<string, unknown>);
    if (fields.some((field) => field !== "teamId" && field !== "coach")) return sendJson(res, 400, { error: "Retire has unexpected fields." });
    const bodyCoach = typeof (body as Record<string, unknown>).coach === "string" ? (body as { coach: string }).coach.trim() : undefined;
    const teamId = typeof (body as Record<string, unknown>).teamId === "string" ? (body as { teamId: string }).teamId.trim() : undefined;
    if (!teamId) return sendJson(res, 400, { error: "teamId is required." });
    let coach: string;
    if (auth) {
      coach = auth.coach;
    } else if (adminAuthed) {
      if (!bodyCoach) return sendJson(res, 400, { error: "coach is required." });
      coach = bodyCoach;
    } else {
      return sendJson(res, 401, { error: "Authentication required." });
    }
    const retireCfg = forkConfigFromEnv();
    if (!retireCfg) return sendJson(res, 503, { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." });
    const retirementGenerationLock = acquireTeamNameWriteLock(retireCfg.teamsDir);
    if (!retirementGenerationLock) return sendJson(res, 409, { error: "Another team/cache generation update is in progress." });
    const retirementLock = acquireTeamWriteLock(retireCfg.teamsDir, teamId);
    if (!retirementLock) {
      retirementGenerationLock.release();
      return sendJson(res, 409, { error: "Another update is already in progress for this team." });
    }
    try {
      const team = readLibrary(LIBRARY_DIR, coach).find((t) => t.teamId === teamId);
      if (!team) return sendJson(res, 404, { error: `Team ${teamId} isn't in ${coach}'s library.` });
      if (team.retired) return sendJson(res, 200, { ok: true, team }); // idempotent
      if (!forkAdminCfg) return sendJson(res, 503, { error: "Team activity cannot be verified on this host; retirement is unavailable." });
      try {
        const live = await adminListLive(forkAdminCfg);
        if (live.some((g) => g.homeTeamId === teamId || g.awayTeamId === teamId)) {
          return sendJson(res, 409, { error: `"${team.teamName}" has a game in progress and can't be retired yet.` });
        }
      } catch {
        return sendJson(res, 503, { error: "Team activity cannot be verified right now; retirement is unavailable." });
      }
      const retired = retireLibraryTeam(LIBRARY_DIR, coach, teamId);
      if (!retired) return sendJson(res, 404, { error: `Team ${teamId} isn't in ${coach}'s library.` });
      return sendJson(res, 200, { ok: true, team: retired });
    } finally {
      retirementLock.release();
      retirementGenerationLock.release();
    }
  }

  // Ingest a FUMBBL team (id or /t/<id> URL) into a coach's library: fetch → re-coach →
  // save team + roster XML into the fork's dirs → upsert the LibraryTeam row → attempt an
  // automatic fork reload so the ingest is actually joinable without a manual restart
  // (closes the ingest→challenge race — see @bb/fork-ops's forkReload / R3). Needs FORK_TEAMS_DIR.
  if (path === "/api/fork/library/ingest" && method === "POST") {
    const adminAuthed = isAdminAuthed(req) || isTokenAuthed(req);
    // Do not buffer an unauthenticated public request before rejecting it.
    if (!auth && !adminAuthed) return sendJson(res, 401, { error: "Authentication required." });
    const body = await readBody(req, MUTATION_JSON_BODY_CAP);
    const ingest = parseLibraryIngestRequest(body, auth, adminAuthed);
    if (!ingest.ok) return sendJson(res, ingest.status, { error: ingest.error });
    const { coach, team, allowRecovery } = ingest;
    const cfg = forkConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." });
    try {
      // Peek the FUMBBL team's name/id BEFORE persisting anything, so a name collision with an
      // already-created team is declined instead of silently landing two same-named teams in the
      // library (FUMBBL names are globally unique; excludeTeamId lets a re-ingest of the SAME
      // team — ownership move / refresh — pass through without tripping on its own row).
      const peek = await fetchForkTeam(team);
      const ownershipError = libraryIngestOwnershipError(ingest, peek.coach);
      if (ownershipError) return sendJson(res, 403, { error: ownershipError });
      const nameLock = acquireTeamNameWriteLock(cfg.teamsDir);
      if (!nameLock) return sendJson(res, 409, { error: "Another team name update is already in progress." });
      try {
        const dupError = duplicateTeamNameError(peek.teamName, peek.teamId);
        if (dupError) return sendJson(res, 409, { error: dupError });
        const result = await ingestForkTeam(cfg, LIBRARY_DIR, coach, team, FORK_STATE_DIR, {
          allowReplaceProgressed: allowRecovery,
          fetchedTeam: peek,
          teamNameLockHeld: true,
          isTeamActive: forkAdminCfg ? async (teamId) => {
            const live = await adminListLive(forkAdminCfg);
            return live.some((game) => game.homeTeamId === teamId || game.awayTeamId === teamId);
          } : undefined,
          reload: () => reloadFork(cfg, FORK_STATE_DIR),
        });
        return sendJson(res, 200, { ok: true, ...result });
      } finally {
        nameLock.release();
      }
    } catch (e) {
      const error = (e as Error).message;
      const status = /activity cannot be verified/i.test(error)
        ? 503
        : /another update|progression or match history|game in progress|game started during/i.test(error)
          ? 409
          : 400;
      return sendJson(res, status, { error });
    }
  }

  // Manually trigger a fork (game server) reload — e.g. after a batch of ingests, or to
  // retry a reload that was skipped because the fork looked busy. No-ops safely (returns
  // {reloaded:false,reason}) rather than force-killing a live game.
  if (path === "/api/fork/reload" && method === "GET") {
    return sendJson(res, 405, { error: "Fork reload requires authenticated POST." });
  }
  if (path === "/api/fork/reload" && method === "POST") {
    if (auth?.organizer !== true && !isAdminAuthed(req) && !isTokenAuthed(req)) {
      return sendJson(res, auth ? 403 : 401, { error: auth ? "Organizer access required." : "Authentication required." });
    }
    const cfg = forkConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." });
    const generationLock = acquireTeamNameWriteLock(cfg.teamsDir);
    if (!generationLock) return sendJson(res, 409, { error: "Another team/cache generation update is in progress." });
    try {
      const recovery = recoverTeamFileTransactions(cfg.teamsDir);
      if (recovery.errors.length) return sendJson(res, 503, { error: `Team transaction recovery failed closed: ${recovery.errors.join("; ")}` });
      const reload = await reloadFork(cfg, FORK_STATE_DIR);
      if (reload.reloaded) {
        acknowledgeRecoveredTeamTransactions(recovery.receipts);
        acknowledgeForkCacheReload(cfg.teamsDir);
        const deferred = await replayDeferredGameResults(
          { teamsDir: cfg.teamsDir, resultsDir: join(dirname(cfg.teamsDir), "results"), libraryDir: LIBRARY_DIR },
          async () => {
            const replayReload = await reloadFork(cfg, FORK_STATE_DIR);
            if (replayReload.reloaded) acknowledgeForkCacheReload(cfg.teamsDir);
            return replayReload.reloaded;
          },
          true,
        );
        if (deferred.errors.length) {
          return sendJson(res, 503, { error: `Fork reloaded, but deferred result recovery failed closed: ${deferred.errors.join("; ")}` });
        }
        return sendJson(res, 200, { ...reload, replayedResults: deferred.replayed });
      }
      return sendJson(res, 200, reload);
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    } finally {
      generationLock.release();
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

  if (path === "/api/fork/tournament-match" && method === "POST") {
    if (!requireAdminGate(res, auth)) return;
    if (!forkAdminCfg) return sendJson(res, 503, { error: "Fork admin API not configured on this host (set FORK_ADMIN_PASSWORD)." });
    const cfg = forkConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." });
    const raw = await readBody(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return sendJson(res, 400, { error: "A JSON object is required." });
    const body = raw as { homeTeamId?: unknown; awayTeamId?: unknown; packageName?: unknown };
    const homeTeamId = typeof body.homeTeamId === "string" ? body.homeTeamId.trim() : "";
    const awayTeamId = typeof body.awayTeamId === "string" ? body.awayTeamId.trim() : "";
    if (!homeTeamId || !awayTeamId)
      return sendJson(res, 400, { error: "homeTeamId and awayTeamId are required." });
    if (homeTeamId === awayTeamId)
      return sendJson(res, 400, { error: "homeTeamId and awayTeamId must identify different teams." });
    if (body.packageName !== undefined && typeof body.packageName !== "string")
      return sendJson(res, 400, { error: "packageName must be a string when supplied." });

    const homeTeam = libraryTeamForId(homeTeamId);
    const awayTeam = libraryTeamForId(awayTeamId);
    if (!homeTeam) return sendJson(res, 404, { error: `Team ${homeTeamId} was not found in the library.`, side: "home" });
    if (!awayTeam) return sendJson(res, 404, { error: `Team ${awayTeamId} was not found in the library.`, side: "away" });
    for (const [side, team] of [["home", homeTeam], ["away", awayTeam]] as const) {
      if (isBanned(team.coach))
        return sendJson(res, 403, { error: BANNED_ACCOUNT_MESSAGE, side, coach: team.coach });
    }

    const homeFile = storedTeamFile(cfg.teamsDir, homeTeamId);
    const awayFile = storedTeamFile(cfg.teamsDir, awayTeamId);
    if (!homeFile) return sendJson(res, 404, { error: `Stored XML for team ${homeTeamId} was not found.`, side: "home" });
    if (!awayFile) return sendJson(res, 404, { error: `Stored XML for team ${awayTeamId} was not found.`, side: "away" });
    if (!coachNamesEqual(storedTeamCoach(homeFile.xml) ?? "", homeTeam.coach))
      return sendJson(res, 409, { error: `Stored XML ownership for team ${homeTeamId} does not match its library row.` });
    if (!coachNamesEqual(storedTeamCoach(awayFile.xml) ?? "", awayTeam.coach))
      return sendJson(res, 409, { error: `Stored XML ownership for team ${awayTeamId} does not match its library row.` });

    let homeInstructions;
    let awayInstructions;
    let teamsToRefresh;
    try {
      homeInstructions = buildInstructions(homeTeam, teamSpecialRulesFromXml(homeFile.xml));
      awayInstructions = buildInstructions(awayTeam, teamSpecialRulesFromXml(awayFile.xml));
      teamsToRefresh = [
        { team: homeTeam, file: homeFile, xml: ensureTournamentInducementSetXml(homeTeam, homeFile.xml) },
        { team: awayTeam, file: awayFile, xml: ensureTournamentInducementSetXml(awayTeam, awayFile.xml) },
      ]
        .filter((entry) => entry.xml !== entry.file.xml)
        .sort((left, right) => left.team.teamId.localeCompare(right.team.teamId));
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }

    const locks = [] as NonNullable<ReturnType<typeof acquireTeamWriteLock>>[];
    const transactions = [] as ReturnType<typeof beginTeamXmlTransaction>[];
    let scheduledGameId: string | undefined;
    try {
      for (const entry of teamsToRefresh) {
        const lock = acquireTeamWriteLock(cfg.teamsDir, entry.team.teamId);
        if (!lock) throw new Error(`Another update is already in progress for team ${entry.team.teamId}.`);
        locks.push(lock);
      }
      for (const entry of teamsToRefresh) {
        const transaction = beginTeamXmlTransaction({
          teamsDir: cfg.teamsDir,
          teamId: entry.team.teamId,
          targetPath: entry.file.path,
          teamXml: entry.xml,
        });
        transactions.push(transaction);
        atomicWriteTextFile(entry.file.path, entry.xml);
      }
      const reload = await reloadFork(cfg, FORK_STATE_DIR);
      if (!reload.reloaded) throw new Error(reload.reason ?? "Fork reload did not complete.");
      const scheduled = await scheduleForkGame(forkAdminCfg, homeTeamId, awayTeamId, { overtime: overtimeEnabled });
      scheduledGameId = scheduled.gameId;
      for (const transaction of transactions) commitTeamXmlTransaction(transaction, true);

      const packageName = typeof body.packageName === "string" ? body.packageName.trim() : "";
      const metadata: TournamentMatchMetadata = {
        gameId: scheduled.gameId,
        ...(packageName ? { packageName } : {}),
        home: { ffbCoachId: homeTeam.coach, teamId: homeTeam.teamId, instructions: homeInstructions },
        away: { ffbCoachId: awayTeam.coach, teamId: awayTeam.teamId, instructions: awayInstructions },
        createdAt: new Date().toISOString(),
      };
      tournamentMatches.put(metadata);
      return sendJson(res, 200, {
        gameId: scheduled.gameId,
        home: { coach: homeTeam.coach, treasury: homeInstructions.treasury },
        away: { coach: awayTeam.coach, treasury: awayInstructions.treasury },
      });
    } catch (error) {
      if (!scheduledGameId && transactions.length) {
        for (const transaction of [...transactions].reverse()) restoreTeamXmlTransaction(transaction);
        try {
          const restored = await reloadFork(cfg, FORK_STATE_DIR);
          if (!restored.reloaded) throw new Error(restored.reason ?? "restored generation reload refused");
          for (const transaction of transactions) acknowledgeRestoredTeamXmlTransaction(transaction);
        } catch (reloadError) {
          markForkCacheReloadRequired(cfg.teamsDir, `Tournament match rollback could not be loaded: ${(reloadError as Error).message}`);
          return sendJson(res, 503, { error: `${(error as Error).message}; restored generation awaits recovery reload: ${(reloadError as Error).message}` });
        }
      }
      return sendJson(res, scheduledGameId ? 500 : 400, {
        error: scheduledGameId
          ? `Game ${scheduledGameId} was scheduled, but its tournament metadata could not be persisted: ${(error as Error).message}`
          : (error as Error).message,
        ...(scheduledGameId ? { gameId: scheduledGameId } : {}),
      });
    } finally {
      for (const lock of locks.reverse()) lock.release();
    }
  }

  const tournamentGameId = tournamentInstructionsGameId(path);
  if (tournamentGameId && method === "GET") {
    if (!auth) return sendJson(res, 401, { error: "Authentication required." });
    const match = tournamentMatches.get(tournamentGameId);
    if (!match) return sendJson(res, 404, { error: "Tournament match not found." });
    try {
      return sendJson(res, 200, instructionsForSession(match, auth, query.get("side")));
    } catch (error) {
      if (error instanceof TournamentMatchAccessError)
        return sendJson(res, error.status, { error: error.message });
      throw error;
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
      .map((xml) => rosterOptionsIntrinsic(xml, bb2025))
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

  if (path === "/api/fork/team-builder/inducements" && method === "GET") {
    const packageName = query.get("packageName")?.trim() || undefined;
    const resolvedPkg = resolveBuilderPackage(packages, TEAM_BUILDER_BASELINE, packageName);
    if ("error" in resolvedPkg) return sendJson(res, 400, { error: resolvedPkg.error });
    return sendJson(res, 200, { inducements: teamBuilderInducementCatalog(resolvedPkg.pkg, bb2025) });
  }

  if (path === "/api/fork/team-builder/tiers" && method === "GET") {
    const packageName = query.get("packageName")?.trim() || undefined;
    const resolvedPkg = resolveBuilderPackage(packages, TEAM_BUILDER_BASELINE, packageName);
    if ("error" in resolvedPkg) return sendJson(res, 400, { error: resolvedPkg.error });
    return sendJson(res, 200, { races: teamBuilderTierCatalog(resolvedPkg.pkg, bb2025) });
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
    const adminAuthed = isAdminAuthed(req) || isTokenAuthed(req);
    const editingError = teamEditingError({ teamId: body.teamId, organizer: auth?.organizer === true, adminAuthed });
    if (editingError) return sendJson(res, 403, { error: editingError });
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
    const target = resolveTeamBuilderBuildTarget(LIBRARY_DIR, cfg.teamsDir, body.coach?.trim() ?? "", body.teamId);
    if (!target.ok) return sendJson(res, target.status, { error: target.error });
    mkdirSync(cfg.teamsDir, { recursive: true });
    const nameLock = acquireTeamNameWriteLock(cfg.teamsDir);
    if (!nameLock) return sendJson(res, 409, { error: "Another team name update is already in progress." });
    let teamLock = target.teamId ? acquireTeamWriteLock(cfg.teamsDir, target.teamId) : undefined;
    if (target.teamId && !teamLock) {
      nameLock.release();
      return sendJson(res, 409, { error: "Another update is already in progress for this team." });
    }
    const targetIsActive = async (): Promise<boolean> => {
      if (!target.teamId) return false;
      if (!forkAdminCfg) throw new Error("Team activity cannot be verified on this host; editing is unavailable.");
      try {
        const live = await adminListLive(forkAdminCfg);
        return live.some((game) => game.homeTeamId === target.teamId || game.awayTeamId === target.teamId);
      } catch (error) {
        if (/activity cannot be verified/i.test((error as Error).message)) throw error;
        throw new Error("Team activity cannot be verified right now; editing is unavailable.");
      }
    };
    try {
      // Replacement writers share the team lock and fail closed unless the authoritative live-game
      // source confirms the team is inactive. New teams have no possible active-game identity yet.
      if (target.teamId) {
        try {
          if (await targetIsActive()) {
            return sendJson(res, 409, { error: "This team has a game in progress and cannot be edited." });
          }
        } catch {
          return sendJson(res, 503, { error: "Team activity cannot be verified right now; editing is unavailable." });
        }
      }
      // Secret League path (#52 A): off-dataset → compose + enforce roster-intrinsic legality here
      // (the dataset `validate()` can't run for a race the dataset doesn't carry). Same write+reload.
      if (body.rosterId && isSlRosterId(body.rosterId)) {
        const composed = retargetComposedTeam(composeIntrinsicFromBody(cfg.teamsDir, body), target.teamId);
        if (!composed.legal) {
          return sendJson(res, 400, {
            error: "Team is not legal — fix the findings and rebuild.",
            errors: composed.issues.map((i) => i.message),
            summary: composed.roster.summary,
          });
        }
        const dupError = duplicateTeamNameError(composed.roster.teamName, composed.teamId);
        if (dupError) return sendJson(res, 409, { error: dupError });
        const coachTag = composed.roster.coach.replace(/[^\w.-]+/g, "_") || "coach";
        const newFile = join(cfg.teamsDir, `team_${coachTag}_${composed.teamId}.xml`);
        teamLock ??= acquireTeamWriteLock(cfg.teamsDir, composed.teamId);
        if (!teamLock) return sendJson(res, 409, { error: "Another update is already in progress for this team." });
        const commitTarget = resolveTeamBuilderBuildTarget(LIBRARY_DIR, cfg.teamsDir, composed.roster.coach, target.teamId);
        if (!commitTarget.ok) return sendJson(res, commitTarget.status, { error: commitTarget.error });
        const file = commitTarget.path ?? newFile;
        const ingestedAt = new Date().toISOString();
        const transaction = beginTeamXmlTransaction({
          teamsDir: cfg.teamsDir,
          teamId: composed.teamId,
          targetPath: file,
          teamXml: composed.xml,
          library: {
            baseDir: LIBRARY_DIR,
            coach: composed.roster.coach,
            team: builtLibraryTeam(composed.roster, composed.teamId, composed.roster.summary!.total, ingestedAt, false),
          },
        });
        try {
          atomicWriteTextFile(file, composed.xml);
          if (await targetIsActive()) throw new Error("A game started during the team edit; the replacement was rolled back.");
          const reload = await reloadFork(cfg, FORK_STATE_DIR);
          registerBuiltTeam(LIBRARY_DIR, composed.roster, composed.teamId, composed.roster.summary!.total, ingestedAt, reload.reloaded);
          updateTeamXmlTransactionLibraryTeam(
            transaction,
            builtLibraryTeam(composed.roster, composed.teamId, composed.roster.summary!.total, ingestedAt, reload.reloaded),
          );
          commitTeamXmlTransaction(transaction, reload.reloaded);
          return sendJson(res, 200, { ok: true, teamId: composed.teamId, path: file, reload, summary: composed.roster.summary, intrinsic: true });
        } catch (error) {
          restoreTeamXmlTransaction(transaction);
          try {
            const restored = await reloadFork(cfg, FORK_STATE_DIR);
            if (!restored.reloaded) throw new Error(restored.reason ?? "restored generation reload refused");
            acknowledgeRestoredTeamXmlTransaction(transaction);
          } catch (reloadError) {
            markForkCacheReloadRequired(cfg.teamsDir, `Team Builder rollback could not be loaded: ${(reloadError as Error).message}`);
            throw new Error(`${(error as Error).message}; restored generation awaits recovery reload: ${(reloadError as Error).message}`);
          }
          throw error;
        }
      }
      const composed = retargetComposedTeam(composeFromBody(cfg.teamsDir, body), target.teamId);
      const result = validate(composed.roster, resolvedPkg.pkg, bb2025);
      const packageInfo = packageResponseInfo(resolvedPkg, composed.roster.rosterName);
      // Custom UAT mode (owner 08-04): apply the choice, no validation gate — never reject.
      if (!body.custom && !result.valid) {
        return sendJson(res, 400, { error: "Team is not legal — fix the findings and rebuild.", errors: result.errors, summary: result.recomputedSummary, ...(packageInfo ? { package: packageInfo } : {}) });
      }
      const dupError = duplicateTeamNameError(composed.roster.teamName, composed.teamId);
      if (dupError) return sendJson(res, 409, { error: dupError });
      const coachTag = composed.roster.coach.replace(/[^\w.-]+/g, "_") || "coach";
      const newFile = join(cfg.teamsDir, `team_${coachTag}_${composed.teamId}.xml`);
      teamLock ??= acquireTeamWriteLock(cfg.teamsDir, composed.teamId);
      if (!teamLock) return sendJson(res, 409, { error: "Another update is already in progress for this team." });
      const commitTarget = resolveTeamBuilderBuildTarget(LIBRARY_DIR, cfg.teamsDir, composed.roster.coach, target.teamId);
      if (!commitTarget.ok) return sendJson(res, commitTarget.status, { error: commitTarget.error });
      const file = commitTarget.path ?? newFile;
      const ingestedAt = new Date().toISOString();
      const transaction = beginTeamXmlTransaction({
        teamsDir: cfg.teamsDir,
        teamId: composed.teamId,
        targetPath: file,
        teamXml: composed.xml,
        library: {
          baseDir: LIBRARY_DIR,
          coach: composed.roster.coach,
          team: builtLibraryTeam(
            composed.roster, composed.teamId, result.recomputedSummary.goldUsed, ingestedAt, false, resolvedPkg.selected?.name,
          ),
        },
      });
      try {
        atomicWriteTextFile(file, composed.xml);
        if (await targetIsActive()) throw new Error("A game started during the team edit; the replacement was rolled back.");
        const reload = await reloadFork(cfg, FORK_STATE_DIR);
        // goldUsed = the validator's RECOMPUTED total (validate() ran on this path — prefer it over the
        // composer's own figure). The SL branch uses the composed summary, its strongest available number.
        registerBuiltTeam(
          LIBRARY_DIR,
          composed.roster,
          composed.teamId,
          result.recomputedSummary.goldUsed,
          ingestedAt,
          reload.reloaded,
          resolvedPkg.selected?.name,
        );
        updateTeamXmlTransactionLibraryTeam(
          transaction,
          builtLibraryTeam(
            composed.roster, composed.teamId, result.recomputedSummary.goldUsed, ingestedAt, reload.reloaded, resolvedPkg.selected?.name,
          ),
        );
        commitTeamXmlTransaction(transaction, reload.reloaded);
        return sendJson(res, 200, { ok: true, teamId: composed.teamId, path: file, reload, summary: result.recomputedSummary, ...(packageInfo ? { package: packageInfo } : {}) });
      } catch (error) {
        restoreTeamXmlTransaction(transaction);
        try {
          const restored = await reloadFork(cfg, FORK_STATE_DIR);
          if (!restored.reloaded) throw new Error(restored.reason ?? "restored generation reload refused");
          acknowledgeRestoredTeamXmlTransaction(transaction);
        } catch (reloadError) {
          markForkCacheReloadRequired(cfg.teamsDir, `Team Builder rollback could not be loaded: ${(reloadError as Error).message}`);
          throw new Error(`${(error as Error).message}; restored generation awaits recovery reload: ${(reloadError as Error).message}`);
        }
        throw error;
      }
    } catch (e) {
      const error = (e as Error).message;
      const status = /activity cannot be verified/i.test(error) ? 503 : /game started during/i.test(error) ? 409 : 400;
      return sendJson(res, status, { error });
    } finally {
      teamLock?.release();
      nameLock.release();
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
  } finally {
    gameStartGenerationLock?.release();
  }
}

// Dialect-1 `xml:` site-backend (spec-team-portal §3). Flag-gated (SITE_BACKEND_ENABLED) + additive:
// undefined unless the flag is set AND fork teams-dir + DB are configured, in which case it claims only
// the NEW `/xml:*` + fumbbl-client `/api/{clientoptions,name}` paths. Nothing config-web serves today
// hits those, so an un-flagged deploy is byte-behaviour-identical (strand-proof).
// Reconcile team/roster/library generations before banking recovery inspects any team file.
// Journals are acknowledged only after the fork confirms the reconciled generation is loaded.
const startupForkCfg = forkConfigFromEnv();
if (startupForkCfg) {
  const generationLock = acquireTeamNameWriteLock(startupForkCfg.teamsDir);
  if (!generationLock) throw new Error("Team transaction recovery could not acquire the global cache-generation lock.");
  try {
    const recovery = recoverTeamFileTransactions(startupForkCfg.teamsDir);
    if (recovery.errors.length) {
      throw new Error(`Team transaction recovery failed closed: ${recovery.errors.join("; ")}`);
    }
    if (recovery.recovered.length || forkCacheReloadRequired(startupForkCfg.teamsDir)) {
      const reload = await reloadFork(startupForkCfg, FORK_STATE_DIR);
      if (!reload.reloaded) {
        throw new Error(`Recovered team transactions could not be loaded by the fork: ${reload.reason ?? "reload refused"}`);
      }
      acknowledgeRecoveredTeamTransactions(recovery.receipts);
      acknowledgeForkCacheReload(startupForkCfg.teamsDir);
      console.log(`[team-recovery] reconciled ${recovery.recovered.join(", ")} and reloaded the fork.`);
    }
  } finally {
    generationLock.release();
  }
}

const siteBackend = await createSiteBackend(LIBRARY_DIR, async () => {
  const cfg = forkConfigFromEnv();
  if (!cfg) return false;
  const generationLock = acquireTeamNameWriteLock(cfg.teamsDir);
  if (!generationLock) return false;
  try {
    const reload = await reloadFork(cfg, FORK_STATE_DIR);
    if (reload.reloaded) acknowledgeForkCacheReload(cfg.teamsDir);
    return reload.reloaded;
  } finally {
    generationLock.release();
  }
});

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
        res.setHeader("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
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
            discordSsoEnabled: discordSsoEnabled(),
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
        const auth = requestIdentity(req);
        const accountSession = auth !== undefined && (
          url.pathname === "/api/account" || tournamentInstructionsGameId(url.pathname) !== undefined
        );
        if (!authorized(req, url.pathname) && !accountSession) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="BB Config"' }).end("auth required");
          return;
        }
        const method = req.method ?? "GET";
        if (
          accountSession &&
          !bearerTokenFromRequest(req) &&
          isStateChangingApiWrite(method, url.pathname) &&
          req.headers["x-cw-auth"] !== "1"
        ) {
          return sendJson(res, 403, { error: "Missing required X-CW-Auth header." });
        }
        if (url.pathname.startsWith("/api/"))
          return await handleApi(req, res, url.pathname, url.searchParams, auth);
      }
      // Sidecar-OFF path (the live host: ADMIN_PASSWORD mode). The coach session store is NOT
      // sidecar-gated — the owner's ruling has to land where the testers actually are — so resolve a
      // Bearer identity here too. It only ever ADDS proven identity: routes that consult `auth`
      // (my-games, team-builder/build) previously required a password param instead, and
      // requireAdminGate ignores `auth` entirely unless AUTH_SIDECAR is on, so no admin surface widens.
      await serveStatic(res, url.pathname);
    } catch (e) {
      if (e instanceof JsonBodyError) return sendJson(res, e.status, { error: e.message });
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
