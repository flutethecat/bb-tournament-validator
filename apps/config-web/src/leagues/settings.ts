/**
 * League settings (/app/leagues/:id/settings): validation of each tab's section and the organiser read model.
 *
 * Sections (PATCH /api/leagues/:id/settings, one or more per call, all validated before anything is written):
 *   administration  { addOrganiser?, removeOrganiser?, owner? }   owner / admin change organisers; only an admin the owner
 *   information     { name, fullName, description, ruleset, mode, address }
 *   registrations   { allowedRosters, allowRegistration, hideTeamComposition, maxRegistrations, maxPerRace }
 *   teamBuilding    { seasonId, rosters: [{ roster, tier, treasury, startingSkills }] }   saved on the season's rules
 *   connections     { playOnFork?, discord?: { url?: string | null, events? } }
 *
 * The Discord URL never appears in the read model (maskWebhookUrl) and never in an error message.
 */
import { bb2025 } from "@bb/validator/dataset";
import { discordEvents, isDiscordWebhookUrl, maskWebhookUrl } from "./discord.js";
import { leagueOwner } from "./store.js";
import {
  DISCORD_EVENT_KEYS, LEAGUE_RULESETS, type DiscordEvents, type LeagueAddress, type LeagueCountry, type LeagueRecord, type LeagueRegistrations,
  type LeagueRuleset, type LeagueSecrets, type SeasonRecord, type TeamBuildingRosterRule, type TeamBuildingRules,
} from "./types.js";

export class SettingsError extends Error {
  constructor(readonly status: number, message: string, readonly field?: string) {
    super(message);
  }
}

// ---- address (US / Canada) ----

export const US_STATES: ReadonlyArray<[string, string]> = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"],
  ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"],
  ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"],
  ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"],
  ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"], ["PR", "Puerto Rico"],
];
export const CA_PROVINCES: ReadonlyArray<[string, string]> = [
  ["AB", "Alberta"], ["BC", "British Columbia"], ["MB", "Manitoba"], ["NB", "New Brunswick"], ["NL", "Newfoundland and Labrador"],
  ["NS", "Nova Scotia"], ["NT", "Northwest Territories"], ["NU", "Nunavut"], ["ON", "Ontario"], ["PE", "Prince Edward Island"],
  ["QC", "Quebec"], ["SK", "Saskatchewan"], ["YT", "Yukon"],
];
export const REGIONS: Record<LeagueCountry, ReadonlyArray<[string, string]>> = { US: US_STATES, CA: CA_PROVINCES };

export const US_ZIP = /^\d{5}(?:-\d{4})?$/;
/** Canadian postal code: letters D F I O Q U never used, W Z never first; case and the middle space are tolerated. */
export const CA_POSTAL = /^([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s?(\d[ABCEGHJ-NPRSTV-Z]\d)$/;

/** The postcode in its stored form ("12345", "12345-6789", "K1A 0B1"), or undefined when it is not valid for the country. */
export function normalisePostcode(country: LeagueCountry, raw: string): string | undefined {
  const v = raw.trim();
  if (country === "US") return US_ZIP.test(v) ? v : undefined;
  const m = CA_POSTAL.exec(v.toUpperCase());
  return m ? `${m[1]} ${m[2]}` : undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const str = (v: unknown, field: string, max: number, required = false): string => {
  if (v === undefined || v === null) {
    if (required) throw new SettingsError(400, `${field} is required.`, field);
    return "";
  }
  if (typeof v !== "string") throw new SettingsError(400, `${field} must be text.`, field);
  const t = v.replace(CONTROL, "").trim();
  if (required && !t) throw new SettingsError(400, `${field} is required.`, field);
  if (t.length > max) throw new SettingsError(400, `${field} must be at most ${max} characters.`, field);
  return t;
};

const bool = (v: unknown, field: string): boolean => {
  if (typeof v !== "boolean") throw new SettingsError(400, `${field} must be true or false.`, field);
  return v;
};

const int = (v: unknown, field: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new SettingsError(400, `${field} must be a whole number from ${min} to ${max}.`, field);
  return v;
};

const obj = (v: unknown, field: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SettingsError(400, `${field} must be an object.`, field);
  return v as Record<string, unknown>;
};

/** Validates an address (every field optional except the country); the region must belong to the country. */
export function parseAddress(raw: unknown): LeagueAddress | undefined {
  if (raw === undefined || raw === null) return undefined;
  const a = obj(raw, "address");
  const country = a.country;
  if (country !== "US" && country !== "CA") throw new SettingsError(400, "Country must be United States or Canada.", "address.country");
  const region = str(a.region, "State or province", 2).toUpperCase();
  if (region && !REGIONS[country].some(([code]) => code === region))
    throw new SettingsError(400, country === "US" ? "Pick a US state." : "Pick a Canadian province or territory.", "address.region");
  const rawPost = str(a.postcode, "Postcode", 12);
  const postcode = rawPost ? normalisePostcode(country, rawPost) : "";
  if (postcode === undefined)
    throw new SettingsError(400, country === "US" ? "ZIP code must be 5 digits or 5+4 (12345 or 12345-6789)." : "Postal code must look like A1A 1A1.", "address.postcode");
  return { country, region, postcode, locality: str(a.locality, "City", 80), street: str(a.street, "Street", 120) };
}

// ---- registrations ----

export const DEFAULT_REGISTRATIONS: LeagueRegistrations = {
  allowedRosters: { official: true, nafApproved: true, unofficial: false },
  allowRegistration: false,
  hideTeamComposition: false,
  maxRegistrations: null,
  maxPerRace: null,
};

export const registrationsOf = (league: Pick<LeagueRecord, "registrations">): LeagueRegistrations => ({
  ...DEFAULT_REGISTRATIONS,
  ...(league.registrations ?? {}),
  allowedRosters: { ...DEFAULT_REGISTRATIONS.allowedRosters, ...(league.registrations?.allowedRosters ?? {}) },
});

const limit = (v: unknown, field: string, max: number): number | null => (v === null || v === 0 ? null : int(v, field, 1, max));

export function parseRegistrations(raw: unknown, prior: LeagueRegistrations): LeagueRegistrations {
  const r = obj(raw, "registrations");
  const next = structuredClone(prior);
  if (r.allowedRosters !== undefined) {
    const a = obj(r.allowedRosters, "allowedRosters");
    for (const k of ["official", "nafApproved", "unofficial"] as const) if (a[k] !== undefined) next.allowedRosters[k] = bool(a[k], `allowedRosters.${k}`);
    if (!next.allowedRosters.official && !next.allowedRosters.nafApproved && !next.allowedRosters.unofficial)
      throw new SettingsError(400, "Allow at least one kind of roster.", "allowedRosters");
  }
  if (r.allowRegistration !== undefined) next.allowRegistration = bool(r.allowRegistration, "allowRegistration");
  if (r.hideTeamComposition !== undefined) next.hideTeamComposition = bool(r.hideTeamComposition, "hideTeamComposition");
  if (r.maxRegistrations !== undefined) next.maxRegistrations = limit(r.maxRegistrations, "Max registrations", 512);
  if (r.maxPerRace !== undefined) next.maxPerRace = limit(r.maxPerRace, "Max per race", 64);
  if (next.maxRegistrations !== null && next.maxPerRace !== null && next.maxPerRace > next.maxRegistrations)
    throw new SettingsError(400, "Max per race cannot be more than max registrations.", "maxPerRace");
  return next;
}

// ---- information ----

export interface InformationPatch {
  name?: string;
  fullName?: string;
  description?: string;
  ruleset?: LeagueRuleset;
  mode?: "individual";
  address?: LeagueAddress | null;
}

export function parseInformation(raw: unknown): InformationPatch {
  const i = obj(raw, "information");
  const out: InformationPatch = {};
  if (i.name !== undefined) out.name = str(i.name, "Name", 40, true);
  if (i.fullName !== undefined) out.fullName = str(i.fullName, "Full name", 120);
  if (i.description !== undefined) out.description = str(i.description, "Description", 2000);
  if (i.ruleset !== undefined) {
    if (!LEAGUE_RULESETS.includes(i.ruleset as LeagueRuleset)) throw new SettingsError(400, "Ruleset must be BB2020 or BB2025.", "ruleset");
    out.ruleset = i.ruleset as LeagueRuleset;
  }
  if (i.mode !== undefined) {
    if (i.mode !== "individual") throw new SettingsError(400, "Mode must be individual.", "mode");
    out.mode = "individual";
  }
  if (i.address !== undefined) out.address = i.address === null ? null : parseAddress(i.address) ?? null;
  return out;
}

// ---- team building ----

export const ELITE_SKILLS = ["Block", "Guard", "Mighty Blow", "Dodge"] as const;
export const DEFAULT_TREASURY_K = 1000;
export const STARTING_SKILLS_MAX = 6;

/** The rosters a season's team building table lists (the BB2025 dataset; BB2020 seasons use the same roster names). */
export function datasetRosters(): Array<{ roster: string; tier: number }> {
  return bb2025.teams.map((t) => ({ roster: t.name, tier: Math.min(6, Math.max(1, Math.round(Number(t.defaultTier) || 1))) }));
}

export const defaultRosterRule = (roster: string, tier: number): TeamBuildingRosterRule => ({
  roster, tier, treasury: DEFAULT_TREASURY_K, startingSkills: { primary: 0, secondary: 0, elite: 0 },
});

/** The season's table: every dataset roster, the league's saved row when it has one, else the dataset default. */
export function teamBuildingTable(season: Pick<SeasonRecord, "rules"> | undefined): TeamBuildingRules {
  const tb = season?.rules?.teamBuilding;
  const saved = new Map((tb?.rosters ?? []).map((r) => [r.roster, r]));
  return {
    rosters: datasetRosters().map(({ roster, tier }) => saved.get(roster) ?? defaultRosterRule(roster, tier)),
    eliteSkills: [...(tb?.eliteSkills ?? ELITE_SKILLS)],
    ...(tb?.updatedAt ? { updatedAt: tb.updatedAt } : {}),
    ...(tb?.updatedBy ? { updatedBy: tb.updatedBy } : {}),
  };
}

export function parseTeamBuilding(raw: unknown): { seasonId: string; rosters: TeamBuildingRosterRule[] } {
  const t = obj(raw, "teamBuilding");
  const seasonId = str(t.seasonId, "seasonId", 64, true);
  if (!Array.isArray(t.rosters)) throw new SettingsError(400, "rosters must be a list.", "rosters");
  const known = new Set(datasetRosters().map((r) => r.roster));
  const seen = new Set<string>();
  const rosters = t.rosters.map((row, i) => {
    const r = obj(row, `rosters[${i}]`);
    const roster = str(r.roster, "Roster", 60, true);
    if (!known.has(roster)) throw new SettingsError(400, `Unknown roster "${roster}".`, `rosters[${i}].roster`);
    if (seen.has(roster)) throw new SettingsError(400, `${roster} is listed twice.`, `rosters[${i}].roster`);
    seen.add(roster);
    const skills = obj(r.startingSkills ?? {}, `${roster} starting skills`);
    return {
      roster,
      tier: int(r.tier, `${roster} tier`, 1, 6),
      treasury: int(r.treasury, `${roster} initial treasury`, 0, 5000),
      startingSkills: {
        primary: int(skills.primary ?? 0, `${roster} primary skills`, 0, STARTING_SKILLS_MAX),
        secondary: int(skills.secondary ?? 0, `${roster} secondary skills`, 0, STARTING_SKILLS_MAX),
        elite: int(skills.elite ?? 0, `${roster} elite skills`, 0, STARTING_SKILLS_MAX),
      },
    };
  });
  return { seasonId, rosters };
}

// ---- connections ----

export interface ConnectionsPatch {
  playOnFork?: boolean;
  /** undefined = leave; null = clear; string = a checked webhook URL. */
  discordUrl?: string | null;
  discordEvents?: DiscordEvents;
}

export function parseConnections(raw: unknown, prior: DiscordEvents): ConnectionsPatch {
  const c = obj(raw, "connections");
  const out: ConnectionsPatch = {};
  if (c.playOnFork !== undefined) out.playOnFork = bool(c.playOnFork, "playOnFork");
  if (c.discord !== undefined) {
    const d = obj(c.discord, "discord");
    if (d.url !== undefined) {
      if (d.url === null || d.url === "") out.discordUrl = null;
      // The message never echoes the value: it is a secret even when malformed.
      else if (!isDiscordWebhookUrl(d.url)) throw new SettingsError(400, "That is not a Discord webhook URL (https://discord.com/api/webhooks/...).", "discord.url");
      else out.discordUrl = (d.url as string).trim();
    }
    if (d.events !== undefined) {
      const e = obj(d.events, "discord.events");
      const next = { ...prior };
      for (const k of DISCORD_EVENT_KEYS) if (e[k] !== undefined) next[k] = bool(e[k], `discord.events.${k}`);
      out.discordEvents = next;
    }
  }
  return out;
}

// ---- read model ----

export interface PermissionsView {
  owner: string;
  organisers: string[];
  /** Site admins (identity level admin): read-only here. */
  admins: string[];
  /** The viewer may add / remove organisers (owner or admin). */
  canEditOrganisers: boolean;
  /** The viewer may change the owner (admins only). */
  canChangeOwner: boolean;
}

export interface LeagueSettingsView {
  id: string;
  revision: number;
  information: { name: string; fullName: string; description: string; ruleset: LeagueRuleset; mode: "individual"; address: LeagueAddress | null };
  permissions: PermissionsView;
  registrations: LeagueRegistrations;
  connections: {
    playOnFork: boolean;
    discord: { configured: boolean; maskedUrl: string; events: DiscordEvents };
    naf: { available: false; note: string };
  };
  teamBuilding: { seasonId: string; seasonName: string; ruleset: LeagueRuleset; rules: TeamBuildingRules } | null;
  regions: Record<LeagueCountry, Array<{ code: string; name: string }>>;
  rulesets: readonly LeagueRuleset[];
  eliteSkills: readonly string[];
}

export const NAF_LEAGUE_NOTE = "NAF results reporting is available for tournaments only. League reporting will follow once the NAF supports it.";

export function settingsView(
  league: LeagueRecord,
  secrets: LeagueSecrets,
  seasons: SeasonRecord[],
  viewer: { coach: string; admin: boolean },
  admins: string[],
  seasonId?: string,
): LeagueSettingsView {
  const owner = leagueOwner(league);
  const isOwner = Boolean(owner) && owner.toLowerCase() === viewer.coach.trim().toLowerCase();
  const season = (seasonId ? seasons.find((s) => s.id === seasonId) : undefined) ?? [...seasons].sort((a, b) => b.number - a.number)[0];
  return {
    id: league.id,
    revision: league.revision ?? 0,
    information: {
      name: league.name, fullName: league.fullName, description: league.description,
      ruleset: league.ruleset ?? "BB2025", mode: "individual", address: league.address ?? null,
    },
    permissions: {
      owner,
      organisers: league.organisers.filter((o) => o.trim().toLowerCase() !== owner.toLowerCase()),
      admins: [...admins].sort((a, b) => a.localeCompare(b)),
      canEditOrganisers: viewer.admin || isOwner,
      canChangeOwner: viewer.admin,
    },
    registrations: registrationsOf(league),
    connections: {
      playOnFork: league.playOnFork === true,
      discord: { configured: Boolean(secrets.discordWebhookUrl), maskedUrl: maskWebhookUrl(secrets.discordWebhookUrl), events: discordEvents(league) },
      naf: { available: false, note: NAF_LEAGUE_NOTE },
    },
    teamBuilding: season ? { seasonId: season.id, seasonName: season.name, ruleset: season.ruleset, rules: teamBuildingTable(season) } : null,
    regions: { US: US_STATES.map(([code, name]) => ({ code, name })), CA: CA_PROVINCES.map(([code, name]) => ({ code, name })) },
    rulesets: LEAGUE_RULESETS,
    eliteSkills: ELITE_SKILLS,
  };
}
