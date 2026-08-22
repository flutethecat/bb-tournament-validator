import { describe, expect, it } from "vitest";
import { libraryIngestOwnershipError, parseLibraryIngestRequest } from "../src/teamIngestSecurity.js";
import { teamXmlHasProgressionOrHistory } from "@bb/fork-ops";

describe("Team Library ingest security", () => {
  const owner = { coach: "Tarkin", organizer: false };

  it("requires POST-shaped authenticated data and rejects crafted fields", () => {
    expect(parseLibraryIngestRequest({ team: "42" }, undefined, false)).toMatchObject({ ok: false, status: 401 });
    expect(parseLibraryIngestRequest({ team: "42", coach: "Tarkin", overwrite: true }, owner, false)).toMatchObject({ ok: false, status: 400 });
    expect(parseLibraryIngestRequest({ team: "42", coach: "Other" }, owner, false)).toMatchObject({ ok: false, status: 403 });
  });

  it("scopes ordinary coaches to matching source ownership", () => {
    const decision = parseLibraryIngestRequest({ team: "42" }, owner, false);
    if (!decision.ok) throw new Error(decision.error);
    expect(libraryIngestOwnershipError(decision, "tArKiN")).toBeUndefined();
    expect(libraryIngestOwnershipError(decision, "Other")).toMatch(/matching FUMBBL/);
  });

  it("limits destructive recovery to organizer/admin and marks it explicitly", () => {
    expect(parseLibraryIngestRequest({ team: "42", recovery: true }, owner, false)).toMatchObject({ ok: false, status: 403 });
    expect(parseLibraryIngestRequest({ coach: "Tarkin", team: "42", recovery: true }, undefined, true)).toMatchObject({ ok: true, allowRecovery: true });
  });

  it("detects progression/history while allowing pristine composed XML", () => {
    expect(teamXmlHasProgressionOrHistory('<team><player id="p"><playerStatistics currentSpps="0"><games>0</games></playerStatistics><injuryList/></player></team>')).toBe(false);
    expect(teamXmlHasProgressionOrHistory('<team><player id="p"><playerStatistics currentSpps="1"/></player></team>')).toBe(true);
    expect(teamXmlHasProgressionOrHistory('<team><player id="p"><advancementList><advancement cost="6"/></advancementList></player></team>')).toBe(true);
    expect(teamXmlHasProgressionOrHistory('<team><player id="p"><skillList><skill>Wrestle</skill></skillList></player></team>')).toBe(true);
    expect(teamXmlHasProgressionOrHistory('<team><player id="p"><injuryList><injury recovering="true">SmashedKnee</injury></injuryList></player></team>')).toBe(true);
  });
});
