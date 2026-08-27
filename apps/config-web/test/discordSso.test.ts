import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coachAccountClaimed } from "@bb/fork-ops";
import {
  DISCORD_SSO_TTL_MS,
  DiscordOauthStateStore,
  PendingSsoStore,
  coachNameAvailable,
  completeDiscordCoachAssociation,
  discordSsoEnabled,
  discordStartHostGuard,
  sessionOwnsCoach,
  shouldBlockExistingRegistration,
  validatedNextPath,
} from "../src/auth/discordSso.js";
import type { CoachIdentityRecord } from "../src/auth/identitiesStore.js";
import { attemptsByCoach, attemptsByIp } from "../src/auth/loginAttempts.js";
import { requireSession } from "../src/auth/requireSession.js";

const anonymousRequest = (): IncomingMessage => ({ method: "GET", headers: {} }) as IncomingMessage;
let testDirectory: string;

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), "config-web-discord-sso-"));
});

afterEach(() => {
  attemptsByIp.clear();
  attemptsByCoach.clear();
  rmSync(testDirectory, { recursive: true, force: true });
});

const storeFile = (name: string): string => join(testDirectory, name);

describe("pending Discord SSO store", () => {
  it("round-trips a pending identity without exposing mutable store state", () => {
    const store = new PendingSsoStore(storeFile("pending.json"));
    const identity = {
      discordId: "123456789",
      discordUsername: "Tarkin",
      discordAvatarHash: "avatar-hash",
      email: "tarkin@example.test",
      next: "/admin.html",
    };
    const token = store.create(identity, 1_000);

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(store.get(token, 1_001)).toEqual(identity);
    expect(store.get("not-a-token", 1_001)).toBeUndefined();
  });

  it("expires pending identities at the ten-minute TTL", () => {
    const store = new PendingSsoStore(storeFile("pending.json"));
    const token = store.create({ discordId: "1", discordUsername: "Fives", next: "/" }, 5_000);

    expect(store.get(token, 5_000 + DISCORD_SSO_TTL_MS - 1)).toBeDefined();
    expect(store.get(token, 5_000 + DISCORD_SSO_TTL_MS)).toBeUndefined();
  });

  it("survives a restart and deletes a completed pending identity from disk", () => {
    const file = storeFile("pending.json");
    const identity = { discordId: "1", discordUsername: "Fives", next: "/" };
    const token = new PendingSsoStore(file).create(identity, 5_000);
    const restarted = new PendingSsoStore(file);

    expect(restarted.get(token, 5_001)).toEqual(identity);
    expect(restarted.delete(token, 5_002)).toBe(true);
    expect(new PendingSsoStore(file).get(token, 5_003)).toBeUndefined();
  });

  it("persists only identity fields and never OAuth token fields", () => {
    const file = storeFile("pending.json");
    const store = new PendingSsoStore(file);
    const token = store.create({
      discordId: "1",
      discordUsername: "Fives",
      email: "fives@example.test",
      next: "/",
      accessToken: "must-not-persist",
      refresh_token: "must-not-persist",
      tokenType: "must-not-persist",
    } as Parameters<PendingSsoStore["create"]>[0] & Record<string, string>, 5_000);

    expect(store.get(token, 5_001)).toEqual({
      discordId: "1",
      discordUsername: "Fives",
      email: "fives@example.test",
      next: "/",
    });
    const persisted = readFileSync(file, "utf8");
    expect(persisted).not.toContain("must-not-persist");
    expect(persisted).not.toMatch(/accessToken|refresh_token|tokenType/);
  });
});

describe("Discord SSO redirect destination", () => {
  it("accepts a same-origin absolute path and rejects unsafe or invalid values", () => {
    expect(validatedNextPath("/admin.html")).toBe("/admin.html");
    expect(validatedNextPath("//evil.com")).toBe("/");
    expect(validatedNextPath("https://evil.com")).toBe("/");
    expect(validatedNextPath("\\evil")).toBe("/");
    expect(validatedNextPath("")).toBe("/");
    expect(validatedNextPath(42)).toBe("/");
  });

  it("binds the destination to one-time server-side OAuth state", () => {
    const store = new DiscordOauthStateStore(storeFile("state.json"));
    const state = store.create("/admin.html", 1_000);

    expect(store.consume(state, 1_001)).toBe("/admin.html");
    expect(store.consume(state, 1_002)).toBeUndefined();
  });

  it("survives a restart and consumes persisted state exactly once", () => {
    const file = storeFile("state.json");
    const state = new DiscordOauthStateStore(file).create("/admin.html", 1_000);
    const restarted = new DiscordOauthStateStore(file);

    expect(restarted.consume(state, 1_001)).toBe("/admin.html");
    expect(new DiscordOauthStateStore(file).consume(state, 1_002)).toBeUndefined();
  });

  it("prunes expired persisted state on load", () => {
    const file = storeFile("state.json");
    const state = new DiscordOauthStateStore(file).create("/admin.html", 1_000);

    expect(new DiscordOauthStateStore(file).has(state, 1_000 + DISCORD_SSO_TTL_MS)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toEqual([]);
  });
});

describe("Discord SSO canonical host guard", () => {
  const config = {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://config.example.test:8443/api/auth/discord/callback",
  };

  it("redirects a mismatched Host to the canonical start URL with the query preserved", () => {
    const query = new URLSearchParams({ next: "/admin.html?tab=users" });

    expect(discordStartHostGuard(config, "localhost:4310", query)).toEqual({
      kind: "redirect",
      status: 302,
      location: "https://config.example.test:8443/api/auth/discord/start?next=%2Fadmin.html%3Ftab%3Dusers",
    });
  });

  it("proceeds when the request Host already matches, regardless of scheme", () => {
    expect(discordStartHostGuard(
      config,
      "config.example.test:8443",
      new URLSearchParams({ next: "/" }),
    )).toEqual({ kind: "proceed" });
  });
});

describe("Discord SSO enabled probe", () => {
  it("requires all three non-empty Discord OAuth environment variables", () => {
    const configured = {
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_OAUTH_REDIRECT_URI: "http://localhost/api/auth/discord/callback",
    };

    expect(discordSsoEnabled(configured)).toBe(true);
    for (const missing of Object.keys(configured)) {
      expect(discordSsoEnabled({ ...configured, [missing]: undefined })).toBe(false);
    }
    expect(discordSsoEnabled({ ...configured, DISCORD_CLIENT_SECRET: "   " })).toBe(false);
  });
});

describe("fork register account-takeover gate", () => {
  it("blocks an existing account for an unauthenticated requester", () => {
    expect(shouldBlockExistingRegistration({
      exists: true,
      requestedCoach: "Tarkin",
      adminAuthed: false,
    })).toBe(true);
  });

  it("allows a new account", () => {
    expect(shouldBlockExistingRegistration({
      exists: false,
      requestedCoach: "Tarkin",
      adminAuthed: false,
    })).toBe(false);
  });

  it("allows an admin to reset an existing account", () => {
    expect(shouldBlockExistingRegistration({
      exists: true,
      requestedCoach: "Tarkin",
      adminAuthed: true,
    })).toBe(false);
  });

  it("allows the authenticated coach case-insensitively", () => {
    expect(shouldBlockExistingRegistration({
      exists: true,
      requestedCoach: "Tarkin",
      sessionCoach: " tarkin ",
      adminAuthed: false,
    })).toBe(false);
  });
});

describe("fork coach-name availability", () => {
  it("reports an existing coach as unavailable", async () => {
    expect(await coachNameAvailable("Tarkin", async (coach) => coach === "Tarkin")).toBe(false);
  });

  it("reports a new coach as available", async () => {
    expect(await coachNameAvailable("Fives", async (coach) => coach === "Tarkin")).toBe(true);
  });

  it("is public while the account endpoint remains session-gated", () => {
    expect(requireSession(anonymousRequest(), "/api/fork/name-available", "?coach=Fives").kind).toBe("allow");
    expect(requireSession(anonymousRequest(), "/api/account", "").kind).toBe("unauthorized");
  });
});

describe("Discord SSO coach ownership association", () => {
  const passwordMd5 = createHash("md5").update("hunter2", "utf8").digest("hex");
  const pending = {
    discordId: "discord-123",
    discordUsername: "Discord Tarkin",
    email: "tarkin@example.test",
    next: "/admin.html",
  };
  const existingIdentity: CoachIdentityRecord = {
    ffbCoachId: "Tarkin",
    level: "organizer",
    banned: false,
    silenced: true,
    note: "Keep this note",
    profile: { displayName: "Grand Moff", theme: "dark" },
    scheduling: { timezone: "America/Los_Angeles" },
    identities: { nafName: "Tarkin NAF" },
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "admin",
  };

  function request(ip = "10.0.0.9"): IncomingMessage {
    return { headers: {}, socket: { remoteAddress: ip }, method: "POST" } as unknown as IncomingMessage;
  }

  function deps(options: {
    identity?: CoachIdentityRecord | null;
    coachExists?: boolean;
    verify?: (coach: string, digest: string) => Promise<boolean>;
    onForkWrite?: () => void;
    onUpsert?: (record: CoachIdentityRecord) => void;
    onSession?: (coach: string) => string;
  } = {}) {
    const identity = options.identity === undefined ? existingIdentity : options.identity;
    return {
      fork: {
        coachExists: async (_coach: string) => options.coachExists ?? true,
        verifyCoachDigest: options.verify ?? (async (coach, digest) => coach === "Tarkin" && digest === passwordMd5),
        createForkAccountDigestIfAvailable: async (_coach: string, _digest: string) => {
          options.onForkWrite?.();
          return true;
        },
      },
      identityForCoach: (coach: string) => coach.trim().toLowerCase() === "tarkin" ? identity ?? undefined : undefined,
      isCoachBanned: (coach: string) => coach.trim().toLowerCase() === "tarkin" && identity?.banned === true,
      upsertIdentity: (record: CoachIdentityRecord) => { options.onUpsert?.(record); },
      createSessionToken: (coach: string) => options.onSession?.(coach) ?? "session-token",
    };
  }

  it("returns 409 with canLink when an existing unlinked coach has no credential", async () => {
    let verified = false;
    let forkWrites = 0;
    let upserts = 0;
    const result = await completeDiscordCoachAssociation(
      request(),
      pending,
      { ffbCoachId: "tarkin" },
      undefined,
      deps({
        verify: async () => { verified = true; return true; },
        onForkWrite: () => { forkWrites += 1; },
        onUpsert: () => { upserts += 1; },
      }),
    );

    expect(result).toEqual({
      status: 409,
      body: {
        error: "That coach already exists. Enter its fork password to link it without changing the account.",
        canLink: true,
      },
    });
    expect(verified).toBe(false);
    expect(forkWrites).toBe(0);
    expect(upserts).toBe(0);
  });

  it("returns 403 and does not link when the fork password is wrong", async () => {
    let upserts = 0;
    const result = await completeDiscordCoachAssociation(
      request(),
      pending,
      { ffbCoachId: "Tarkin", password: "wrong" },
      undefined,
      deps({ verify: async () => false, onUpsert: () => { upserts += 1; } }),
    );

    expect(result).toEqual({
      status: 403,
      body: { error: "The fork password for that coach is incorrect." },
    });
    expect(upserts).toBe(0);
  });

  it("links a correctly authenticated coach without writing its ffb_coaches digest", async () => {
    let verifiedCoach = "";
    let verifiedDigest = "";
    let forkWrites = 0;
    let linkedRecord: CoachIdentityRecord | undefined;
    const result = await completeDiscordCoachAssociation(
      request(),
      pending,
      { ffbCoachId: "tarkin", password: "hunter2" },
      undefined,
      deps({
        verify: async (coach, digest) => {
          verifiedCoach = coach;
          verifiedDigest = digest;
          return coach === "Tarkin" && digest === passwordMd5;
        },
        onForkWrite: () => { forkWrites += 1; },
        onUpsert: (record) => { linkedRecord = record; },
      }),
      Date.parse("2026-08-27T12:00:00.000Z"),
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, coach: "Tarkin", next: "/admin.html" });
    expect(result.sessionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(verifiedCoach).toBe("Tarkin");
    expect(verifiedDigest).toBe(passwordMd5);
    expect(forkWrites).toBe(0);
    expect(linkedRecord).toEqual({
      ...existingIdentity,
      identities: {
        nafName: "Tarkin NAF",
        discordUserId: "discord-123",
        discordUsername: "Discord Tarkin",
        email: "tarkin@example.test",
      },
      updatedAt: "2026-08-27T12:00:00.000Z",
      updatedBy: "discord-sso",
    });
    expect(JSON.stringify(linkedRecord)).not.toMatch(/hunter2|2ab96390c7db/);
  });

  it("keeps the already-linked Discord auto-login path free of fork DB access", async () => {
    const linkedIdentity: CoachIdentityRecord = {
      ...existingIdentity,
      identities: { ...existingIdentity.identities, discordUserId: pending.discordId },
    };
    let sessions = 0;
    let upserts = 0;
    const linkedDeps = deps({
      identity: linkedIdentity,
      onSession: (coach) => { sessions += 1; return `${coach}-session`; },
      onUpsert: () => { upserts += 1; },
    });
    linkedDeps.fork.coachExists = async () => { throw new Error("fork DB must not be read"); };
    linkedDeps.fork.verifyCoachDigest = async () => { throw new Error("fork password must not be verified"); };
    linkedDeps.fork.createForkAccountDigestIfAvailable = async () => { throw new Error("fork password must not be written"); };

    const result = await completeDiscordCoachAssociation(
      request(),
      pending,
      { ffbCoachId: "ignored", password: "ignored" },
      "Tarkin",
      linkedDeps,
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, coach: "Tarkin", next: "/admin.html" },
      sessionToken: "Tarkin-session",
    });
    expect(sessions).toBe(1);
    expect(upserts).toBe(1);
  });

  it("keeps banned coaches out of both linking and already-linked login", async () => {
    const bannedIdentity = { ...existingIdentity, banned: true };
    let verified = false;
    let sessions = 0;
    let upserts = 0;
    const result = await completeDiscordCoachAssociation(
      request(),
      pending,
      { ffbCoachId: "Tarkin", password: "hunter2" },
      undefined,
      deps({
        identity: bannedIdentity,
        verify: async () => { verified = true; return true; },
        onSession: () => { sessions += 1; return "session-token"; },
        onUpsert: () => { upserts += 1; },
      }),
    );

    expect(result.status).toBe(403);
    expect(result.body.error).toMatch(/banned/i);
    expect(verified).toBe(false);
    expect(sessions).toBe(0);
    expect(upserts).toBe(0);
  });

  it("keeps the generated-digest atomic creation path for a new coach name", async () => {
    let createdCoach = "";
    let generatedDigest = "";
    let upserts = 0;
    const newCoachDeps = deps({
      identity: null,
      coachExists: false,
      onUpsert: () => { upserts += 1; },
      onSession: (coach) => `${coach}-session`,
    });
    newCoachDeps.fork.createForkAccountDigestIfAvailable = async (coach, digest) => {
      createdCoach = coach;
      generatedDigest = digest;
      return true;
    };

    const result = await completeDiscordCoachAssociation(
      request(),
      { ...pending, discordUsername: "Fives" },
      { ffbCoachId: "Fives", password: "must-not-be-used-for-new-account" },
      undefined,
      newCoachDeps,
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, coach: "Fives", next: "/admin.html" },
      sessionToken: "Fives-session",
    });
    expect(createdCoach).toBe("Fives");
    expect(generatedDigest).toMatch(/^[a-f0-9]{32}$/);
    expect(generatedDigest).not.toBe(createHash("md5").update("must-not-be-used-for-new-account").digest("hex"));
    expect(upserts).toBe(1);
  });
});

describe("atomic SSO coach provisioning", () => {
  it("accepts only an inserted row as a successful name claim", () => {
    expect(coachAccountClaimed(1)).toBe(true);
    expect(coachAccountClaimed(0)).toBe(false);
    expect(coachAccountClaimed(2)).toBe(false);
  });
});

describe("authenticated JNLP credential binding", () => {
  it("matches only the authenticated coach, case-insensitively", () => {
    expect(sessionOwnsCoach(" Tarkin ", "tarkin")).toBe(true);
    expect(sessionOwnsCoach("Fives", "Tarkin")).toBe(false);
    expect(sessionOwnsCoach(undefined, "Tarkin")).toBe(false);
  });
});
