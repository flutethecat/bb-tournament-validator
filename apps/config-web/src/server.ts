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
  forkAdminConfigFromEnv,
  forkConfigFromEnv,
  forkDbConfigFromEnv,
  HOME_AWAY_MODES,
  type HomeAwayMode,
  ingestForkTeam,
  isLoadedOnFork,
  jnlpFilename,
  listForkCoaches,
  Matchmaker,
  listCoachGames,
  queryCoaches,
  readLibrary,
  reloadFork,
  scheduleForkGame,
  upsertLibraryTeam,
  verifyCoachPassword,
} from "@bb/fork-ops";
import { PackageFiles, readCoachRegistry, readCoaches, skillCatalog, starList, teamList } from "./data";
import { PRESETS } from "./presets";
import { attachSuper } from "./super/index.js";
import { createSiteBackend } from "./site-backend/index.js";

/**
 * Endpoints reachable without ADMIN_PASSWORD even when it's set, AND always sent
 * with CORS (access-control-allow-origin: *) on every response — success or error.
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
]);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(HERE, "../public");
const PORT = Number(process.env.PORT ?? 4310);
const HOST = process.env.HOST ?? "127.0.0.1";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
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
  verifyChallenger: challengeDbCfg
    ? (coach, password) => verifyCoachPassword(challengeDbCfg, coach, password)
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
  /** Secret League path only: the TO-configured TV budget cap in gold (the fixed 1000k baseline
   *  can't fit SL TVs). Omitted ⇒ no budget check (the TO gates the cap out-of-band). */
  budget?: number;
  /** V2 coach-auth on the build path — the caller's fork-join password (not used by compose). */
  password?: string;
  /** Custom UAT mode (owner 08-04): apply ANY chosen skill/trait to a base roster with NO legality
   *  or budget validation — preview/build never reject. Gating comes later. */
  custom?: boolean;
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
  // rules-builder paths + shared /assets/ — every other admin page (index/users/
  // tournaments) stays Basic-gated; writes remain token/Basic-gated in-handler.
  {
    const method = req.method ?? "GET";
    if (
      (method === "GET" || method === "HEAD") &&
      (pathname === "/tournament-rules.html" ||
        pathname === "/tournament-rules.css" ||
        pathname === "/tournament-rules.js" ||
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
function requireAdminGate(res: ServerResponse): boolean {
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

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
  const method = req.method ?? "GET";

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
    if (ADMIN_PASSWORD && !isAdminAuthed(req) && !isTokenAuthed(req)) return sendJson(res, 401, { error: "Saving a package requires login (bearer token) or admin auth." });
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
    return sendJson(res, 200, { pkg: found.pkg, problems: found.problems });
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

  // FUMBBL40k client's one-click Launch: fetch a fork-join JNLP directly (no Discord
  // round-trip). Machine-to-machine — see PUBLIC_PATHS for why this bypasses auth
  // (CORS is set centrally in the server handler, covering this route's errors too).
  if (path === "/api/fork/jnlp" && method === "GET") {
    const coach = query.get("coach")?.trim();
    const teamId = query.get("teamId")?.trim();
    const gameName = query.get("gameName")?.trim();
    const password = query.get("password")?.trim() || undefined;
    if (!coach || !teamId || !gameName)
      return sendJson(res, 400, { error: "coach, teamId and gameName are required." });
    const jnlp = buildForkJnlp({ coach, teamId, gameName, password });
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
    const password = query.get("password")?.trim() || undefined;
    if (!coach) return sendJson(res, 400, { error: "coach is required." });
    const cfg = forkDbConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork DB not configured on this host (set FORK_DB_HOST)." });
    try {
      await createForkAccount(cfg, coach, password);
      return sendJson(res, 200, { ok: true, coach });
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  // List a coach's fork team library.
  if (path === "/api/fork/library" && method === "GET") {
    const coach = query.get("coach")?.trim();
    if (!coach) return sendJson(res, 400, { error: "coach is required." });
    return sendJson(res, 200, { teams: readLibrary(LIBRARY_DIR, coach) });
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

  // Enter matchmaking: record my pending challenge. Instant reciprocal matches are
  // delivered via the next matchstatus poll (both sides), so this always returns waiting.
  // Gated on the team being roster-loadable on the CURRENTLY RUNNING fork (re-derived fresh,
  // not trusting a possibly-stale library flag) — refusing here is what prevents the silent
  // join-timeout: a team whose roster isn't loaded yet must never be allowed into a challenge.
  if (path === "/api/fork/challenge" && method === "GET") {
    const coach = query.get("coach")?.trim();
    const teamId = query.get("teamId")?.trim();
    const opponent = query.get("opponent")?.trim();
    const password = query.get("password")?.trim() || undefined;
    if (!coach || !teamId || !opponent)
      return sendJson(res, 400, { error: "coach, teamId and opponent are required." });
    const team = readLibrary(LIBRARY_DIR, coach).find((t) => t.teamId === teamId);
    if (!team) return sendJson(res, 400, { error: `Team ${teamId} isn't in ${coach}'s library.` });
    if (!isLoadedOnFork(FORK_STATE_DIR, team.ingestedAt)) {
      return sendJson(res, 409, {
        error: `"${team.teamName}" isn't loaded on the fork yet — it needs a reload after being ingested. Try again shortly, or ask an admin to run a reload.`,
      });
    }
    try {
      return sendJson(res, 200, await matchmaker.challenge({ coach, teamId, opponent, password }));
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
    if (!requireAdminGate(res)) return;
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
    if (!requireAdminGate(res)) return;
    if (!forkAdminCfg) return sendJson(res, 503, { error: "Fork admin API not configured on this host (set FORK_ADMIN_PASSWORD)." });
    const body = (await readBody(req)) as { homeTeamId?: string; awayTeamId?: string };
    if (!body.homeTeamId || !body.awayTeamId)
      return sendJson(res, 400, { error: "homeTeamId and awayTeamId are required." });
    try {
      return sendJson(res, 200, await scheduleForkGame(forkAdminCfg, body.homeTeamId, body.awayTeamId, { overtime: overtimeEnabled }));
    } catch (e) {
      return sendJson(res, 400, { error: (e as Error).message });
    }
  }

  const gameMatch = path.match(/^\/api\/fork\/game\/([^/]+)\/(close|delete|concede)$/);
  if (gameMatch && method === "POST") {
    if (!requireAdminGate(res)) return;
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
    if (!requireAdminGate(res)) return;
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
    if (!requireAdminGate(res)) return;
    return sendJson(res, 200, { homeAwayMode: matchmaker.getHomeAwayMode(), modes: HOME_AWAY_MODES, overtime: overtimeEnabled });
  }
  if (path === "/api/fork/matchmaking-settings" && method === "POST") {
    if (!requireAdminGate(res)) return;
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
      // Secret League path (#52 A): off-dataset roster → compose + validate roster-intrinsically.
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
      const result = validate(composed.roster, TEAM_BUILDER_BASELINE, bb2025);
      // Custom UAT mode: never block — always valid, findings surfaced as informational warnings.
      return sendJson(res, 200, {
        valid: body.custom ? true : result.valid,
        errors: body.custom ? [] : result.errors,
        warnings: body.custom ? [...result.errors, ...result.warnings] : result.warnings,
        summary: result.recomputedSummary,
        players: composed.roster.players.length,
        ...(body.custom ? { custom: true } : {}),
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
  if (path === "/api/fork/my-games" && method === "POST") {
    if (!challengeDbCfg)
      return sendJson(res, 503, { error: "Fork DB not configured on this host (set FORK_DB_HOST)." });
    const body = (await readBody(req)) as { coach?: string; password?: string };
    const coach = body.coach?.trim();
    if (!coach) return sendJson(res, 400, { error: "coach is required" });
    if (!isAdminAuthed(req)) {
      if (!body.password)
        return sendJson(res, 401, { error: "Listing your games requires your coach name + fork password (or admin auth)." });
      if (!(await verifyCoachPassword(challengeDbCfg, coach, body.password)))
        return sendJson(res, 401, { error: "Coach authentication failed (wrong coach or password)." });
    }
    try {
      return sendJson(res, 200, { coach, games: await listCoachGames(challengeDbCfg, coach) });
    } catch (e) {
      return sendJson(res, 500, { error: (e as Error).message });
    }
  }

  // Build: re-validate SERVER-SIDE (never trust the client), then write team XML + hot-reload.
  // V2 auth (owner-ruled): TO path = admin Basic-auth (unchanged); else a coach may build a team
  // ONLY for their own authenticated coach — verify {coach, password} against ffb_coaches
  // (verifyCoachPassword, same md5 the fork uses), and the built team's coach must equal it.
  if (path === "/api/fork/team-builder/build" && method === "POST") {
    const cfg = forkConfigFromEnv();
    if (!cfg) return sendJson(res, 503, { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." });
    const body = (await readBody(req)) as TeamBuilderBody;
    if (!isAdminAuthed(req)) {
      const coach = body.coach?.trim();
      if (!coach || !body.password)
        return sendJson(res, 401, { error: "Build requires admin auth, or your coach name + fork password." });
      if (!challengeDbCfg)
        return sendJson(res, 503, { error: "Coach auth unavailable (fork DB not configured); admin auth required." });
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
      const result = validate(composed.roster, TEAM_BUILDER_BASELINE, bb2025);
      // Custom UAT mode (owner 08-04): apply the choice, no validation gate — never reject.
      if (!body.custom && !result.valid) {
        return sendJson(res, 400, { error: "Team is not legal — fix the findings and rebuild.", errors: result.errors, summary: result.recomputedSummary });
      }
      mkdirSync(cfg.teamsDir, { recursive: true });
      const coachTag = composed.roster.coach.replace(/[^\w.-]+/g, "_") || "coach";
      const file = join(cfg.teamsDir, `team_${coachTag}_${composed.teamId}.xml`);
      writeFileSync(file, composed.xml, "utf8");
      const ingestedAt = new Date().toISOString(); // before the reload — see registerBuiltTeam
      const reload = await reloadFork(cfg, FORK_STATE_DIR);
      // goldUsed = the validator's RECOMPUTED total (validate() ran on this path — prefer it over the
      // composer's own figure). The SL branch uses the composed summary, its strongest available number.
      registerBuiltTeam(composed.roster, composed.teamId, result.recomputedSummary.goldUsed, ingestedAt, reload.reloaded);
      return sendJson(res, 200, { ok: true, teamId: composed.teamId, path: file, reload, summary: result.recomputedSummary });
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
    if (!requireAdminGate(res)) return;
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
    if (!requireAdminGate(res)) return;
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
    if (!requireAdminGate(res)) return;
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
    if (!requireAdminGate(res)) return;
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
      // Set CORS before any handler writes a response, so it's on EVERY response for
      // these routes — success or error (a browser can't read either without it). The
      // Team Builder V2 POST routes carry a JSON body (+ optional auth header), so a
      // cross-origin client browser sends a preflight — answer it here.
      if (PUBLIC_PATHS.has(url.pathname)) {
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type,authorization");
        if (req.method === "OPTIONS") {
          res.writeHead(204).end();
          return;
        }
      }
      if (!authorized(req, url.pathname)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="BB Config"' }).end("auth required");
        return;
      }
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname, url.searchParams);
      await serveStatic(res, url.pathname);
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`Config pane on http://${HOST}:${PORT}`);
  console.log(`  packages : ${PACKAGES_DIR}`);
  console.log(`  coaches  : ${VALIDATED_CSV}`);
  console.log(`  auth     : ${ADMIN_PASSWORD ? "password required" : "OPEN (set ADMIN_PASSWORD to lock)"}`);
});

// Super Module (presentation sidecar) — flag-gated + double-guarded on config presence. attachSuper is
// a no-op unless SUPER_ENABLED=1, and construction failure disables Super without touching the HTTP
// server (SM-3). config-web serving is unaffected in every case.
if (challengeDbCfg && forkAdminCfg) {
  attachSuper(server, { dbCfg: challengeDbCfg, forkCfg: forkAdminCfg });
} else if (process.env.SUPER_ENABLED === "1") {
  console.log("[super] SUPER_ENABLED set but fork DB/admin config missing — Super stays OFF.");
}
