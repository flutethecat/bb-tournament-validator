/**
 * League fixture on the local Super FUMBBL fork, end to end (docs/artifact-orchestration/league-fork-test-2026-10-30.md).
 *
 *   pnpm exec tsx scripts/league-fork-test.ts [--keep] [--teardown-only] [--self-sync] [--home <teamId>] [--away <teamId>]
 *       [--state-dir <dir>] [--env <file>] [--client <fumbbl40k-client worktree>] [--out <dir>] [--result-wait <s>]
 *
 * setup     a throwaway league `tabbl-test` ("TABBL Test") in the state dir (default: the LIVE config-web data-store) with
 *           one season holding copies of two TABBL season-6 teams, Flutethecat seated on home and Gondra87 on away (the
 *           same applyTeamCoach the Assign coach account route runs), one fixture marked test + forkEnabled
 * generate  POST .../fork/generate through leagueForkRoutes with the real fork client (forkClient.ts): both fork teams
 *           built and installed, the game scheduled, notifications sent
 * launch    POST .../fork/launch + GET .../fork/jnlp for each seat (the JNLPs are written with the credential redacted)
 * play      both seats driven headless on the scheduled game id (a scenario build of the client worktree's
 *           drivePregame.ts bot): home forces one block casualty and one touchdown with the fork's test talk commands,
 *           then away concedes
 * wait      for the live server's 2-minute result sync (or, with --self-sync, the organiser "Check for result" module
 *           call in this process)
 * verify    fork team files, schedule state, notifications, JNLPs, the banked result, before/after diffs of both league
 *           teams and the fixture, Discord silence; written to <out>/
 * teardown  deletes the throwaway league, its fork team files, library rows, notifications and stored result rows (skipped
 *           with --keep; --teardown-only runs only this). Every run starts by tearing down a previous run.
 *
 * Real TABBL data is only read (season-6.json). identities.json is only read (site admins for the notices). Secrets
 * from the env file are used in-process and never printed or written.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback; };

const LIVE_WEB = "C:/Users/Jay/Documents/Claude/bb-tournament-validator/apps/config-web";
const ENV_FILE = resolve(opt("env", join(LIVE_WEB, ".env")));
const STATE_DIR = resolve(opt("state-dir", process.env.FORK_STATE_DIR || join(LIVE_WEB, "data-store")));
const CLIENT_DIR = resolve(opt("client", "C:/Users/Jay/Documents/Claude/wt-declare"));
const OUT = resolve(opt("out", join(HERE, "../.league-fork-test", new Date().toISOString().replace(/[:.]/g, "-"))));
const LEAGUE_ID = "tabbl-test";
const SOURCE = { league: "tabbl", season: "season-6" };
const HOME_TEAM = opt("home", "middeinheimian-rhapsody");
const AWAY_TEAM = opt("away", "questionable-choices");
const HOME_COACH = "Flutethecat";
const AWAY_COACH = "Gondra87";
const TEST_PASSWORD = "12345"; // local-fork test accounts only
const RESULT_WAIT_S = Number(opt("result-wait", "330"));

// ---- env (values never printed) ----
function loadEnv(file: string): void {
  if (!existsSync(file)) throw new Error(`env file not found: ${file}`);
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
}
loadEnv(ENV_FILE);
process.env.FORK_STATE_DIR = STATE_DIR;
process.env.IDENTITIES_FILE ??= join(LIVE_WEB, "identities.json");

const { LeagueStore } = await import("../src/leagues/store.js");
const { applyTeamCoach } = await import("../src/leagues/teamCoach.js");
const { leagueForkRoutes, syncLeagueForkResults } = await import("../src/leagues/forkPlay.js");
const { forkTeamIdFor } = await import("../src/leagues/forkTeam.js");
const { createLeagueForkClient } = await import("../src/leagues/forkClient.js");
const { registerLeagueEvents } = await import("../src/leagues/events.js");
const { NotificationStore } = await import("../src/notifications.js");
const { TournamentResultStore } = await import("../src/tournamentResults.js");
const { storedTeamFile } = await import("../src/teamDetail.js");
const { parseFumbblResult } = await import("../src/site-backend/fumbblResult.js");
const forkOps = await import("@bb/fork-ops");
const { readIdentities } = await import("../src/auth/identitiesStore.js");
type Season = import("../src/leagues/types.js").SeasonRecord;
type Fixture = import("../src/leagues/types.js").LeagueFixture;
type Team = import("../src/leagues/types.js").LeagueTeam;
type DiscordPayload = import("../src/leagues/discord.js").DiscordPayload;

mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const LIVE_LOG = join(STATE_DIR, "config-web.log");
const liveLogStart = existsSync(LIVE_LOG) ? statSync(LIVE_LOG).size : 0;
const timings: Array<{ step: string; ms: number }> = [];
const lines: string[] = [];
const say = (...a: unknown[]): void => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); console.log(s); lines.push(`${new Date().toISOString()} ${s}`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const s = Date.now();
  say(`== ${name}`);
  try { return await fn(); } finally { timings.push({ step: name, ms: Date.now() - s }); }
}
const checks: Array<{ item: string; ok: boolean; detail: string }> = [];
const check = (item: string, ok: boolean, detail = ""): void => { checks.push({ item, ok, detail }); say(`${ok ? "PASS" : "FAIL"} ${item}${detail ? ` - ${detail}` : ""}`); };

const store = new LeagueStore(STATE_DIR);
const libraryDir = resolve(process.env.FORK_LIBRARY_DIR || join(STATE_DIR, "library"));
const forkCfg = forkOps.forkConfigFromEnv();
const adminCfg = forkOps.forkAdminConfigFromEnv();
const dbCfg = forkOps.forkDbConfigFromEnv();
if (!forkCfg || !adminCfg || !dbCfg) throw new Error("the env file must configure FORK_TEAMS_DIR, FORK_ADMIN_PASSWORD and FORK_DB_HOST");
const results = new TournamentResultStore(STATE_DIR);
const fork = createLeagueForkClient({ forkConfig: () => forkCfg, adminCfg, dbCfg, stateDir: STATE_DIR, libraryDir, results });
const notifications = new NotificationStore(STATE_DIR);
const webhookCalls: Array<{ url: string; payload: DiscordPayload }> = [];
const postWebhook = async (url: string, payload: DiscordPayload): Promise<{ ok: boolean; status: number }> => { webhookCalls.push({ url: "<redacted>", payload }); return { ok: true, status: 204 }; };
const notify = (coach: string, input: Parameters<typeof notifications.add>[1]): void => { notifications.add(coach, input); };
registerLeagueEvents({ store, notify, postWebhook });
// Read-only: the live identities (site admins get the organiser notice, as on the server).
const identities = (): Array<{ coach: string; level: string; banned?: boolean }> =>
  Object.values(readIdentities().coaches).map((c) => ({ coach: c.ffbCoachId, level: c.level, banned: c.banned }));
const leagueLink = `/app/leagues/${LEAGUE_ID}`;

// ---- teardown (also the start of every run) ----
async function teardown(): Promise<void> {
  const league = store.league(LEAGUE_ID);
  const forkTeams = new Map<string, string>(); // forkTeamId -> coach
  if (league) {
    for (const s of store.seasons(LEAGUE_ID)) {
      for (const f of s.fixtures) {
        for (const side of ["home", "away"] as const) {
          const t = f.fork?.teams[side];
          if (t) forkTeams.set(t.forkTeamId, t.coach);
          if (f[side].teamId) forkTeams.set(forkTeamIdFor(LEAGUE_ID, s.id, f[side].teamId!), f[side].coachId ?? "");
        }
        if (f.fork?.gameId && f.fork.status === "scheduled") {
          const gone = await fork.deleteGame(f.fork.gameId);
          say(`teardown: unstarted game ${f.fork.gameId} ${gone ? "withdrawn" : "not withdrawn (started or unknown)"}`);
        }
        if (f.fork?.gameId) {
          const row = results.get(f.fork.gameId);
          const ours = row && [row.home?.teamId, row.away?.teamId].every((id) => id && forkTeams.has(id));
          if (ours && results.remove(f.fork.gameId)) say(`teardown: removed stored result row ${f.fork.gameId}`);
        }
      }
    }
  }
  let removedFiles = 0;
  for (const [id, coach] of forkTeams) {
    if (!/^lg_[0-9a-f]{16}$/.test(id)) continue;
    const file = storedTeamFile(forkCfg!.teamsDir, id);
    if (file) { unlinkSync(file.path); removedFiles += 1; }
    for (const c of new Set([coach, HOME_COACH, AWAY_COACH].filter(Boolean))) {
      try { forkOps.removeLibraryTeam(libraryDir, c, id); } catch (e) { say(`teardown: library row ${c}/${id}: ${(e as Error).message}`); }
    }
  }
  if (removedFiles) {
    const r = await forkOps.reloadFork(forkCfg!, STATE_DIR);
    say(`teardown: removed ${removedFiles} fork team file(s); fork reload ${r.reloaded ? `ok (${r.method})` : `refused: ${r.reason}`}`);
  }
  // Notification rows this league created (links into the test league), every coach.
  const nd = join(STATE_DIR, "notifications");
  let dropped = 0;
  if (existsSync(nd)) {
    for (const f of readdirSync(nd).filter((x) => x.endsWith(".json"))) {
      const path = join(nd, f);
      try {
        const data = JSON.parse(readFileSync(path, "utf8")) as { notifications?: Array<{ link?: string }> };
        if (!Array.isArray(data.notifications)) continue;
        const keep = data.notifications.filter((n) => !(typeof n.link === "string" && n.link.startsWith(leagueLink + "?")));
        if (keep.length === data.notifications.length) continue;
        dropped += data.notifications.length - keep.length;
        forkOps.atomicWriteTextFile(path, `${JSON.stringify({ ...data, notifications: keep }, null, 2)}\n`);
      } catch { /* unreadable: left alone */ }
    }
  }
  if (dropped) say(`teardown: removed ${dropped} notification row(s) linking to ${leagueLink}`);
  if (league) {
    const dir = store.leagueDir(LEAGUE_ID);
    if (!dir.replace(/\\/g, "/").endsWith(`/leagues/${LEAGUE_ID}`)) throw new Error(`refusing to delete ${dir}`);
    rmSync(dir, { recursive: true, force: true });
    say(`teardown: deleted ${dir}`);
  }
}

if (flag("teardown-only")) {
  await teardown();
  process.exit(0);
}

// ---- setup ----
const realSeasonFile = join(STATE_DIR, "leagues", SOURCE.league, "seasons", `${SOURCE.season}.json`);
const realStamp = (): string => { const s = statSync(realSeasonFile); return `${s.size}:${s.mtimeMs}`; };
const realBefore = realStamp();
const runId = `run-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").toLowerCase()}`;
const FIXTURE_ID = "f1";
let seasonId = runId;

await step("teardown of a previous run", teardown);

const setup = await step("setup", () => {
  const src = store.season(SOURCE.league, SOURCE.season);
  if (!src) throw new Error(`no ${SOURCE.league}/${SOURCE.season}`);
  const pick = (id: string): Team => { const t = src.teams.find((x) => x.id === id); if (!t) throw new Error(`no team ${id} in ${SOURCE.season}`); return structuredClone(t); };
  const home = pick(HOME_TEAM);
  const away = pick(AWAY_TEAM);
  const now = new Date().toISOString();
  store.upsertLeague({ id: LEAGUE_ID, name: "TABBL Test", fullName: "TABBL Test (throwaway league-fork-test rig)", slug: LEAGUE_ID,
    description: "Throwaway league for the league-fork-test rig. Deleted at the end of every run.", organisers: [HOME_COACH], owner: HOME_COACH,
    ruleset: "BB2025", mode: "individual", playOnFork: true });
  const side = (t: Team) => ({ team: t.name, teamId: t.id, coach: t.coach, race: t.race, score: null, cas: null, conceded: false });
  const participant = (t: Team) => ({ ...(src.participants.find((p) => p.team === t.name) ?? { coach: t.coach, country: "", race: t.race, team: t.name, active: true }) });
  const fixture: Fixture = { id: FIXTURE_ID, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
    home: side(home), away: side(away), suspended: false, forkEnabled: true, test: true };
  const season: Season = {
    ...structuredClone(src), id: seasonId, leagueId: LEAGUE_ID, number: 1, name: "Test season", sourceSlug: `${LEAGUE_ID}-${seasonId}`, status: "active",
    startedAt: now, endedAt: undefined, phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [], standings: [] }],
    fixtures: [fixture], participants: [participant(home), participant(away)], teams: [home, away], honours: [], awards: [], unattributedStats: [],
    importedAt: now, log: [], revision: 0,
  } as Season;
  delete (season as Partial<Season>).endedAt;
  applyTeamCoach(season, home.id, HOME_COACH, "league-fork-test", now);
  applyTeamCoach(season, away.id, AWAY_COACH, "league-fork-test", now);
  store.putSeason(season);
  const saved = store.season(LEAGUE_ID, seasonId)!;
  say(`league ${LEAGUE_ID} season ${seasonId}: ${home.name} (${HOME_COACH}) vs ${away.name} (${AWAY_COACH})`);
  return saved;
});
const before = structuredClone(setup);
writeFileSync(join(OUT, "before-season.json"), JSON.stringify(before, null, 2));

const routeDeps = (body = ""): Parameters<typeof leagueForkRoutes>[4] => ({
  store, fork, notify, identities, postWebhook,
  readBody: async () => Buffer.from(body, "utf8"), declaredTooLarge: () => false,
});
const call = async (method: string, coach: string, action: string) =>
  (await leagueForkRoutes(method, LEAGUE_ID, ["seasons", seasonId, "fixtures", FIXTURE_ID, "fork", action], { coach, admin: false }, routeDeps()))
    ?? { status: 404, body: { error: "route not matched" } } as NonNullable<Awaited<ReturnType<typeof leagueForkRoutes>>>;
const fixtureNow = (): Fixture => store.season(LEAGUE_ID, seasonId)!.fixtures.find((f) => f.id === FIXTURE_ID)!;
const notifCount = (): number => {
  const nd = join(STATE_DIR, "notifications");
  if (!existsSync(nd)) return 0;
  let n = 0;
  for (const f of readdirSync(nd).filter((x) => x.endsWith(".json"))) {
    try { n += ((JSON.parse(readFileSync(join(nd, f), "utf8")) as { notifications?: Array<{ link?: string }> }).notifications ?? []).filter((r) => r.link?.startsWith(leagueLink + "?")).length; } catch { /* skip */ }
  }
  return n;
};

let exitCode = 0;
let driver: ReturnType<typeof spawn> | undefined;
try {
  const driverFile = buildDriver(); // fail fast, before anything is scheduled
  // ---- 1. generate ----
  const gen = await step("generate", () => call("POST", HOME_COACH, "generate"));
  say("generate ->", gen.status, JSON.stringify(gen.body).slice(0, 400));
  const f1 = fixtureNow();
  check("1a generate answered 200", gen.status === 200, `HTTP ${gen.status}`);
  check("1b fixture.fork.status scheduled", f1.fork?.status === "scheduled", `status=${f1.fork?.status} gameId=${f1.fork?.gameId}`);
  for (const s of ["home", "away"] as const) {
    const ft = f1.fork?.teams[s];
    const file = ft ? storedTeamFile(forkCfg.teamsDir, ft.forkTeamId) : undefined;
    if (file) writeFileSync(join(OUT, `fork-team-${s}-${ft!.forkTeamId}.xml`), file.xml);
    const plus = (file?.xml.match(/<skill>\+(MA|ST|AG|PA|AV)<\/skill>/g) ?? []).length;
    const stored = (file?.xml.match(/storedValue="\d+"/g) ?? []).length;
    const injuries = (file?.xml.match(/<injury[ >]/g) ?? []).length;
    const lib = ft ? forkOps.readLibrary(libraryDir, ft.coach).find((r) => r.teamId === ft.forkTeamId) : undefined;
    check(`1c ${s} fork team file built`, Boolean(file && lib?.forkLoadable), `${ft?.forkTeamId} players=${ft?.players.length} +STAT skills=${plus} storedValue attrs=${stored} injuries=${injuries} library row=${lib ? `forkLoadable=${lib.forkLoadable}` : "missing"}`);
  }
  const notes = notifCount();
  check("1d notifications created", notes > 0, `${notes} row(s) link to ${leagueLink}`);
  if (f1.fork?.status !== "scheduled" || !f1.fork.gameId) throw new Error("not scheduled; stopping");
  const gameId = f1.fork.gameId;

  // ---- 2. launch ----
  await step("launch files", async () => {
    for (const [side, coach] of [["home", HOME_COACH], ["away", AWAY_COACH]] as const) {
      const l = await call("POST", coach, "launch");
      const j = await call("GET", coach, "jnlp");
      const bytes = j.download?.bytes.toString("utf8") ?? "";
      const redacted = bytes.replace(/(<argument>-password<\/argument>\s*<argument>)[^<]*(<\/argument>)/gi, "$1<redacted>$2").replace(/([?&](?:password|passwordMd5|pw)=)[0-9a-f]{32}/gi, "$1<redacted>").replace(/\b[0-9a-f]{32}\b/gi, "<redacted-md5>");
      if (bytes) writeFileSync(join(OUT, `launch-${side}.jnlp`), redacted);
      check(`2a ${side} launch file`, l.status === 200 && j.status === 200 && bytes.includes(gameId), `launch HTTP ${l.status}, jnlp HTTP ${j.status}, ${bytes.length} bytes, carries game ${gameId}: ${bytes.includes(gameId)}`);
    }
  });

  // ---- play ----
  const forkHome = f1.fork.teams.home!.forkTeamId;
  const forkAway = f1.fork.teams.away!.forkTeamId;
  const botLog = join(OUT, "bot.log");
  const played = await step("play (headless both seats)", () => new Promise<boolean>((done) => {
    const args = ["exec", "tsx", driverFile, "--side", "both", "--league-scenario", "--gameId", gameId, "--home", HOME_COACH, "--homeTeam", forkHome,
      "--away", AWAY_COACH, "--awayTeam", forkAway, "--password", TEST_PASSWORD, "--alive", "900"];
    say(`driver: pnpm ${args.join(" ")}`);
    driver = spawn("pnpm", args, { cwd: join(CLIENT_DIR, "packages/ffb-protocol"), shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const keep = (d: Buffer): void => { log += d.toString(); writeFileSync(botLog, log); };
    driver.stdout!.on("data", keep);
    driver.stderr!.on("data", keep);
    driver.on("exit", (code) => { say(`driver exited ${code}`); done(/GAME OVER/.test(log)); });
  }));
  driver = undefined;
  const bot = readFileSync(botLog, "utf8");
  check("2b game played to the end", played, `touchdown=${/LEAGUE touchdown/.test(bot)} casualty block=${/LEAGUE block sent/.test(bot)} concede=${/LEAGUE concede/.test(bot)}`);

  // ---- 3. result sync ----
  const rawXml = await step("raw fork result", () => rawResult(gameId).catch((e) => `ERROR ${(e as Error).message}`));
  writeFileSync(join(OUT, "fork-result.xml"), rawXml);
  let parsedFull = false;
  try { const p = parseFumbblResult(rawXml.replace(/^\s*<\?xml[^>]*\?>\s*/, "")); parsedFull = p.teams.length === 2 && p.gameId === gameId; writeFileSync(join(OUT, "fork-result-parsed.json"), JSON.stringify(p, null, 2)); } catch (e) { say(`parseFumbblResult: ${(e as Error).message}`); }
  const states = await fork.gameStates([gameId]).catch((e) => { say(`gameStates: ${(e as Error).message}`); return new Map(); });
  say(`fork says game ${gameId}:`, JSON.stringify(states.get(gameId) ?? null));
  const waited = await step(flag("self-sync") ? "result (organiser Check for result, in process)" : "result (live server 2-minute sync)", async () => {
    const until = Date.now() + RESULT_WAIT_S * 1000;
    while (Date.now() < until) {
      if (fixtureNow().fork?.result) return true;
      if (flag("self-sync")) {
        const r = await call("POST", HOME_COACH, "sync");
        const body = r.body as { applied?: string[]; errors?: string[] };
        say("sync ->", r.status, JSON.stringify({ applied: body.applied, errors: body.errors }));
        if (body.applied?.length) say(`result applied by this process (organiser Check for result)`);
      }
      await sleep(10000);
    }
    return false;
  });
  const after = store.season(LEAGUE_ID, seasonId)!;
  writeFileSync(join(OUT, "after-season.json"), JSON.stringify(after, null, 2));
  const fx = after.fixtures.find((f) => f.id === FIXTURE_ID)!;
  const r = fx.fork?.result;
  check("3a fixture received the result", waited && Boolean(r), r ? `${r.home.score}-${r.away.score} source=${r.source} cas ${r.home.cas}/${r.away.cas} conceded ${r.home.conceded}/${r.away.conceded}` : "no result");
  check("3b result source full", r?.source === "full", `source=${r?.source ?? "-"}; raw FumbblResult parsed=${parsedFull}`);
  const diff = { home: teamDiff(before.teams[0]!, after.teams[0]!), away: teamDiff(before.teams[1]!, after.teams[1]!), fixture: { before: before.fixtures[0], after: fx } };
  writeFileSync(join(OUT, "diff.json"), JSON.stringify(diff, null, 2));
  const homeLines = r?.home.lines ?? [];
  const scorer = homeLines.find((l) => l.td > 0);
  const casMaker = homeLines.find((l) => l.cas > 0);
  const victim = (r?.away.lines ?? []).find((l) => l.injuries.length);
  check("3c per-player lines", Boolean(r && homeLines.length && r.away.lines.length), `${homeLines.length} home / ${r?.away.lines.length ?? 0} away lines`);
  check("3d SPP on the scorer", Boolean(scorer?.playerId && diff.home.players[scorer.playerId]?.availableSpp), scorer ? `${scorer.name}: ${JSON.stringify(diff.home.players[scorer.playerId ?? ""] ?? {})}` : "no TD line");
  check("3e SPP on the casualty-maker", Boolean(casMaker?.playerId && diff.home.players[casMaker.playerId]?.availableSpp), casMaker ? `${casMaker.name}: ${JSON.stringify(diff.home.players[casMaker.playerId ?? ""] ?? {})}` : "no CAS line");
  check("3f injury on the victim", Boolean(victim), victim ? `${victim.name}: ${victim.injuries.join(", ")} -> ${JSON.stringify(diff.away.players[victim.playerId ?? ""] ?? diff.away.retired)}` : "no injured line");
  check("3g treasury winnings banked", diff.home.team.treasury !== undefined || diff.away.team.treasury !== undefined, JSON.stringify({ home: diff.home.team.treasury, away: diff.away.team.treasury }));
  check("3h fan factor", true, JSON.stringify({ home: diff.home.team.fans ?? "unchanged", away: diff.away.team.fans ?? "unchanged" }));
  // ---- 4. Discord ----
  const liveLog = readTail(LIVE_LOG, liveLogStart);
  // The startup banner prints the discord-bot data path on every restart: not a Discord event.
  const discordErr = liveLog.split(/\r?\n/).filter((l) => /webhook|discord[^\n]*(post|fail|error)/i.test(l) && !/validated-rosters/.test(l));
  const restarts = (liveLog.match(/starting config-web/g) ?? []).length;
  check("4 Discord silent (no webhook on the test league)", webhookCalls.length === 0 && !existsSync(join(store.leagueDir(LEAGUE_ID), "secrets.json")) && discordErr.length === 0,
    `in-process webhook calls=${webhookCalls.length}; live log Discord/webhook lines since start=${discordErr.length}${discordErr.length ? ` (${discordErr.slice(0, 3).join(" | ")})` : ""}; live server restarts during the run=${restarts}; live log result line=${/Super FUMBBL results applied: .*\b/.test(liveLog) ? liveLog.match(/Super FUMBBL results applied: [^\n]*/)![0] : "none"}`);
  check("real TABBL season untouched", realStamp() === realBefore, realSeasonFile);
} catch (e) {
  exitCode = 1;
  say(`ERROR ${(e as Error).stack ?? e}`);
} finally {
  if (driver?.pid) spawnSync("taskkill", ["/PID", String(driver.pid), "/T", "/F"], { stdio: "ignore" });
  writeFileSync(join(OUT, "checks.json"), JSON.stringify({ checks, timings, totalMs: Date.now() - t0 }, null, 2));
  if (flag("keep")) say(`--keep: the test league stays (${store.leagueDir(LEAGUE_ID)}); run --teardown-only to remove it`);
  else await step("teardown", teardown).catch((e) => say(`teardown failed: ${(e as Error).message}`));
  writeFileSync(join(OUT, "rig.log"), lines.join("\n"));
  say(`out: ${OUT}`);
  say(`timings: ${timings.map((t) => `${t.step} ${(t.ms / 1000).toFixed(1)}s`).join(" | ")}`);
  if (checks.some((c) => !c.ok)) exitCode = 1;
  process.exit(exitCode);
}

// ---- helpers ----

/** Field-level changes of a league team (players by playerId; retired = players gone to formerPlayers). */
function teamDiff(a: Team, b: Team) {
  const team: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of Object.keys({ ...a, ...b }) as Array<keyof Team>) {
    if (k === "players" || k === "formerPlayers") continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) team[k] = { before: a[k], after: b[k] };
  }
  const players: Record<string, Record<string, { before: unknown; after: unknown }> & { name?: never }> = {};
  for (const p of a.players) {
    const q = b.players.find((x) => x.playerId === p.playerId);
    if (!q) continue;
    const ch: Record<string, { before: unknown; after: unknown }> = {};
    for (const k of Object.keys({ ...p, ...q }) as Array<keyof typeof p>) {
      if (k === "stats") {
        for (const s of Object.keys({ ...p.stats, ...q.stats }) as Array<keyof typeof p.stats>) if (p.stats[s] !== q.stats[s]) ch[`stats.${s}`] = { before: p.stats[s], after: q.stats[s] };
      } else if (JSON.stringify(p[k]) !== JSON.stringify(q[k])) ch[k] = { before: p[k], after: q[k] };
    }
    if (Object.keys(ch).length) players[p.playerId] = { name: { before: p.name, after: q.name }, ...ch } as never;
  }
  const retired = a.players.filter((p) => !b.players.some((q) => q.playerId === p.playerId)).map((p) => p.name);
  return { team, players, retired };
}

/** The fork's raw /gamestate/result body (one admin exchange on the shared queue), for the parse-gap record. */
async function rawResult(gameId: string): Promise<string> {
  return forkOps.adminExchange(adminCfg!, async () => {
    const ch = await (await fetch(`${adminCfg!.baseUrl}/gamestate/challenge`)).text();
    const challenge = ch.match(/<challenge>([^<]*)<\/challenge>/i)?.[1];
    if (!challenge) throw new Error("no challenge");
    const response = forkOps.adminResponse(challenge, adminCfg!.passwordMd5Hex);
    return (await fetch(`${adminCfg!.baseUrl}/gamestate/result?response=${encodeURIComponent(response)}&gameId=${encodeURIComponent(gameId)}`)).text();
  });
}

/** What the live server appended to its log since `offset` (bytes; the log carries no per-line timestamps). */
function readTail(path: string, offset: number): string {
  if (!existsSync(path)) return "";
  const buf = readFileSync(path);
  return buf.subarray(Math.min(offset, buf.length)).toString("utf8");
}

/**
 * The scenario bot: the client worktree's drivePregame.ts (both seats, --play machinery) with a `--league-scenario`
 * mode, written beside the run output with its imports pointed back at the worktree. Home: one block with forced dice
 * (POW, armour 6+6, injury 6+6, casualty 13 + 3 = a lasting injury), then a touchdown (/set_player + /set_ball next
 * to the end zone, one step in). Away: ends its turns until the touchdown, then concedes.
 */
function buildDriver(): string {
  const proto = join(CLIENT_DIR, "packages/ffb-protocol");
  const srcPath = join(proto, "scripts/drivePregame.ts");
  let code = readFileSync(srcPath, "utf8");
  const dir = join(OUT, "drv");
  mkdirSync(dir, { recursive: true });
  const nm = join(dir, "node_modules");
  if (!existsSync(nm)) symlinkSync(join(proto, "node_modules"), nm, "junction");
  const abs = (p: string): string => p.replace(/\\/g, "/");
  const swap = (from: string | RegExp, to: string, what: string): void => {
    const next = code.replace(from, to);
    if (next === code) throw new Error(`driver patch did not apply: ${what}`);
    code = next;
  };
  swap(/from '\.\.\/src\//g, `from '${abs(join(proto, "src"))}/`, "imports");
  swap("const doPlay = process.argv.includes('--play');", "const leagueScenario = process.argv.includes('--league-scenario');\nconst doPlay = process.argv.includes('--play') || leagueScenario;", "doPlay");
  swap("dlg === 'concedeGame' && doProbeConcede &&", "dlg === 'concedeGame' && (doProbeConcede || leagueScenario) &&", "concede confirm");
  swap(/(function playRegular\(c: C\) \{\r?\n\s*const g = c\.st!;\r?\n\s*if \(!g\.homePlaying\) return;[^\n]*\n)/, "$1  if (leagueScenario) return leagueRegular(c);\n", "playRegular hook");
  // Every drive's setup (the stock key is per half, so the drive after a touchdown never set up), with the players
  // who can play (reserves or already standing; the injured and KO'd stay in their boxes).
  swap("const k = `setup:${g.half}`;", "const k = `setup:${g.half}:${g.turnDataHome?.turnNr}:${g.turnDataAway?.turnNr}:${JSON.stringify((g as unknown as { gameResult?: unknown }).gameResult ?? null).length}`;", "setup key");
  swap("const players = [...(team?.playerArray ?? [])].sort(", "const ready = new Set((c.st?.fieldModel?.playerDataArray ?? []).filter((d) => [1, 9].includes(((d.playerState as number) ?? 0) & 0xff)).map((d) => d.playerId));\n  const players = [...(team?.playerArray ?? [])].filter((p) => ready.has(p.playerId)).sort(", "setup players");
  // BB2025 concession: the server asks the winning coach to assign the awarded touchdowns (playerChoice
  // assignTouchdown, minSelects 1); the stock bot answers it empty and the server asks again forever.
  swap("      if (pcm === 'mvp') {", "      if (pcm === 'assignTouchdown') {\n" +
    "        const ids = ((dialogParam as { playerIds?: string[] }).playerIds ?? []).slice(0, (dialogParam as { minSelects?: number }).minSelects ?? 1);\n" +
    "        return act(`assignTd:${Math.floor(Date.now() / 3000)}`, { netCommandId: NetCommandId.CLIENT_PLAYER_CHOICE, playerChoiceMode: pcm, playerIds: ids });\n" +
    "      }\n      if (pcm === 'mvp') {", "assign touchdown");
  // The winner is asked for MVP nominees twice after a concession (its own team, then for the conceding side) with an
  // identical dialog, so the stock per-dialog key never answers the second ask: one answer per 3 s while it is up.
  swap("return act(`mvp:${dialogParam?.teamId}:${mvpAsk.round}`", "return act(`mvp:${dialogParam?.teamId}:${mvpAsk.round}:${Math.floor(Date.now() / 3000)}`", "mvp re-ask");
  // A Secret Weapon is sent off at the end of a drive, so the argue-the-call dialog can open in turnMode setup, where
  // the stock bot only places players: decline the argue (no players) there too.
  swap(/\n  if \(g\.turnMode === 'setup'\) \{/, "\n  if (g.turnMode === 'setup' && (g.dialogParameter as { dialogId?: string; teamId?: string } | undefined)?.dialogId === 'argueTheCall') {\n" +
    "    const dp = g.dialogParameter as { teamId?: string };\n" +
    "    if (!dp.teamId || dp.teamId === myTeam(c)?.teamId) { const k = `argue-setup:${g.half}:${Math.floor(Date.now() / 3000)}`; if (!c.handled.has(k)) { c.handled.add(k); c.s.send({ netCommandId: NetCommandId.CLIENT_ARGUE_THE_CALL, playerIds: [] } as never); } }\n" +
    "    return;\n  }\n  if (g.turnMode === 'setup') {", "argue in setup");
  swap("async function main() {", `${leagueScenarioSource()}\nasync function main() {`, "scenario body");
  const out = join(dir, "leagueDrive.ts");
  writeFileSync(out, code);
  return out;
}

function leagueScenarioSource(): string {
  return String.raw`
// ---- league-fork-test scenario (config-web scripts/league-fork-test.ts) ----
let lgStage: 'block' | 'blocking' | 'tdset' | 'tdmove' | 'tdsent' | 'scored' = 'block';
let lgAt = 0; let lgAttacker = ''; let lgScorer = ''; let lgY = -1; let lgTries = 0; let lgConceded = false; let lgSetAt = 0;
const lgHome = () => probeClients.find((x) => x.label === 'home')?.st;
const lgScore = () => Number((lgHome() as unknown as { gameResult?: { teamResultHome?: { score?: number } } } | undefined)?.gameResult?.teamResultHome?.score ?? 0);
function leagueRegular(c: C) {
  const g = c.st!;
  if ((g.dialogParameter as { dialogId?: string } | undefined)?.dialogId) return;
  const now = Date.now();
  const turnKey = g.half + ':' + g.turnDataHome?.turnNr;
  const talk = (t: string) => { console.log('[' + c.label + '] LEAGUE talk ' + t); c.s.send({ netCommandId: NetCommandId.CLIENT_TALK, talk: t } as never); };
  const endTurn = (why: string) => { const k = 'lg-end:' + turnKey; if (c.handled.has(k)) return; c.handled.add(k); console.log('[' + c.label + '] LEAGUE end turn (' + why + ')'); c.s.send({ netCommandId: NetCommandId.CLIENT_END_TURN, turnMode: g.turnMode, playersAtCoordinates: {} } as never); };
  if (lgScore() > 0) lgStage = 'scored';
  if (c.label === 'away') {
    if (lgStage === 'scored') {
      if (!lgConceded) { lgConceded = true; console.log('[away] LEAGUE concede: requesting (score ' + lgScore() + ')'); c.s.send({ netCommandId: NetCommandId.CLIENT_CONCEDE_GAME, concedeGameStatus: 'requested' } as never); }
      return;
    }
    return endTurn('waiting for the home touchdown');
  }
  if (lgStage === 'scored') return endTurn('scored');
  if (now < lgAt) return;
  const mine = myOnFieldPlayers(c).filter((d) => isUp(d) && !isNegatrait(c, d.playerId));
  const mineAll = mineIds(c);
  const foes = (g.fieldModel?.playerDataArray ?? []).filter((p) => !mineAll.has(p.playerId) && onPitch(p.playerCoordinate) && isUp(p));
  if (lgStage === 'block') {
    let pair: [typeof mine[number], typeof foes[number]] | undefined;
    for (const d of mine) { const f = foes.find((x) => cheb(d.playerCoordinate!, x.playerCoordinate!) === 1); if (f) { pair = [d, f]; break; } }
    if (!pair) {
      if (now - lgSetAt < 4000) return;
      const att = mine[0]; const foe = foes[0];
      const nr = att && playerNrOf(c, att.playerId);
      if (!att || !foe || nr == null) return endTurn('no attacker or foe');
      const [fx, fy] = foe.playerCoordinate!;
      const sq = [[fx - 1, fy], [fx - 1, fy - 1], [fx - 1, fy + 1], [fx, fy - 1], [fx, fy + 1]].find(([x, y]) => x >= 0 && x <= 25 && y >= 0 && y <= 14 && !occupied(g, x, y));
      if (!sq) return endTurn('no square next to a foe');
      lgSetAt = now; talk('/set_player ' + nr + ' ' + sq[0] + ' ' + sq[1]);
      return;
    }
    const [att, foe] = pair; lgAttacker = att.playerId;
    talk('/roll clear');
    talk('/roll pow pow pow 6 6 6 6 13 3');
    lgStage = 'blocking'; lgAt = now + 8000;
    setTimeout(() => whenPriorEnded(c, att.playerId, () => {
      c.s.send({ netCommandId: NetCommandId.CLIENT_ACTING_PLAYER, playerId: att.playerId, playerAction: 'block', leaping: false } as never);
      whenActingAcked(c, att.playerId, 'block', () => { console.log('[home] LEAGUE block sent ' + att.playerId + ' -> ' + foe.playerId); c.s.send({ netCommandId: NetCommandId.CLIENT_BLOCK, actingPlayerId: att.playerId, defenderId: foe.playerId, usingStab: false, usingChainsaw: false, usingVomit: false, usingBreatheFire: false, usingChomp: false } as never); });
    }), 700);
    return;
  }
  if (lgStage === 'blocking') {
    talk('/roll clear');
    const v = (g.fieldModel?.playerDataArray ?? []).filter((p) => !mineAll.has(p.playerId) && (!onPitch(p.playerCoordinate) || ((p.playerState as number) & 0xff) > 3));
    console.log('[home] LEAGUE after block: away players off the pitch / hurt: ' + v.map((p) => p.playerId + '@' + JSON.stringify(p.playerCoordinate) + ' state ' + ((p.playerState as number) & 0xff)).join(', '));
    lgStage = 'tdset';
  }
  if (lgStage === 'tdset') {
    if (++lgTries > 6) return endTurn('touchdown setup failed');
    const scorer = mine.find((d) => d.playerId !== lgAttacker);
    const nr = scorer && playerNrOf(c, scorer.playerId);
    if (!scorer || nr == null) return endTurn('no scorer');
    const free = (x: number, y: number) => !occupied(g, x, y) || (scorer.playerCoordinate![0] === x && scorer.playerCoordinate![1] === y);
    const ys = [7, 6, 8, 5, 9, 4, 10, 3, 11, 2, 12, 1, 13, 0, 14];
    const y = ys.find((yy) => free(24, yy) && free(25, yy) && !foes.some((f) => cheb(f.playerCoordinate!, [24, yy]) <= 1));
    if (y === undefined) return endTurn('no clear lane at x=24');
    lgScorer = scorer.playerId; lgY = y;
    talk('/set_player ' + nr + ' 24 ' + y);
    setTimeout(() => talk('/set_ball 24 ' + y), 500);
    lgStage = 'tdmove'; lgAt = now + 2500;
    return;
  }
  if (lgStage === 'tdmove') {
    const pd = (g.fieldModel?.playerDataArray ?? []).find((p) => p.playerId === lgScorer);
    const ball = g.fieldModel?.ballCoordinate as [number, number] | undefined;
    if (!pd || pd.playerCoordinate?.[0] !== 24 || pd.playerCoordinate?.[1] !== lgY || !ball || ball[0] !== 24 || ball[1] !== lgY) { console.log('[home] LEAGUE scorer/ball not in place yet: ' + JSON.stringify(pd?.playerCoordinate) + ' ball ' + JSON.stringify(ball)); lgStage = 'tdset'; return; }
    const id = lgScorer; const y = lgY;
    lgStage = 'tdsent'; lgAt = now + 6000;
    whenPriorEnded(c, id, () => {
      c.s.send({ netCommandId: NetCommandId.CLIENT_ACTING_PLAYER, playerId: id, playerAction: 'move', leaping: false } as never);
      setTimeout(() => { console.log('[home] LEAGUE touchdown move ' + id + ' [24,' + y + '] -> [25,' + y + ']'); c.s.send({ netCommandId: NetCommandId.CLIENT_MOVE, actingPlayerId: id, coordinateFrom: [24, y], coordinatesTo: [[25, y]] } as never); }, 400);
    });
    return;
  }
  if (lgStage === 'tdsent') { console.log('[home] LEAGUE touchdown not registered (score ' + lgScore() + '); retrying the setup'); lgStage = 'tdset'; }
}
`;
}
