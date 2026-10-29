// Account page Identity panel (/app/account): GET/PATCH /api/me/profile. The signed-in coach's own identity record
// only, written through the identities store (src/auth/identitiesStore.ts, atomic temp-file + rename). Pure functions;
// server.ts wires them to the session and the bot's coach registry.
//
// Where each field lives (so nothing diverges from what other readers already use):
// - displayName  -> record.profile.displayName ("" = show the coach name).
// - fumbblName   -> record.profile.fumbblName, a claim only. The tournament coach registry (the bot's coaches.json,
//                   read through linkedFumbblName) stays authoritative: when it links a name, that name is shown and
//                   the field is locked; config-web never writes the bot's file.
// - nafName/nafId -> record.identities.nafName / nafId, the fields the NAF rating scrape and the organiser NAF route
//                   already use. They stay editable here; changing either clears a NAF verification
//                   (record.connections.naf, written by POST /api/me/connections/naf, src/auth/connections.ts).
// - avatar       -> read-only: record.profile.avatar (set by an admin) else the Discord avatar.

import { connectionsAfterIdentityEdit, isNafId, ownIdentityRecord, upsertIdentity, normalizeFfbCoachId, withConnections, type CoachIdentityRecord } from "./auth/identitiesStore.js";
import { connectionsView, type ConnectionView } from "./auth/connections.js";

export const DISPLAY_NAME_MAX = 32;
export const FUMBBL_NAME_MAX = 40;
export const NAF_NAME_MAX = 60;

/** Letters (any script), digits, spaces and . _ ' - ; must start with a letter or digit. */
const DISPLAY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;
/** FUMBBL account names: letters, digits, spaces and . _ - . */
const FUMBBL_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const NAF_NAME = DISPLAY_NAME;

export interface ProfileView {
  coach: string;
  /** "" = not set (the page shows the coach name). */
  displayName: string;
  /** The name shown: the registry link when there is one, else the coach's own claim ("" = none). */
  fumbblName: string;
  /** True when the tournament registry links the FUMBBL name (the field is read-only then). */
  fumbblLinked: boolean;
  nafName: string;
  nafId: string;
  avatar: string | null;
  avatarSource: "profile" | "discord" | "none";
  discord: { linked: boolean; username: string };
  /** The Connections table (Discord, NAF, FUMBBL), src/auth/connections.ts. */
  connections: ConnectionView[];
}

export class ProfileError extends Error {}

export interface ProfileDeps {
  /** The registry-linked FUMBBL name (server.ts linkedFumbblName), null when none. */
  linkedFumbblName: (coach: string, discordUserId: string) => string | null;
  discordAvatarUrl: (discordUserId: string, hash: string | undefined) => string | null | undefined;
}

export function profileView(record: CoachIdentityRecord, deps: ProfileDeps): ProfileView {
  const discordUserId = record.identities.discordUserId ?? "";
  const linked = deps.linkedFumbblName(record.ffbCoachId, discordUserId);
  const own = record.profile.avatar || "";
  const discord = deps.discordAvatarUrl(discordUserId, record.identities.discordAvatarHash) || "";
  return {
    coach: record.ffbCoachId,
    displayName: record.profile.displayName ?? "",
    fumbblName: linked ?? record.profile.fumbblName ?? "",
    fumbblLinked: Boolean(linked),
    nafName: record.identities.nafName ?? "",
    nafId: record.identities.nafId ?? "",
    avatar: own || discord || null,
    avatarSource: own ? "profile" : discord ? "discord" : "none",
    discord: { linked: Boolean(discordUserId), username: record.identities.discordUsername ?? "" },
    connections: connectionsView(record, linked),
  };
}

export interface ProfilePatch { displayName?: string; fumbblName?: string; nafName?: string; nafId?: string }
const FIELDS = new Set<keyof ProfilePatch>(["displayName", "fumbblName", "nafName", "nafId"]);

function text(value: unknown, field: string, max: number, pattern: RegExp, what: string): string {
  if (typeof value !== "string") throw new ProfileError(`${field} must be a string.`);
  const v = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!v) return "";
  if (v.length > max) throw new ProfileError(`${field} must be at most ${max} characters.`);
  if (!pattern.test(v)) throw new ProfileError(`${field} can use ${what}.`);
  return v;
}

/** Validates a PATCH body. Only the four fields; "" clears one. Unknown keys are refused (a coach can never reach
 *  level, flags, Discord ids or another coach's record through this route). */
export function parseProfilePatch(body: unknown): ProfilePatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProfileError("A JSON object is required.");
  const entries = Object.entries(body as Record<string, unknown>);
  if (!entries.length) throw new ProfileError("Nothing to change.");
  const out: ProfilePatch = {};
  for (const [key, value] of entries) {
    if (!FIELDS.has(key as keyof ProfilePatch)) throw new ProfileError(`${key} is not editable here.`);
    if (key === "displayName") out.displayName = text(value, "Display name", DISPLAY_NAME_MAX, DISPLAY_NAME, "letters, digits, spaces and . _ ' -");
    else if (key === "fumbblName") out.fumbblName = text(value, "FUMBBL name", FUMBBL_NAME_MAX, FUMBBL_NAME, "letters, digits, spaces and . _ -");
    else if (key === "nafName") out.nafName = text(value, "NAF name", NAF_NAME_MAX, NAF_NAME, "letters, digits, spaces and . _ ' -");
    else {
      if (typeof value !== "string") throw new ProfileError("NAF number must be a string.");
      const v = value.trim();
      if (v && !isNafId(v)) throw new ProfileError("NAF number must be 1 to 10 digits.");
      out.nafId = v;
    }
  }
  if (out.displayName && out.displayName.length < 2) throw new ProfileError("Display name must be at least 2 characters.");
  return out;
}

/** Applies a validated patch to the coach's OWN record (the session coach; never a name from the body) and writes it
 *  through the identities store. */
export function updateOwnProfile(coach: string, body: unknown, deps: ProfileDeps, now = new Date()): ProfileView {
  const patch = parseProfilePatch(body);
  const previous = ownIdentityRecord(coach);
  const linked = deps.linkedFumbblName(previous.ffbCoachId, previous.identities.discordUserId ?? "");
  if (patch.fumbblName !== undefined && linked && patch.fumbblName !== linked)
    throw new ProfileError("Your FUMBBL name is linked through tournament registration; ask an organiser to change it.");
  const profile = { ...previous.profile };
  const identities = { ...previous.identities };
  const set = (target: Record<string, string | undefined>, key: string, value: string | undefined) => {
    if (value === undefined) return;
    if (value === "") delete target[key];
    else target[key] = value;
  };
  set(profile, "displayName", patch.displayName);
  // A linked name is the registry's: never copy it into the claim.
  if (!linked) set(profile, "fumbblName", patch.fumbblName);
  set(identities as Record<string, string | undefined>, "nafName", patch.nafName);
  set(identities as Record<string, string | undefined>, "nafId", patch.nafId);
  const store = upsertIdentity({ ...withConnections(previous, connectionsAfterIdentityEdit(previous, identities)), profile, identities, updatedAt: now.toISOString(), updatedBy: previous.ffbCoachId });
  return profileView(store.coaches[normalizeFfbCoachId(previous.ffbCoachId)]!, deps);
}
