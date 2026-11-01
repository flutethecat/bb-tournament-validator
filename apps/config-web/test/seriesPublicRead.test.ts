import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { requireSession } from "../src/auth/requireSession";

function req(method: string): IncomingMessage {
  return { method, headers: {} } as unknown as IncomingMessage;
}

describe("Tournament Series reads are public under the session gate", () => {
  it("lets anonymous GETs of the list and a series through", () => {
    expect(requireSession(req("GET"), "/api/series", "").kind).not.toBe("unauthorized");
    expect(requireSession(req("GET"), "/api/series/spring-tour", "").kind).not.toBe("unauthorized");
  });
  it("keeps writes and nested paths session-gated", () => {
    expect(requireSession(req("POST"), "/api/series", "").kind).toBe("unauthorized");
    expect(requireSession(req("DELETE"), "/api/series/spring-tour", "").kind).toBe("unauthorized");
    expect(requireSession(req("GET"), "/api/series/spring-tour/tournaments", "").kind).toBe("unauthorized");
  });
});
