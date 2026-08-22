import { describe, expect, it } from "vitest";
import { JsonBodyError, readJsonBody } from "../src/requestBody.js";

async function* chunks(...values: string[]): AsyncGenerator<Buffer> {
  for (const value of values) yield Buffer.from(value);
}

describe("readJsonBody", () => {
  it("parses a bounded streamed JSON object", async () => {
    await expect(readJsonBody(chunks('{"team":', '"123"}'), 64)).resolves.toEqual({ team: "123" });
  });

  it("maps malformed JSON to a 400-class error", async () => {
    await expect(readJsonBody(chunks('{"team":'), 64)).rejects.toMatchObject({ status: 400 } satisfies Partial<JsonBodyError>);
  });

  it("stops oversized bodies with 413 while streaming", async () => {
    await expect(readJsonBody(chunks("12345", "67890"), 8)).rejects.toMatchObject({ status: 413 } satisfies Partial<JsonBodyError>);
  });
});
