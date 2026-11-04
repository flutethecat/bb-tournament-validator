// POST /api/bug-reports/status through the session gate (AUTH_SIDECAR_ENABLED=1, src/auth/requireSession.ts).
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { requireSession } from "../src/auth/requireSession.js";
import { bugReportStatusSuite } from "./bugReportStatusShared.js";

describe("requireSession public list", () => {
  it("lets an anonymous POST /api/bug-reports/status through, and only POST", () => {
    const req = (method: string) => ({ method, headers: {} }) as unknown as IncomingMessage;
    expect(requireSession(req("POST"), "/api/bug-reports/status", "").kind).toBe("allow");
    expect(requireSession(req("GET"), "/api/bug-reports/status", "").kind).toBe("unauthorized");
    expect(requireSession(req("GET"), "/api/bug-reports", "").kind).toBe("unauthorized");
  });
});

bugReportStatusSuite("session gate", true);
