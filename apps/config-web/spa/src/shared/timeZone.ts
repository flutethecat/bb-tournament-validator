// League time zone (owner 11-02): an IANA name picked from a select. The league reads UTC until one is saved; new
// leagues start with the organiser's browser zone. Pure helpers, no DOM.

export const TIME_ZONE_NOTE = "Set your league's time zone. Until then schedules use UTC.";

const FALLBACK_ZONES = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage",
  "Pacific/Honolulu", "America/Toronto", "America/Winnipeg", "America/Edmonton", "America/Vancouver", "America/Halifax", "America/St_Johns",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Australia/Sydney",
];

/** IANA time zones for a select (the browser's list when it has one, else a short list); `current` is always listed. */
export function timeZones(current?: string | null): string[] {
  let list: string[] = FALLBACK_ZONES;
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    if (typeof intl.supportedValuesOf === "function") list = ["UTC", ...intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  } catch { /* fallback list */ }
  return current && !list.includes(current) ? [current, ...list] : list;
}

/** The organiser's browser zone ("UTC" when the browser does not say). */
export function browserTimeZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof z === "string" && z ? z : "UTC";
  } catch { return "UTC"; }
}
