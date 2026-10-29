/**
 * Admin "Testing Suite" (control panel): tools for trying the tabletop recorder without going through the whole flow.
 * Pure (server.ts supplies the gate and the deps). Every route here is organiser/admin only; the gate lives in server.ts.
 *
 *   GET    /api/admin/testing/tools                 the suite's tools (the panel can grow)
 *   GET    /api/admin/testing/tabletop-defaults     env-configured default pair, or null (TABLETOP_TEST_HOME / TABLETOP_TEST_AWAY = "coach|library:<id>")
 *   GET    /api/admin/testing/teams?coach=          a coach's library teams + builder saves (for the pickers; works under the legacy admin password too)
 *   POST   /api/admin/testing/tabletop-match        create a TEST match (same validation and store as POST /api/tabletop/matches)
 *   DELETE /api/admin/testing/tabletop-matches      purge every test-flagged match
 *
 * A test match is flagged `test: true`: its results row is flagged too, and the results store never counts such a row
 * (standings, Elo, records), even if the match is published.
 */

import { createMatch, type TabletopApiDeps, type TabletopResult } from "./api.js";
import type { MatchTimers } from "./clock.js";
import { DEFAULT_TURN_TIMER_POLICY } from "./clock.js";
import { parseTeamRef } from "./teamFile.js";

export const isAdminTestingPath = (path: string): boolean => path === "/api/admin/testing" || path.startsWith("/api/admin/testing/");

const err = (status: number, error: string): TabletopResult => ({ status, body: { error } });

export const TESTING_TOOLS = [
  {
    id: "tabletop-test-match",
    name: "Tabletop test match",
    description: "Load a recorder match from two chosen teams without the normal flow; test matches never count in standings, Elo or results.",
    endpoints: {
      defaults: "GET /api/admin/testing/tabletop-defaults",
      teams: "GET /api/admin/testing/teams?coach=<name>",
      create: "POST /api/admin/testing/tabletop-match",
      purge: "DELETE /api/admin/testing/tabletop-matches",
    },
  },
] as const;

/** "coach|library:<id>" (or save:<id>) -> {coach, team}; undefined when unset or malformed. */
export function parseDefaultSide(raw: string | undefined): { coach: string; team: string } | undefined {
  if (!raw) return undefined;
  const bar = raw.indexOf("|");
  if (bar < 1) return undefined;
  const coach = raw.slice(0, bar).trim();
  const ref = parseTeamRef(raw.slice(bar + 1));
  return coach && ref ? { coach, team: ref.kind === "library" ? ref.ref : `save:${ref.id}` } : undefined;
}

export async function testingApi(
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  ctx: { me: string; env?: Record<string, string | undefined> },
  deps: TabletopApiDeps,
  now: () => Date = () => new Date(),
): Promise<TabletopResult | undefined> {
  if (!isAdminTestingPath(path)) return undefined;

  if (path === "/api/admin/testing/tools") {
    if (method !== "GET") return err(405, "Method not allowed.");
    return { status: 200, body: { tools: TESTING_TOOLS } };
  }

  if (path === "/api/admin/testing/tabletop-defaults") {
    if (method !== "GET") return err(405, "Method not allowed.");
    const env = ctx.env ?? process.env;
    const home = parseDefaultSide(env.TABLETOP_TEST_HOME);
    const away = parseDefaultSide(env.TABLETOP_TEST_AWAY);
    return { status: 200, body: { defaults: home && away ? { home, away } : null } };
  }

  if (path === "/api/admin/testing/teams") {
    if (method !== "GET") return err(405, "Method not allowed.");
    const coach = query.get("coach")?.trim() ?? "";
    if (!coach || coach.length > 60) return err(400, "coach is required.");
    const saves = (deps.listSaves?.(coach) ?? []).map((s) => ({ id: s.id, name: s.name }));
    const teams = (deps.listTeams?.(coach) ?? saves.map((x) => ({ ref: x.id, name: x.name, race: "", tv: null })))
      .map((t) => ({ ref: t.ref, name: t.name, race: t.race, tv: t.tv }));
    return { status: 200, body: { coach, teams } };
  }

  if (path === "/api/admin/testing/tabletop-match") {
    if (method !== "POST") return err(405, "Method not allowed.");
    const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
    if (b.fixtureRef !== undefined) return err(400, "A test match cannot be linked to a fixture.");
    // Test matches walk the full pre-game like every other match unless the organiser explicitly asks to skip it.
    const pregame = b.pregame === undefined ? "full" : b.pregame;
    if (pregame !== "skip" && pregame !== "full") return err(400, 'pregame must be "skip" or "full".');
    const postMatch = b.postMatch === undefined ? "none" : b.postMatch;
    if (postMatch !== "none" && postMatch !== "spp-only" && postMatch !== "full") return err(400, "postMatch must be none, spp-only or full.");
    let timers: MatchTimers | undefined;
    if (b.turnTimer !== undefined) {
      const t = b.turnTimer;
      if (!t || t.mode !== "on") return err(400, 'turnTimer must be {mode: "on", seconds}.');
      const seconds = t.seconds === undefined ? DEFAULT_TURN_TIMER_POLICY.seconds : t.seconds;
      if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) return err(400, "turnTimer.seconds must be a whole number from 30 to 3600.");
      timers = { mode: "on", seconds, enforced: "optional" };
    }
    const created = await createMatch(
      ctx.me, true,
      { home: b.home, away: b.away, postMatch, ...(pregame === "skip" ? { pregame: "skip" } : {}), ...(b.allowOvertime === true ? { allowOvertime: true } : {}) },
      deps, now, { test: true, ...(timers ? { timers } : {}) },
    );
    if (created.status !== 201) return created;
    const id = (created.body as { match: { id: string } }).match.id;
    return { status: 201, body: { matchId: id, url: `/app/tabletop/${id}` } };
  }

  if (path === "/api/admin/testing/tabletop-matches") {
    if (method !== "DELETE") return err(405, "Method not allowed.");
    let purged = 0;
    for (const m of await deps.repo.listMatches()) {
      if (m.test !== true) continue;
      if (m.resultGameId) deps.results.remove(m.resultGameId);
      await deps.repo.deleteMatch(m.id);
      purged += 1;
    }
    return { status: 200, body: { purged } };
  }

  return err(404, "Not found.");
}
