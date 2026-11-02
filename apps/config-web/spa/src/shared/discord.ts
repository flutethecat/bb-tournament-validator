// Competition Discord (league, season, tournament): the read model the server answers (src/discord/api.ts) and the pure
// helpers the panels use. No DOM. The webhook URL is a secret: the server only ever answers it masked.

export interface DiscordCatalogueRow { key: string; label: string; group: "competition" | "inGame" }

export interface WeeklySettings {
  enabled: boolean;
  trigger: "schedule" | "afterRound";
  day: number;
  time: string;
  everyWeeks: 1 | 2 | 4;
  timeZone: string;
  weekdays: readonly string[];
}

export interface CompetitionDiscordView {
  kind: "league" | "season" | "ladder" | "tournament";
  type: "league" | "tournament";
  name: string;
  draft: boolean;
  configured: boolean;
  maskedUrl: string;
  inherited: boolean;
  parentMaskedUrl: string;
  events: Record<string, boolean>;
  live: Record<string, boolean>;
  endOfGameDigest: boolean;
  comments: boolean;
  catalogue: DiscordCatalogueRow[];
  weekly?: WeeklySettings;
  botInviteUrl?: string;
  seasons?: Array<{ id: string; name: string }>;
}

export interface EmbedPayload {
  embeds: Array<{ title: string; description: string; fields?: Array<{ name: string; value: string; inline?: boolean }>; footer?: { text: string } }>;
}

export interface DigestPreview { preview: EmbedPayload | null; reason: string | null; period: { from: string; to: string } }

export interface SampleOutcome { ok: boolean; posted: number; failed: number; total: number }

/** Discord webhook URL shape (the server is the authority). */
export const isDiscordWebhook = (v: string): boolean =>
  /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/.test(v.trim());

/** The catalogue split into its two groups, in catalogue order. */
export function groupCatalogue(rows: readonly DiscordCatalogueRow[]): { competition: DiscordCatalogueRow[]; inGame: DiscordCatalogueRow[] } {
  return { competition: rows.filter((r) => r.group === "competition"), inGame: rows.filter((r) => r.group === "inGame") };
}

/** Only the keys that changed (the PATCH merges). */
export function changedKeys(next: Record<string, boolean>, prior: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(next)) if (prior[k] !== v) out[k] = v;
  return out;
}

/** The webhook line a panel shows. */
export function webhookLine(v: Pick<CompetitionDiscordView, "kind" | "configured" | "maskedUrl" | "inherited" | "parentMaskedUrl">): string {
  if (v.configured) return `Posting to ${v.maskedUrl}`;
  const parent = v.kind === "tournament" ? "the series" : "the league";
  if (v.inherited) return `No webhook of its own: posts go to ${parent}'s webhook (${v.parentMaskedUrl}).`;
  return v.kind === "league" ? "Not connected." : `No webhook of its own, and ${parent} has none: nothing posts yet.`;
}

/** The result line after "Send samples of every event". */
export function samplesLine(o: SampleOutcome): string {
  if (!o.failed) return `Sent ${o.posted} sample${o.posted === 1 ? "" : "s"}. Check the channel.`;
  return `Sent ${o.posted} of ${o.total} samples; ${o.failed} did not go through.`;
}

const FALLBACK_ZONES = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage", "America/Toronto",
  "America/Vancouver", "America/Halifax", "America/St_Johns", "Europe/London", "Europe/Paris", "Europe/Berlin", "Australia/Sydney",
];

/** IANA time zones for the league time-zone select (the browser's list when it has one). */
export function timeZones(current?: string): string[] {
  let list: string[] = FALLBACK_ZONES;
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    if (typeof intl.supportedValuesOf === "function") list = ["UTC", ...intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  } catch { /* fallback list */ }
  return current && !list.includes(current) ? [current, ...list] : list;
}

// ---- registration DM notice ----

export interface DiscordReach { dm: "on" | "off" | "unlinked" | "inactive"; sharesServer: boolean | null; inviteUrl: string | null; accountUrl: string }

export const DM_NOTICE = "We'll message you about this event on Discord. You can turn this off in Account.";
export const JOIN_NOTICE = "Join the Super FUMBBL Discord to get messages";

/** What the registration notice shows: the DM line (DMs on), and the invite line when the coach shares no server with the bot. */
export function reachLines(r: DiscordReach | null): { dm: boolean; invite: string | null } {
  if (!r || r.dm === "off" || r.dm === "unlinked") return { dm: false, invite: null };
  return { dm: true, invite: r.sharesServer === false && r.inviteUrl ? r.inviteUrl : null };
}

// ---- coach's comments ----

export const COMMENT_MAX = 120;
export const commentLength = (s: string): number => [...s].length;
export interface MatchComment { text: string; at: string; hidden?: { by: string; at: string } }
