/**
 * Tournament templates (src/competition/templates.ts TournamentTemplateContent): capture from a tournament (Manage →
 * "Save as template"). The wizard's Review sends the same shape as a body; both go through
 * parseTournamentTemplateContent, so a capture can carry nothing the parser would not accept.
 *
 * Captured: the ruleset reference, house rules, format, rounds, pairing, seeding, turn timer, the tiebreaker chain, the
 * points scheme, pairing avoidance, regions, where it is played, places, approval, waitlist, roster later, self
 * check-in, NAF sanctioned, the entry fee text, the registration / roster / check-in times RELATIVE to the start, the
 * Discord event toggles and (optional) the owner's payment links. Never: the Discord webhook URL, entrants, entries,
 * rounds, results, news, the banner, the venue address or the summary text.
 */
import { tiebreakerChainOf } from "../competition/format.js";
import { houseRulesOf } from "../competition/houseRules.js";
import { minutesBefore, parseTournamentTemplateContent, type TournamentContentOptions, type TournamentTemplateContent } from "../competition/templates.js";
import { eventKeysFor } from "../discord/catalogue.js";
import { parsePayField } from "../payments/links.js";
import type { TournamentRecord } from "../tournaments/types.js";

export const tournamentContentOptions = (): TournamentContentOptions => ({ eventKeys: eventKeysFor("tournament"), payField: parsePayField });

/** Check-in opens 24 h before the start when the tournament leaves it blank (the registration core's default). */
export function captureTournament(t: TournamentRecord, discordEvents: Record<string, boolean> | undefined, includePayLinks: boolean): TournamentTemplateContent {
  const reg = t.registration;
  const start = t.startsAt;
  const pay = includePayLinks && (t.payPal || t.venmo) ? { ...(t.payPal ? { payPal: t.payPal } : {}), ...(t.venmo ? { venmo: t.venmo } : {}) } : undefined;
  const raw = {
    packageName: t.packageName,
    houseRules: houseRulesOf(t, "tournament"),
    format: t.format,
    roundCount: t.format === "swiss" && t.roundCountExplicit ? t.roundCount : null,
    pairingSystem: t.format === "swiss" ? t.pairingSystem ?? null : null,
    seedingMode: t.seedingMode ?? "elo",
    turnTimer: t.turnTimer?.enforced ?? "optional",
    tiebreakers: tiebreakerChainOf(t.tiebreakers),
    points: { win: t.points.win, draw: t.points.draw, loss: t.points.loss },
    pairingAvoid: t.pairingAvoid ?? "none",
    regions: [...(t.regions ?? [])],
    playOnFork: t.playOnFork === true,
    maxPlayers: t.maxPlayers >= 2 ? Math.min(t.maxPlayers, 512) : 16,
    approval: reg?.approval ?? "auto",
    waitlist: reg?.waitlist ?? true,
    rosterLater: reg?.rosterLater ?? true,
    selfCheckIn: reg?.checkIn.self ?? true,
    nafSanctioned: t.nafSanctioned === true,
    entryFee: (t.entryFee ?? "").slice(0, 40),
    relative: {
      registrationOpens: minutesBefore(start, reg?.opensAt),
      registrationCloses: minutesBefore(start, t.deadlines?.registration),
      rosterBy: reg?.rosterLater ? minutesBefore(start, reg.rosterBy) : null,
      checkInOpens: reg?.checkIn.self ? minutesBefore(start, reg.checkIn.opensAt) : null,
      checkInCloses: reg?.checkIn.self ? minutesBefore(start, t.deadlines?.checkIn) : null,
    },
    discordEvents: { ...(discordEvents ?? {}) },
    ...(pay ? { payLinks: pay } : {}),
  };
  return parseTournamentTemplateContent(raw, tournamentContentOptions());
}
