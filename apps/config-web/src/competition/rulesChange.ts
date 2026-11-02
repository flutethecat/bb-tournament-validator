/**
 * A ruleset or house-rules change on a competition that already has registered coaches (creation wizards v2, owner grill
 * 2026-11-02 Q2 / round 3): the organiser MUST explain it in a 10-500 character message, which the server requires (400
 * without it). Every registered coach gets an inbox note and a Discord DM with the message plus a site-generated list of
 * what changed (rulesChangeDiff, built from the settings, never from the organiser's text); the change is logged in the
 * competition news; rosters are re-validated at once. After round 1 (tournaments) or season start (leagues) the request
 * must also carry `confirmAfterStart: true` (the "Are you sure?" dialog), or it is refused with 409.
 *
 * Pure and dependency-free (the SPA imports the limits and the diff for its dialog preview).
 */
import { houseRulesRows, type CompetitionKind, type HouseRules } from "./houseRules.js";

export const CHANGE_MESSAGE_MIN = 10;
export const CHANGE_MESSAGE_MAX = 500;
export const CHANGE_MESSAGE_REQUIRED = `Explain the rules change to your coaches (${CHANGE_MESSAGE_MIN} to ${CHANGE_MESSAGE_MAX} characters).`;
export const CONFIRM_AFTER_START_TOURNAMENT = "Round 1 has started. Confirm that you want to change the rules mid-tournament.";
export const CONFIRM_AFTER_START_LEAGUE = "The season has started. Confirm that you want to change the rules mid-season.";

export class ChangeMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeMessageError";
  }
}

/** The organiser's message, trimmed and with control characters removed; throws with the field's error text. */
export function parseChangeMessage(raw: unknown): string {
  if (typeof raw !== "string") throw new ChangeMessageError(CHANGE_MESSAGE_REQUIRED);
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  const n = [...text].length;
  if (n < CHANGE_MESSAGE_MIN || n > CHANGE_MESSAGE_MAX) throw new ChangeMessageError(CHANGE_MESSAGE_REQUIRED);
  return text;
}

export interface RulesState {
  packageName: string;
  houseRules: HouseRules;
}

/** What changed, one plain line per setting ("Ruleset: A -> B", "Prayers to Nuffle: As the ruleset says -> Banned"). */
export function rulesChangeDiff(kind: CompetitionKind, before: RulesState, after: RulesState, label: (packageName: string) => string = (n) => n || "BB2025"): string[] {
  const out: string[] = [];
  if (before.packageName !== after.packageName) out.push(`Ruleset: ${label(before.packageName)} → ${label(after.packageName)}`);
  const was = houseRulesRows(before.houseRules, kind);
  const now = houseRulesRows(after.houseRules, kind);
  now.forEach((row, i) => {
    const old = was[i];
    if (old && old.k === row.k && old.v !== row.v) out.push(`${row.k}: ${old.v} → ${row.v}`);
  });
  return out;
}

/** The inbox / DM body: the organiser's message, then the site's list of what changed. */
export function rulesChangeBody(message: string, diff: readonly string[]): string {
  return `${message}\n\nWhat changed:\n${diff.map((line) => `- ${line}`).join("\n")}`;
}

/** The news post (the competition's news log). */
export function rulesChangeNews(message: string, diff: readonly string[], afterStart: boolean): { title: string; body: string } {
  return { title: afterStart ? "Rules changed during play" : "Rules changed", body: rulesChangeBody(message, diff) };
}
