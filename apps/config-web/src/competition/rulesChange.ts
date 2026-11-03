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
  /** League only: the base ruleset (BB2025 / BB2020) when no package is picked. */
  ruleset?: string;
}

/** What changed, one plain line per setting ("Ruleset: A -> B", "Prayers to Nuffle: As the ruleset says -> Banned"). */
export function rulesChangeDiff(kind: CompetitionKind, before: RulesState, after: RulesState, label: (packageName: string) => string = (n) => n || "BB2025"): string[] {
  const out: string[] = [];
  if (before.packageName !== after.packageName) out.push(`Ruleset: ${label(before.packageName)} → ${label(after.packageName)}`);
  if ((before.ruleset ?? "") !== (after.ruleset ?? "") && before.ruleset !== undefined && after.ruleset !== undefined) out.push(`Base ruleset: ${before.ruleset} → ${after.ruleset}`);
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

/** One organiser's change as the coaches hear about it. `from` / `to` are the settings before and after it, so a combined
 *  notice can describe the net change of a whole window. */
export interface RulesNotice {
  message: string;
  diff: string[];
  afterStart: boolean;
  actor: string;
  from?: RulesState;
  to?: RulesState;
}

/** What goes out: the change(s) combined; `count` = how many changes it covers; `messages` = every organiser message. */
export type RulesNoticeSender = (notice: RulesNotice & { count: number; messages: string[] }) => void;

export const RULES_NOTICE_WINDOW_MS = 10 * 60 * 1000;
export const NO_NET_CHANGE = "No setting differs overall: the later changes undid the earlier ones.";

interface NoticeWindow {
  until: number;
  pending: RulesNotice[];
  send: RulesNoticeSender;
  diffOf?: (from: RulesState, to: RulesState) => string[];
}

/**
 * Coalesces rules-change notices per competition (Sol P2): the first change in a quiet competition goes out at once; every
 * later change within the window is held and goes out as ONE combined notice when the window closes: every organiser
 * message, and the NET change from the first held change's starting settings to the latest settings (so A->B, B->A, A->B
 * reads A->B). A change arriving after a window expired first flushes anything still held, then starts a new window, so
 * nothing is dropped. A burst of edits sends each coach at most one note, one DM and one news post per window. Held notices
 * live in memory: a restart inside a window drops them (re-validation already happened).
 */
export class RulesChangeCoalescer {
  private readonly open = new Map<string, NoticeWindow>();
  constructor(
    private readonly windowMs = RULES_NOTICE_WINDOW_MS,
    private readonly schedule: (fn: () => void, ms: number) => void = (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); },
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** "sent" = went out now; "held" = joins the combined notice at the end of the window. `diffOf` builds a net change. */
  submit(key: string, notice: RulesNotice, send: RulesNoticeSender, diffOf?: (from: RulesState, to: RulesState) => string[]): "sent" | "held" {
    const w = this.open.get(key);
    if (w && this.clock() < w.until) {
      w.pending.push(notice);
      w.send = send;
      if (diffOf) w.diffOf = diffOf;
      return "held";
    }
    // An expired window (its timer not run yet) sends what it holds first.
    if (w) this.flush(key, false);
    this.start(key, send, diffOf);
    send({ ...notice, count: 1, messages: notice.message ? [notice.message] : [] });
    return "sent";
  }

  /** Close the window: send the held changes as one notice (and keep throttling for another window if it sent). */
  flush(key: string, reopen = true): void {
    const w = this.open.get(key);
    this.open.delete(key);
    if (!w || !w.pending.length) return;
    const first = w.pending[0]!;
    const last = w.pending[w.pending.length - 1]!;
    let diff: string[];
    if (w.diffOf && first.from && last.to) {
      diff = w.diffOf(first.from, last.to);
      if (!diff.length) diff = [NO_NET_CHANGE];
    } else {
      diff = [];
      for (const n of w.pending) for (const line of n.diff) if (!diff.includes(line)) diff.push(line);
    }
    const messages = w.pending.map((n) => n.message).filter(Boolean);
    if (reopen) this.start(key, w.send, w.diffOf);
    w.send({ message: messages.join("\n\n"), messages, diff, afterStart: w.pending.some((n) => n.afterStart), actor: last.actor, count: w.pending.length, ...(first.from ? { from: first.from } : {}), ...(last.to ? { to: last.to } : {}) });
  }

  private start(key: string, send: RulesNoticeSender, diffOf?: NoticeWindow["diffOf"]): void {
    const at = this.clock();
    this.open.set(key, { until: at + this.windowMs, pending: [], send, ...(diffOf ? { diffOf } : {}) });
    this.schedule(() => { const w = this.open.get(key); if (w && w.until === at + this.windowMs) this.flush(key); }, this.windowMs);
  }
}

/** The process-wide coalescer (tournament and league routes); tests pass their own. */
export const rulesNotices = new RulesChangeCoalescer();
