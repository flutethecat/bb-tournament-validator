import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { coachAccountClaimed } from "@bb/fork-ops";
import {
  DISCORD_SSO_TTL_MS,
  PendingSsoStore,
  coachNameAvailable,
  sessionOwnsCoach,
  shouldBlockExistingRegistration,
} from "../src/auth/discordSso.js";
import { requireSession } from "../src/auth/requireSession.js";

const anonymousRequest = (): IncomingMessage => ({ method: "GET", headers: {} }) as IncomingMessage;

describe("pending Discord SSO store", () => {
  it("round-trips a pending identity without exposing mutable store state", () => {
    const store = new PendingSsoStore();
    const identity = {
      discordId: "123456789",
      discordUsername: "Tarkin",
      discordAvatarHash: "avatar-hash",
      email: "tarkin@example.test",
    };
    const token = store.create(identity, 1_000);

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(store.get(token, 1_001)).toEqual(identity);
    expect(store.get("not-a-token", 1_001)).toBeUndefined();
  });

  it("expires pending identities at the ten-minute TTL", () => {
    const store = new PendingSsoStore();
    const token = store.create({ discordId: "1", discordUsername: "Fives" }, 5_000);

    expect(store.get(token, 5_000 + DISCORD_SSO_TTL_MS - 1)).toBeDefined();
    expect(store.get(token, 5_000 + DISCORD_SSO_TTL_MS)).toBeUndefined();
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
