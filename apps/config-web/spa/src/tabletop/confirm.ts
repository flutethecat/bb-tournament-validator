// The "assign to <player>?" confirmation shown before a picked event is posted: its title and the SPP this event would earn. The SPP values come
// from the server (the match GET's sppValues); the client keeps no table of its own, only the mapping from an event type to the server's key.

export const EVENT_VERB: Record<string, string> = {
  touchdown: "touchdown", casualty: "casualty", injury: "injury", completion: "completion", catch: "catch", interception: "interception",
  deflection: "deflection", foul: "foul", sentOff: "sent-off", stalling: "stalling", mvp: "MVP", throwTeamMate: "throw team-mate",
};
/** Event type -> the server's SPP value key. Events with no key earn no SPP. */
const SPP_KEY: Record<string, string> = { touchdown: "touchdown", casualty: "casualty", completion: "completion", interception: "interception", deflection: "deflection", mvp: "mvp" };

/** "ASSIGN TOUCHDOWN TO GUTTER RUNNER 1?" (the name may be an opponent's "#3 Position"). */
export const assignTitle = (type: string, label: string, name: string): string => `ASSIGN ${(EVENT_VERB[type] ?? label).toUpperCase()} TO ${name.toUpperCase()}?`;

/** The SPP the event earns the player: the server's value for it, nothing for a Star or Mercenary, nothing for a casualty that is not by block. */
export function sppGain(type: string, kind: string | undefined, values: Readonly<Record<string, number>> | undefined, cause?: string): number {
  const key = SPP_KEY[type];
  if (!key || !values) return 0;
  if (kind === "star" || kind === "mercenary") return 0;
  if (type === "casualty" && cause !== undefined && cause !== "block") return 0;
  return values[key] ?? 0;
}
