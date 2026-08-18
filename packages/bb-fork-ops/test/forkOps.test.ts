import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildForkJnlp,
  coachSecretDigest,
  forkConfigFromEnv,
  forkDbConfigFromEnv,
  isMd5Hex,
  jnlpFilename,
} from "@bb/fork-ops";

const md5 = (s: string): string => createHash("md5").update(s, "utf8").digest("hex");

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

  // --- Credential carrier (owner security ruling 08-17). `-passwordMd5` is preferred so the
  // coach's clear-text password never lands in a downloaded file on their disk. Neither
  // spelling is upstream wire — upstream's ClientParameters has no password argument at all
  // and throws on unknown ones — so this rename costs nothing in parity.

  it("carries a pre-hashed credential as -passwordMd5, with no clear text anywhere", () => {
    const digest = md5("hunter2");
    const jnlp = buildForkJnlp({ coach: "A", teamId: "1", gameName: "G", passwordMd5: digest });
    expect(jnlp).toContain(`<argument>-passwordMd5</argument><argument>${digest}</argument>`);
    expect(jnlp).not.toContain("hunter2");
    expect(jnlp).not.toContain("-password<");
  });

  it("prefers the digest over a clear-text password when both are supplied", () => {
    const digest = md5("hunter2");
    const jnlp = buildForkJnlp({ coach: "A", teamId: "1", gameName: "G", password: "hunter2", passwordMd5: digest });
    expect(jnlp).toContain(`<argument>-passwordMd5</argument><argument>${digest}</argument>`);
    expect(jnlp).not.toContain("hunter2</argument>");
  });

  it("normalizes a digest to lower case", () => {
    const digest = md5("hunter2");
    const jnlp = buildForkJnlp({ coach: "A", teamId: "1", gameName: "G", passwordMd5: digest.toUpperCase() });
    expect(jnlp).toContain(`<argument>-passwordMd5</argument><argument>${digest}</argument>`);
  });

  it("falls back to the legacy -password argument for a malformed digest", () => {
    // Back-compat must not become a silent trapdoor: a junk digest is not quietly emitted
    // as a credential the fork could never match. It falls back to the documented legacy
    // path, which callers can still see and the deprecation counter still records.
    const jnlp = buildForkJnlp({ coach: "A", teamId: "1", gameName: "G", passwordMd5: "junk", password: "hunter2" });
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

describe("coachSecretDigest — dual-accept credential normalization", () => {
  it("passes a valid digest through, lower-cased, and marks it non-legacy", () => {
    const digest = md5("hunter2");
    expect(coachSecretDigest({ passwordMd5: digest.toUpperCase() })).toEqual({ digest, legacy: false });
  });

  it("hashes a clear-text password and flags it legacy for the migration counter", () => {
    expect(coachSecretDigest({ password: "hunter2" })).toEqual({ digest: md5("hunter2"), legacy: true });
  });

  it("prefers the digest when both carriers arrive", () => {
    const digest = md5("hunter2");
    expect(coachSecretDigest({ passwordMd5: digest, password: "something-else" })).toEqual({ digest, legacy: false });
  });

  it("reports no credential at all rather than inventing one", () => {
    expect(coachSecretDigest({})).toEqual({ digest: undefined, legacy: false });
    expect(coachSecretDigest({ password: "" })).toEqual({ digest: undefined, legacy: false });
  });

  it("throws on a malformed digest instead of double-hashing it", () => {
    // The failure mode this guards: md5("not-a-digest") is a perfectly well-formed digest
    // that matches nothing, so the error would surface as an inexplicable wrong-password.
    for (const bad of ["not-a-digest", md5("x").slice(0, 31), `${md5("x")}ff`, "gg".repeat(16)]) {
      expect(() => coachSecretDigest({ passwordMd5: bad })).toThrow(/32-character hex/);
    }
  });
});

describe("isMd5Hex", () => {
  it("accepts exactly 32 hex characters, either case", () => {
    expect(isMd5Hex(md5("x"))).toBe(true);
    expect(isMd5Hex(md5("x").toUpperCase())).toBe(true);
  });

  it("rejects wrong lengths, non-hex, and absent values", () => {
    expect(isMd5Hex(md5("x").slice(0, 31))).toBe(false);
    expect(isMd5Hex(`${md5("x")}0`)).toBe(false);
    expect(isMd5Hex("gg".repeat(16))).toBe(false);
    expect(isMd5Hex("")).toBe(false);
    expect(isMd5Hex(undefined)).toBe(false);
    expect(isMd5Hex(null)).toBe(false);
  });
});
