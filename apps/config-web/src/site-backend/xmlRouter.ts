/**
 * Dialect-1 `xml:` site-backend router (spec-team-portal §3, Phase-1 critical path). config-web
 * impersonates fumbbl.com for the fork running in FUMBBL-connected mode: the fork hits `fumbbl.base`
 * (→ config-web) for coach auth, team/roster loads, gamestate lifecycle, and the post-game result
 * upload. Every path/param/response shape here is verified against the fork's byte-identical request
 * classes (the wire contract), cited inline.
 *
 * Mounted ADDITIVELY + FLAG-GATED (SITE_BACKEND_ENABLED) into server.ts before the /api + static
 * branches. The paths it claims (`/xml:*`, `/api/clientoptions/get/*`, `/api/name/generate/*`) are
 * NEW — nothing config-web serves today hits them — so an un-flagged deploy is byte-behaviour-identical
 * (strand-proof, deploys nothing). Returns true iff it handled the request.
 *
 * Wire contract (server.ini templates → fork request classes):
 *   xml:auth?op=challenge&coach=$1                 FumbblRequestPasswordChallenge   → <challenge>TOKEN</challenge>
 *   xml:auth?op=response&coach=$1&response=$2       FumbblRequestCheckAuthorization  → <response>OK DEV STATE_EDIT</response>
 *   xml:teams?coach=$1                              FumbblRequestLoadTeamList        → <teams coach><team>…</team></teams>
 *   xml:team?id=$1                                  FumbblRequestLoadTeam            → raw team XML (fork retains verbatim)
 *   xml:roster?team=$1 | xml:roster?id=$1           UtilFumbblRequest.loadFumbblRoster* → raw roster XML
 *   xml:gamestate?op=check|options|create|resume|update|remove   FumbblRequest*Gamestate → <gamestate><result>ok</result>…
 *   xml:result  (multipart: response + f)           FumbblRequestUploadResults      → <result>success</result><description>…</description>
 *   xml:chatlog (form: response + chat)             FumbblRequestUploadTalk         → logged only
 *   api/clientoptions/get/$1                        *LoadPlayerMarkings             → JSON (non-fatal stub)
 *   api/name/generate/…                             name generator                  → JSON (non-fatal stub)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { bankGameResult, type BankingDirs } from "./banking.js";
import { GameStateRegistry, renderGameState } from "./gameState.js";
import type { NonceStore } from "./nonceStore.js";
import { parseFumbblResult } from "./fumbblResult.js";
import { buildBankTasks, unbankedResidual } from "./fumbblResultBanking.js";
import { boundaryFromContentType, parseMultipart } from "./multipart.js";

export interface SiteBackendDeps {
  nonce: NonceStore;
  games: GameStateRegistry;
  /** Fork team store — the `team_<coach>_<id>.xml` files config-web writes/ingests. */
  teamsDir: string;
  /** Roster store — defaults to `<dirname(teamsDir)>/rosters` (server.ts's own convention). */
  rostersDir?: string;
  /** Durable banking ledger dirs (banking.ts). */
  banking: BankingDirs;
  /**
   * Verify a coach's `op=response` challenge-response against the nonce this backend issued.
   * TP-1: this MUST be `verifyForkAuthChallenge` (reuses the verified `adminResponse` replica) bound to
   * the fork DB cfg — never a hand-rolled compare. Returns false (never throws) on unknown coach/bad resp.
   */
  verifyAuth: (coach: string, challengeHex: string, response: string) => Promise<boolean>;
  /** TP-3: the accountProperties tail after "OK" (owner-owned policy surface). Default "DEV STATE_EDIT". */
  accountProperties?: string;
  /**
   * C-3 back-compat (TEMPORARY, owner-worded + dated): during cutover an old client may present a
   * plaintext credential at op=response instead of a challenge-response. When set, a failed
   * challenge-verify falls through to this plaintext verify. Undefined ⇒ window CLOSED (the default).
   */
  legacyPlaintextVerify?: (coach: string, credential: string) => Promise<boolean>;
  /** Optional sink for chat + residual/diagnostic lines (defaults to console.log). */
  log?: (msg: string) => void;
}

const XML_CT = { "content-type": "text/xml; charset=utf-8" } as const;
const JSON_CT = { "content-type": "application/json; charset=utf-8" } as const;

const sendXml = (res: ServerResponse, status: number, xml: string): void => {
  res.writeHead(status, XML_CT);
  res.end(xml);
};

/** Read the full raw request body as a Buffer (multipart bodies are binary — do NOT utf8-decode early). */
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Resolve a team file by fork team id (`team_<coach>_<id>.xml`), same suffix match banking.ts uses. */
function teamFileFor(teamsDir: string, id: string): string | undefined {
  if (!existsSync(teamsDir)) return undefined;
  const suffix = `_${id}.xml`;
  const hit = readdirSync(teamsDir).find((f) => f.endsWith(suffix) || f === `team_${id}.xml`);
  return hit ? join(teamsDir, hit) : undefined;
}

/** The `<rosterId>` a team file declares (its roster reference). */
function rosterIdOfTeam(teamsDir: string, teamId: string): string | undefined {
  const f = teamFileFor(teamsDir, teamId);
  if (!f) return undefined;
  return readFileSync(f, "utf8").match(/<rosterId>([^<]+)<\/rosterId>/)?.[1];
}

/** Resolve a roster file whose `<roster id="ROSTERID">` matches (rosters are keyed by intrinsic id). */
function rosterFileFor(rostersDir: string, rosterId: string): string | undefined {
  if (!existsSync(rostersDir)) return undefined;
  for (const f of readdirSync(rostersDir)) {
    if (!f.endsWith(".xml")) continue;
    const xml = readFileSync(join(rostersDir, f), "utf8");
    if (new RegExp(`<roster\\b[^>]*\\bid="${rosterId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(xml)) {
      return join(rostersDir, f);
    }
  }
  return undefined;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Build the `<teams coach>` list from the on-disk team files whose `<coach>` matches (case-insensitive,
 *  mirroring the fork's equalsIgnoreCase coach handling). Schema: TeamList/TeamListEntry (cited). */
function teamListXml(teamsDir: string, coach: string): string {
  const want = coach.trim().toLowerCase();
  const entries: string[] = [];
  if (existsSync(teamsDir)) {
    for (const f of readdirSync(teamsDir)) {
      if (!f.startsWith("team_") || !f.endsWith(".xml")) continue;
      const xml = readFileSync(join(teamsDir, f), "utf8");
      if ((xml.match(/<coach>([^<]*)<\/coach>/)?.[1] ?? "").trim().toLowerCase() !== want) continue;
      const g = (tag: string): string => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? "";
      const id = xml.match(/<team\b[^>]*\bid="([^"]*)"/)?.[1] ?? "";
      const status = xml.match(/<team\b[^>]*\bstatus="([^"]*)"/)?.[1] ?? "";
      entries.push(
        `<team><id>${esc(id)}</id><status>${esc(status)}</status><division>${esc(g("division"))}</division>` +
          `<name>${esc(g("name"))}</name><teamValue>${esc(g("teamValue"))}</teamValue>` +
          `<race>${esc(g("race"))}</race><treasury>${esc(g("treasury"))}</treasury></team>`,
      );
    }
  }
  return `<teams coach="${esc(coach)}">${entries.join("")}</teams>`;
}

/**
 * Handle an `xml:`/site-backend request. Returns true iff the path belongs to this router (and a
 * response was written), false to let server.ts fall through to /api + static.
 */
export async function handleXmlRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  deps: SiteBackendDeps,
): Promise<boolean> {
  const log = deps.log ?? ((m: string) => console.log(`[site-backend] ${m}`));
  const rostersDir = deps.rostersDir ?? join(dirname(deps.teamsDir), "rosters");

  // The fork's paths carry a literal colon (`/xml:auth`) — Node's URL parser keeps it in the pathname.
  const path = pathname.replace(/^\//, "");

  // ── xml:auth ──────────────────────────────────────────────────────────────────
  if (path === "xml:auth") {
    const op = query.get("op");
    const coach = query.get("coach")?.trim();
    if (!coach) return (sendXml(res, 400, "<response>ERROR missing coach</response>"), true);
    if (op === "challenge") {
      // TP-5: bounded single-use nonce. One line, no nested '<' (fork parses <challenge> by line regex).
      return (sendXml(res, 200, `<challenge>${esc(deps.nonce.issue(coach))}</challenge>`), true);
    }
    if (op === "response") {
      const submitted = (query.get("response") ?? "").trim();
      const nonce = deps.nonce.consume(coach); // single-use: consumed whether or not it verifies
      let okAuth = false;
      if (nonce) okAuth = await deps.verifyAuth(coach, nonce, submitted);
      // C-3 back-compat window (temporary): a plaintext credential from an old client.
      if (!okAuth && deps.legacyPlaintextVerify) okAuth = await deps.legacyPlaintextVerify(coach, submitted);
      if (!okAuth) return (sendXml(res, 200, "<response>NO</response>"), true);
      // TP-3: "OK" + space-separated accountProperties (fork: startsWith("OK") + split(" ").skip(1)).
      const props = deps.accountProperties ?? "DEV STATE_EDIT";
      return (sendXml(res, 200, `<response>OK ${props}</response>`), true);
    }
    return (sendXml(res, 400, "<response>ERROR unknown op</response>"), true);
  }

  // ── xml:teams?coach ───────────────────────────────────────────────────────────
  if (path === "xml:teams") {
    const coach = query.get("coach")?.trim();
    if (!coach) return (sendXml(res, 400, `<teams/>`), true);
    return (sendXml(res, 200, teamListXml(deps.teamsDir, coach)), true);
  }

  // ── xml:team?id ── raw team XML (the fork parses AND retains it verbatim) ────────
  if (path === "xml:team") {
    const id = query.get("id")?.trim();
    const f = id ? teamFileFor(deps.teamsDir, id) : undefined;
    if (!f) return (sendXml(res, 404, `<team/>`), true); // fork LoadTeam fails loud on an empty/nameless team
    return (sendXml(res, 200, readFileSync(f, "utf8")), true);
  }

  // ── xml:roster?team | xml:roster?id ── raw roster XML ───────────────────────────
  if (path === "xml:roster") {
    const teamId = query.get("team")?.trim();
    const rid = teamId ? rosterIdOfTeam(deps.teamsDir, teamId) : query.get("id")?.trim();
    const f = rid ? rosterFileFor(rostersDir, rid) : undefined;
    if (!f) return (sendXml(res, 404, `<roster/>`), true);
    return (sendXml(res, 200, readFileSync(f, "utf8")), true);
  }

  // ── xml:gamestate ── lifecycle over the registry (TP-4 fail-loud) ───────────────
  if (path === "xml:gamestate") {
    const op = query.get("op");
    const g = deps.games;
    let outcome;
    switch (op) {
      case "check":
      case "options":
        outcome = g.check(query.get("team1") ?? undefined, query.get("team2") ?? undefined);
        break;
      case "create":
        outcome = g.create(query.get("game") ?? undefined, query.get("team1") ?? undefined, query.get("team2") ?? undefined);
        break;
      case "resume":
        outcome = g.resume(query.get("game") ?? undefined, gameStateFromQuery(query));
        break;
      case "update":
        outcome = g.update(query.get("gameid") ?? undefined, gameStateFromQuery(query));
        break;
      case "remove":
        outcome = g.remove(query.get("gameid") ?? undefined);
        break;
      default:
        outcome = { ok: false as const, reason: `unknown gamestate op ${op}` };
    }
    return (sendXml(res, 200, renderGameState(outcome)), true);
  }

  // ── xml:result ── multipart upload → parse → bank (TP-4 fail-loud + quarantine) ─
  if (path === "xml:result") {
    if ((req.method ?? "GET") !== "POST") return (sendXml(res, 405, resultXml(false, "result requires POST")), true);
    const boundary = boundaryFromContentType(req.headers["content-type"]);
    if (!boundary) return (sendXml(res, 400, resultXml(false, "not multipart/form-data")), true);
    const parts = parseMultipart(await readRawBody(req), boundary);
    const f = parts.get("f");
    if (!f || !f.value.trim()) return (sendXml(res, 400, resultXml(false, "missing result part 'f'")), true);
    let parsed;
    try {
      parsed = parseFumbblResult(f.value);
    } catch (e) {
      log(`quarantine malformed result: ${(e as Error).message}`);
      return (sendXml(res, 200, resultXml(false, `malformed result: ${(e as Error).message}`)), true);
    }
    if (parsed.teams.length === 0) return (sendXml(res, 200, resultXml(false, "result has no teamResult")), true);
    const banked = bankGameResult(deps.banking, parsed.gameId, buildBankTasks(parsed), f.value);
    // Flag (never drop) the server numbers a v1 apply doesn't yet bank — treasury/injuries/fans.
    log(`result g${parsed.gameId}: applied=[${banked.applied.join(",")}] residual=${JSON.stringify(unbankedResidual(parsed))}`);
    if (!banked.ok) return (sendXml(res, 200, resultXml(false, "one or more teams quarantined — see results/quarantine")), true);
    return (sendXml(res, 200, resultXml(true, `banked ${banked.applied.length} team(s)`)), true);
  }

  // ── xml:chatlog ── accept + log only (v1) ───────────────────────────────────────
  if (path === "xml:chatlog") {
    log("chatlog received (logged only, v1)");
    return (sendXml(res, 200, "<result>success</result>"), true);
  }

  // ── api stubs (non-fatal class): player markings + name generator = empty JSON ──
  if (path.startsWith("api/clientoptions/get/")) {
    res.writeHead(200, JSON_CT);
    res.end("{}"); // AutoMarkingConfig.initFrom tolerates an empty object — no custom markings
    return true;
  }
  if (path.startsWith("api/name/generate")) {
    res.writeHead(200, JSON_CT);
    res.end("[]");
    return true;
  }

  return false; // not ours — let server.ts fall through
}

/** `<result>` + `<description>` on separate lines (fork parses each by line regex). */
function resultXml(success: boolean, description: string): string {
  return `<result>${success ? "success" : "error"}</result>\n<description>${esc(description)}</description>`;
}

const n = (q: URLSearchParams, k: string): number | undefined => {
  const v = q.get(k);
  return v == null || v === "" ? undefined : Number(v);
};

/** Extract the live half/turn/score/spectators from a resume/update query into a registry patch. */
function gameStateFromQuery(q: URLSearchParams): Record<string, number> {
  const patch: Record<string, number> = {};
  const half = n(q, "half");
  const turn = n(q, "turn");
  const score1 = n(q, "score1");
  const score2 = n(q, "score2");
  const spectators = n(q, "spectators");
  if (half !== undefined) patch.half = half;
  if (turn !== undefined) patch.turn = turn;
  if (score1 !== undefined) patch.score1 = score1;
  if (score2 !== undefined) patch.score2 = score2;
  if (spectators !== undefined) patch.spectators = spectators;
  return patch;
}
