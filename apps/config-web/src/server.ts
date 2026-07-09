/**
 * Config pane HTTP server — zero framework (Node built-in http), so it hosts
 * anywhere Node runs. Serves the static wizard (public/) + a small JSON API.
 *
 * Binds to 127.0.0.1 by default. To expose it, set HOST=0.0.0.0 AND ADMIN_PASSWORD
 * (Basic auth). Over a public network put it behind TLS — Basic auth is plaintext.
 */

import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackage, renderArtPrompt, renderPackageHtml, type TournamentPackage } from "@bb/validator";
import {
  adminCache,
  adminClose,
  adminConcede,
  adminDelete,
  adminList,
  adminMessage,
  buildForkJnlp,
  createForkAccount,
  forkAdminConfigFromEnv,
  forkConfigFromEnv,
  forkDbConfigFromEnv,
  ingestForkTeam,
  isLoadedOnFork,
  jnlpFilename,
  Matchmaker,
  queryCoaches,
  readLibrary,
  reloadFork,
  scheduleForkGame,
  upsertLibraryTeam,
  verifyCoachPassword,
} from "@bb/fork-ops";
import { PackageFiles, readCoaches, skillCatalog, starList, teamList } from "./data";
import { PRESETS } from "./presets";

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
  "/api/fork/jnlp",
  "/api/fork/register",
  "/api/fork/library",
  "/api/fork/library/ingest",
  "/api/fork/coaches",
  "/api/fork/challenge",
  "/api/fork/matchstatus",
  "/api/fork/cancel",
  "/api/fork/reload",
]);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(HERE, "../public");
const PORT = Number(process.env.PORT ?? 4310);
const HOST = process.env.HOST ?? "127.0.0.1";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const PACKAGES_DIR = resolve(process.env.PACKAGES_DIR || join(HERE, "../../../tournament-packages"));
const VALIDATED_CSV = resolve(
  process.env.VALIDATED_CSV || join(HERE, "../../discord-bot/data-store/validated-rosters.csv"),
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
const matchmaker = new Matchmaker({
  scheduleGame: forkAdminCfg
    ? (teamHomeId, teamAwayId) => scheduleForkGame(forkAdminCfg, teamHomeId, teamAwayId)
    : undefined,
  verifyChallenger: challengeDbCfg
    ? (coach, password) => verifyCoachPassword(challengeDbCfg, coach, password)
    : undefined,
});

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

  if (path === "/api/packages" && method === "GET") return sendJson(res, 200, packages.list());

  if (path === "/api/packages" && method === "POST") {
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
      return sendJson(res, 200, await scheduleForkGame(forkAdminCfg, body.homeTeamId, body.awayTeamId));
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

  sendJson(res, 404, { error: "Unknown endpoint." });
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      // Set CORS before any handler writes a response, so it's on EVERY response for
      // these routes — success or error (a browser can't read either without it).
      if (PUBLIC_PATHS.has(url.pathname)) res.setHeader("access-control-allow-origin", "*");
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
