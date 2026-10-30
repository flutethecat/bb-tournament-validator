/**
 * Reads one finished game's replay from the local fork and prints its ordered moments (src/replay); with --out also
 * writes a test fixture of the stream.
 *
 *   pnpm exec tsx scripts/capture-replay.ts --game 999 [--out test/fixtures/replay-999.json]
 *
 * The fixture keeps the game state's teams and players (ids, names, numbers) and every replayed command with its
 * reports and the model changes the derivation reads or that mark time; the per-square UI churn (move squares, track
 * numbers, dice decorations, skill enhancement refreshes) is dropped to keep it small. The reader sends no credential
 * unless FORK_REPLAY_COACH / FORK_REPLAY_PASSWORD_MD5 are set, and nothing it sends is recorded.
 *
 * Only for a finished, non-test-mode game (see src/replay/job.ts: the fork deletes a test-mode game it loads and later
 * evicts). The script checks nothing itself: it is a developer tool.
 */
import { writeFileSync } from "node:fs";
import { readReplay, replayOptionsFromEnv } from "../src/replay/reader.js";

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const gameId = opt("game");
if (!gameId) throw new Error("--game <id> is required");
const out = opt("out");

const NOISE = /^(fieldModel(Add|Remove)(MoveSquare|TrackNumber|DiceDecoration|PushbackSquare|SkillEnhancements)|fieldModelSetPlayerCoordinate|actingPlayerSet(CurrentMove|Strength)|playerResultSetTurnsPlayed)$/;
const commands: unknown[] = [];
let state: unknown;
type Obj = Record<string, unknown>;
const scrubTeam = (t: Obj | undefined) => t && ({
  teamId: t.teamId, teamName: t.teamName, coach: t.coach,
  playerArray: (Array.isArray(t.playerArray) ? t.playerArray as Obj[] : []).map((p) => ({ playerId: p.playerId, playerNr: p.playerNr, playerName: p.playerName })),
});

const result = await readReplay(gameId, {
  ...replayOptionsFromEnv(),
  tap: (command, game) => {
    state ??= game;
    const c = command as Obj;
    const mcl = c.modelChangeList as Obj | undefined;
    const changes = Array.isArray(mcl?.modelChangeArray) ? (mcl!.modelChangeArray as Obj[]).filter((m) => !NOISE.test(String(m.modelChangeId))) : undefined;
    commands.push({ netCommandId: c.netCommandId, commandNr: c.commandNr, ...(changes ? { modelChangeList: { modelChangeArray: changes } } : {}), ...(c.reportList ? { reportList: c.reportList } : {}), ...(c.teamId ? { teamId: c.teamId, player: c.player } : {}) });
  },
});

if (result.status !== "ready") {
  console.log(`game ${gameId}: unavailable (${result.reason})`);
  process.exit(0);
}
const d = result.derivation;
console.log(`game ${gameId}: ${d.moments.length} moments from ${d.commands} commands${d.truncated ? " (truncated)" : ""}`);
console.log(`home ${d.teams.home.name} (${d.teams.home.coach}) · away ${d.teams.away.name} (${d.teams.away.coach})`);
for (const m of d.moments) console.log(`${m.half ? (m.half >= 3 ? "OT" : `H${m.half}`) : "--"} ${m.turn ? `T${m.turn}` : "--"}  ${(m.side ?? "game").padEnd(4)}  ${m.kind.padEnd(12)} ${m.text}`);
if (out) {
  const g = state as Obj;
  const fixture = {
    captured: new Date().toISOString(),
    note: "Replay stream of a finished local-fork game (scripts/capture-replay.ts). UI-only model changes dropped; no credentials.",
    gameState: { gameId: g.gameId, concededLegally: g.concededLegally, teamHome: scrubTeam(g.teamHome as Obj), teamAway: scrubTeam(g.teamAway as Obj) },
    commands,
  };
  writeFileSync(out, `${JSON.stringify(fixture)}\n`);
  console.log(`fixture written: ${out}`);
}
