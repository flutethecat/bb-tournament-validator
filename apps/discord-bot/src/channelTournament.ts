/**
 * Derive which tournament package a channel is for from its NAME, so a TO can
 * just name a channel `#09-12-spike` (a date + the tournament) instead of
 * running `/bbbot watch`. Pure + string-only so it is unit-testable; the
 * Discord wiring in index.ts decides what to do with each resolution.
 */

/** A channel whose name is `DD-MM-<slug>` / `MM-DD-<slug>` reads as a tournament channel. */
const DATE_PREFIX = /^\s*\d{1,2}[-_.]\d{1,2}[-_.](.+?)\s*$/;

export interface ChannelResolution {
  /** The name matched the dated tournament-channel format (`NN-NN-<slug>`). */
  looksLikeTournamentChannel: boolean;
  /** The tournament portion of the name (after the date), or the whole name. */
  slug: string;
  /** Packages whose name contains every slug token — 1 = clean match, >1 = ambiguous. */
  candidates: string[];
  /** The single clean match, when exactly one candidate. */
  match?: string;
}

/**
 * Parse the date prefix of a channel name. Channel dates carry no year, so this
 * returns only month/day. `09-12` is read as MM-DD (the documented convention);
 * if the first number can't be a month (>12) it's read as DD-MM instead.
 */
export function parseChannelDate(channelName: string): { month: number; day: number } | null {
  const m = channelName.match(/^\s*(\d{1,2})[-_.](\d{1,2})[-_.]/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const [month, day] = a > 12 && b <= 12 ? [b, a] : [a, b];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

/**
 * Whether a dated channel's tournament date has already passed. With no year in
 * the name we anchor to the occurrence of that month/day NEAREST to today (last
 * year, this year, or next) — so a September tournament reads as upcoming in
 * July and as past in November, not "always expired because Jan is behind us".
 */
export function tournamentDateStatus(
  channelName: string,
  now: Date = new Date(),
): { date: Date; passed: boolean } | null {
  const md = parseChannelDate(channelName);
  if (!md) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dist = (d: Date) => Math.abs(d.getTime() - today.getTime());
  let best = new Date(now.getFullYear() - 1, md.month - 1, md.day);
  for (const yy of [now.getFullYear(), now.getFullYear() + 1]) {
    const cand = new Date(yy, md.month - 1, md.day);
    if (dist(cand) < dist(best)) best = cand;
  }
  return { date: best, passed: best.getTime() < today.getTime() };
}

const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Resolve a channel name against the known package names.
 * A package is a candidate when every token of the channel slug appears (as a
 * substring) in the package's alphanumeric-normalised name — so `spike` matches
 * `Spike! 2026`, and `spike-open` would need both `spike` and `open` present.
 */
export function resolveChannelPackage(
  channelName: string,
  packageNames: string[],
): ChannelResolution {
  const m = channelName.match(DATE_PREFIX);
  const looksLikeTournamentChannel = !!m;
  const slug = (m ? m[1]! : channelName).trim();
  const slugTokens = tokens(slug);
  const candidates = slugTokens.length
    ? packageNames.filter((name) => {
        const norm = alnum(name);
        return slugTokens.every((t) => norm.includes(t));
      })
    : [];
  return {
    looksLikeTournamentChannel,
    slug,
    candidates,
    ...(candidates.length === 1 ? { match: candidates[0] } : {}),
  };
}
