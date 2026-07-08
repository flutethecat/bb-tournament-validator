import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildForkJnlp, forkConfigFromEnv, forkDbConfigFromEnv, jnlpFilename } from "@bb/fork-ops";

const FORK_ENV_KEYS = [
  "FORK_DB_HOST",
  "FORK_DB_PORT",
  "FORK_DB_USER",
  "FORK_DB_PASSWORD",
  "FORK_DB_NAME",
  "FORK_TEAMS_DIR",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(FORK_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of FORK_ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of FORK_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("buildForkJnlp", () => {
  it("builds the fork-join arguments in order, defaulting the password", () => {
    const jnlp = buildForkJnlp({ coach: "Gondra87", teamId: "1264703", gameName: "TestGame1" });
    expect(jnlp).toContain("<argument>-player</argument><argument>-fork</argument>");
    expect(jnlp).toContain("<argument>-coach</argument><argument>Gondra87</argument>");
    expect(jnlp).toContain("<argument>-password</argument><argument>12345</argument>");
    expect(jnlp).toContain("<argument>-gameName</argument><argument>TestGame1</argument>");
    expect(jnlp).toContain("<argument>-teamId</argument><argument>1264703</argument>");
    expect(jnlp).toContain("FUMBBL40k fork - TestGame1 (Gondra87)");
  });

  it("uses an explicit password when given", () => {
    const jnlp = buildForkJnlp({ coach: "A", teamId: "1", gameName: "G", password: "hunter2" });
    expect(jnlp).toContain("<argument>-password</argument><argument>hunter2</argument>");
  });

  it("never embeds a fork host", () => {
    const jnlp = buildForkJnlp({ coach: "A", teamId: "1", gameName: "G" });
    expect(jnlp).not.toMatch(/https?:\/\//);
  });

  it("XML-escapes coach and game name", () => {
    const jnlp = buildForkJnlp({ coach: "A & <B>", teamId: "1", gameName: "G's \"Cup\"" });
    expect(jnlp).toContain("A &amp; &lt;B&gt;");
    expect(jnlp).toContain("G&apos;s &quot;Cup&quot;");
  });

  it("produces a filesystem-safe filename", () => {
    expect(jnlpFilename("Test Game 1", "Gondra87")).toBe("fork_Test_Game_1_Gondra87.jnlp");
  });

  it("strips path separators from the filename (the actual traversal vector)", () => {
    // A bare ".." with no adjacent separator can't traverse directories; "/" and "\" are
    // what matters, and those must never survive into the filename.
    const name = jnlpFilename("../../etc", "A/B\\C");
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name.endsWith(".jnlp")).toBe(true);
  });
});

describe("forkDbConfigFromEnv", () => {
  it("is undefined when FORK_DB_HOST is unset (opt-in signal)", () => {
    expect(forkDbConfigFromEnv()).toBeUndefined();
  });

  it("reads FORK_DB_* with sane defaults for the rest", () => {
    process.env.FORK_DB_HOST = "127.0.0.1";
    expect(forkDbConfigFromEnv()).toEqual({
      dbHost: "127.0.0.1",
      dbPort: 3316,
      dbUser: "ffb",
      dbPassword: "ffb",
      dbName: "ffblive",
    });
  });

  it("honors explicit overrides", () => {
    process.env.FORK_DB_HOST = "10.0.0.5";
    process.env.FORK_DB_PORT = "3317";
    process.env.FORK_DB_USER = "root";
    process.env.FORK_DB_PASSWORD = "secret";
    process.env.FORK_DB_NAME = "otherdb";
    expect(forkDbConfigFromEnv()).toEqual({
      dbHost: "10.0.0.5",
      dbPort: 3317,
      dbUser: "root",
      dbPassword: "secret",
      dbName: "otherdb",
    });
  });
});

describe("forkConfigFromEnv", () => {
  it("is undefined when FORK_TEAMS_DIR is unset, even if FORK_DB_HOST is set", () => {
    process.env.FORK_DB_HOST = "127.0.0.1";
    expect(forkConfigFromEnv()).toBeUndefined();
  });

  it("defaults DB fields when FORK_DB_HOST is unset (preserves the bot's original behavior)", () => {
    process.env.FORK_TEAMS_DIR = "C:\\fork\\teams";
    expect(forkConfigFromEnv()).toEqual({
      dbHost: "127.0.0.1",
      dbPort: 3316,
      dbUser: "ffb",
      dbPassword: "ffb",
      dbName: "ffblive",
      teamsDir: "C:\\fork\\teams",
    });
  });

  it("combines FORK_TEAMS_DIR with FORK_DB_* overrides when both are set", () => {
    process.env.FORK_TEAMS_DIR = "C:\\fork\\teams";
    process.env.FORK_DB_HOST = "10.0.0.5";
    expect(forkConfigFromEnv()).toEqual({
      dbHost: "10.0.0.5",
      dbPort: 3316,
      dbUser: "ffb",
      dbPassword: "ffb",
      dbName: "ffblive",
      teamsDir: "C:\\fork\\teams",
    });
  });
});
