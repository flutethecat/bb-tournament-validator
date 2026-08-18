import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `listCoachGames` opens its own `mysql2/promise` connection per call (see `withConn` in
// src/index.ts) — mock the driver so the SQL text/params are inspectable without a live DB.
const executeMock = vi.fn();
const endMock = vi.fn();
vi.mock("mysql2/promise", () => ({
  default: {
    createConnection: vi.fn(async () => ({ execute: executeMock, end: endMock })),
  },
}));

const { listCoachGames } = await import("../src/index.js");

const CFG = { dbHost: "h", dbPort: 3306, dbUser: "u", dbPassword: "p", dbName: "d" };

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 42,
    scheduled: null,
    started: new Date("2026-08-01T00:00:00Z"),
    finished: null,
    coach_home: "Gondra87",
    team_home_id: "1",
    team_home_name: "Home Team",
    coach_away: "Rival",
    team_away_id: "2",
    team_away_name: "Away Team",
    half: 2,
    turn: 8,
    status: "A",
    ...overrides,
  };
}

beforeEach(() => {
  executeMock.mockReset();
  endMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("listCoachGames", () => {
  it("defaults to scope=active: status set O/S/A/P, ORDER BY started, no LIMIT, no `finished` key on rows", async () => {
    executeMock.mockResolvedValue([[row()]]);
    const games = await listCoachGames(CFG, "Gondra87");
    expect(games).toHaveLength(1);
    expect(games[0]).not.toHaveProperty("finished");
    expect(games[0]!.gameId).toBe(42);
    expect(games[0]!.status).toBe("active");

    const [sql] = executeMock.mock.calls[0]!;
    expect(sql).toContain("status IN ('O','S','A','P')");
    expect(sql).toContain("ORDER BY started DESC, id DESC");
    expect(sql).not.toContain("LIMIT");
  });

  it("passing scope explicitly as 'active' produces the identical query and row shape as the default call", async () => {
    executeMock.mockResolvedValue([[row()]]);
    await listCoachGames(CFG, "Gondra87");
    const defaultSql = executeMock.mock.calls[0]![0];
    executeMock.mockClear();
    executeMock.mockResolvedValue([[row()]]);
    await listCoachGames(CFG, "Gondra87", "active");
    const explicitSql = executeMock.mock.calls[0]![0];
    expect(explicitSql).toBe(defaultSql);
  });

  it("scope=finished: status set F/U/B, ORDER BY finished, LIMIT 50, rows carry `finished`", async () => {
    executeMock.mockResolvedValue([
      [row({ status: "F", finished: new Date("2026-08-10T12:00:00Z") })],
    ]);
    const games = await listCoachGames(CFG, "Gondra87", "finished");
    expect(games).toHaveLength(1);
    expect(games[0]!.status).toBe("finished");
    expect(games[0]!.finished).toBe("2026-08-10T12:00:00.000Z");

    const [sql] = executeMock.mock.calls[0]!;
    expect(sql).toContain("status IN ('F','U','B')");
    expect(sql).toContain("ORDER BY finished DESC, id DESC LIMIT 50");
  });

  it("scope=finished with a null finished timestamp maps to null, not undefined", async () => {
    executeMock.mockResolvedValue([[row({ status: "U", finished: null })]]);
    const games = await listCoachGames(CFG, "Gondra87", "finished");
    expect(games[0]!.finished).toBeNull();
    expect(games[0]).toHaveProperty("finished");
  });

  it("empty coach short-circuits without querying the DB, in either scope", async () => {
    expect(await listCoachGames(CFG, "  ")).toEqual([]);
    expect(await listCoachGames(CFG, "", "finished")).toEqual([]);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
