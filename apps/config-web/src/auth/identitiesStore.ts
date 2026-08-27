import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CoachLevel = "player" | "organizer" | "admin";

export interface CoachIdentities {
  discordUserId?: string;
  discordUsername?: string;
  discordAvatarHash?: string;
  email?: string;
  nafName?: string;
  nafId?: string;
  tournamentCoachId?: string;
}

export interface CoachProfile {
  displayName?: string;
  avatar?: string;
  [key: string]: string | undefined;
}

export interface CoachScheduling {
  timezone?: string;
  availability?: Array<{ day: string; start: string; end: string }>;
}

export interface CoachIdentityRecord {
  ffbCoachId: string;
  level: CoachLevel;
  banned: boolean;
  silenced: boolean;
  note: string;
  profile: CoachProfile;
  scheduling?: CoachScheduling;
  identities: CoachIdentities;
  updatedAt: string;
  updatedBy: string;
}

export interface IdentityStore {
  version: 1;
  coaches: Record<string, CoachIdentityRecord>;
}

export const MAX_FFB_COACH_ID_LENGTH = 40;
export const MAX_IDENTITY_VALUE_LENGTH = 200;
export const MAX_PROFILE_KEY_LENGTH = 100;
export const MAX_PROFILE_VALUE_LENGTH = 500;
export const MAX_PROFILE_KEYS = 32;
export const MAX_TIMEZONE_LENGTH = 64;
export const MAX_AVAILABILITY_ENTRIES = 60;
export const MAX_NOTE_LENGTH = 2_000;
export const MAX_IDENTITIES_FILE_BYTES = 1024 * 1024;

const DEFAULT_IDENTITIES_FILE = fileURLToPath(new URL("../../identities.json", import.meta.url));
const LEVELS = new Set<CoachLevel>(["player", "organizer", "admin"]);
const DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const IDENTITY_FIELDS = new Set<keyof CoachIdentities>([
  "discordUserId",
  "discordUsername",
  "discordAvatarHash",
  "email",
  "nafName",
  "nafId",
  "tournamentCoachId",
]);

const emptyStore = (): IdentityStore => ({ version: 1, coaches: {} });

export function normalizeFfbCoachId(ffbCoachId: string): string {
  return ffbCoachId.trim().toLowerCase();
}

function identitiesFile(): string {
  return process.env.IDENTITIES_FILE ? resolve(process.env.IDENTITIES_FILE) : DEFAULT_IDENTITIES_FILE;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (value.length > max) throw new Error(`${field} must be at most ${max} characters.`);
  return value;
}

export function normalizedProfile(value: unknown, field = "profile"): CoachProfile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object.`);
  const entries = Object.entries(value);
  if (entries.length > MAX_PROFILE_KEYS)
    throw new Error(`${field} must have at most ${MAX_PROFILE_KEYS} keys.`);
  return Object.fromEntries(entries.map(([key, item]) => {
    boundedString(key, `${field} key`, MAX_PROFILE_KEY_LENGTH);
    return [key, boundedString(item, `${field}.${key}`, MAX_PROFILE_VALUE_LENGTH)];
  }));
}

export function normalizedScheduling(value: unknown, field = "scheduling"): CoachScheduling | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object.`);
  const scheduling = value as Record<string, unknown>;
  const timezone = scheduling.timezone === undefined
    ? undefined
    : boundedString(scheduling.timezone, `${field}.timezone`, MAX_TIMEZONE_LENGTH).trim() || undefined;
  let availability: CoachScheduling["availability"];
  if (scheduling.availability !== undefined) {
    if (!Array.isArray(scheduling.availability))
      throw new Error(`${field}.availability must be an array.`);
    if (scheduling.availability.length > MAX_AVAILABILITY_ENTRIES)
      throw new Error(`${field}.availability must have at most ${MAX_AVAILABILITY_ENTRIES} entries.`);
    availability = scheduling.availability.map((value, index) => {
      const itemField = `${field}.availability[${index}]`;
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${itemField} must be an object.`);
      const item = value as Record<string, unknown>;
      if (typeof item.day !== "string" || !DAYS.has(item.day.toLowerCase()))
        throw new Error(`${itemField}.day must be one of mon, tue, wed, thu, fri, sat, or sun.`);
      const day = item.day.toLowerCase();
      const start = boundedString(item.start, `${itemField}.start`, 5);
      const end = boundedString(item.end, `${itemField}.end`, 5);
      if (!LOCAL_TIME.test(start)) throw new Error(`${itemField}.start must be a 24-hour time in HH:MM format.`);
      if (!LOCAL_TIME.test(end)) throw new Error(`${itemField}.end must be a 24-hour time in HH:MM format.`);
      return { day, start, end };
    });
  }
  if (!timezone && !availability?.length) return undefined;
  return {
    ...(timezone ? { timezone } : {}),
    ...(availability?.length ? { availability } : {}),
  };
}

function normalizedRecord(value: unknown, allowLegacy = false): CoachIdentityRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("identity record must be an object.");
  const record = value as Record<string, unknown>;
  const rawFfbCoachId = record.ffbCoachId ?? (allowLegacy ? record.forkName : undefined);
  if (typeof rawFfbCoachId !== "string") throw new Error("ffbCoachId must be a string.");
  const ffbCoachId = boundedString(rawFfbCoachId.trim(), "ffbCoachId", MAX_FFB_COACH_ID_LENGTH);
  if (!ffbCoachId) throw new Error("ffbCoachId is required.");
  if (!LEVELS.has(record.level as CoachLevel)) throw new Error("level must be player, organizer, or admin.");
  if (typeof record.banned !== "boolean" || typeof record.silenced !== "boolean")
    throw new Error("banned and silenced must be booleans.");
  if (!record.identities || typeof record.identities !== "object" || Array.isArray(record.identities))
    throw new Error("identities must be an object.");
  const identities: CoachIdentities = {};
  for (const [identityField, item] of Object.entries(record.identities)) {
    if (!IDENTITY_FIELDS.has(identityField as keyof CoachIdentities)) continue;
    identities[identityField as keyof CoachIdentities] = boundedString(
      item,
      `identities.${identityField}`,
      MAX_IDENTITY_VALUE_LENGTH,
    );
  }
  const scheduling = record.scheduling === undefined
    ? undefined
    : normalizedScheduling(record.scheduling);
  return {
    ffbCoachId,
    level: record.level as CoachLevel,
    banned: record.banned,
    silenced: record.silenced,
    note: boundedString(record.note ?? "", "note", MAX_NOTE_LENGTH),
    profile: normalizedProfile(record.profile ?? {}),
    ...(scheduling ? { scheduling } : {}),
    identities,
    updatedAt: boundedString(record.updatedAt, "updatedAt", MAX_IDENTITY_VALUE_LENGTH),
    updatedBy: boundedString(record.updatedBy, "updatedBy", MAX_IDENTITY_VALUE_LENGTH),
  };
}

export function readIdentities(): IdentityStore {
  try {
    const parsed = JSON.parse(readFileSync(identitiesFile(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !("coaches" in parsed)) return emptyStore();
    const coaches = (parsed as { coaches?: unknown }).coaches;
    if (!coaches || typeof coaches !== "object" || Array.isArray(coaches)) return emptyStore();
    const normalized: Record<string, CoachIdentityRecord> = {};
    for (const value of Object.values(coaches)) {
      try {
        const record = normalizedRecord(value, true);
        normalized[normalizeFfbCoachId(record.ffbCoachId)] = record;
      } catch {
        // A malformed record must not invalidate unrelated coaches.
      }
    }
    return { version: 1, coaches: normalized };
  } catch {
    return emptyStore();
  }
}

export function ownIdentityRecord(coach: string): CoachIdentityRecord {
  const ffbCoachId = boundedString(coach.trim(), "ffbCoachId", MAX_FFB_COACH_ID_LENGTH);
  if (!ffbCoachId) throw new Error("ffbCoachId is required.");
  const previous = readIdentities().coaches[normalizeFfbCoachId(ffbCoachId)];
  return previous
    ? { ...previous, ffbCoachId }
    : {
        ffbCoachId,
        level: "player",
        banned: false,
        silenced: false,
        note: "",
        profile: {},
        identities: {},
        updatedAt: "",
        updatedBy: "",
      };
}

export function updateOwnAccount(coach: string, body: unknown, now = new Date()): CoachIdentityRecord {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("A JSON object is required.");
  const patch = body as Record<string, unknown>;
  const hasProfile = "profile" in patch;
  const hasScheduling = "scheduling" in patch;
  if (!hasProfile && !hasScheduling) throw new Error("profile or scheduling is required.");
  const previous = ownIdentityRecord(coach);
  const profile = hasProfile
    ? normalizedProfile({ ...previous.profile, ...normalizedProfile(patch.profile, "profile") })
    : previous.profile;
  const scheduling = hasScheduling
    ? normalizedScheduling(patch.scheduling, "scheduling")
    : previous.scheduling;
  const { scheduling: _previousScheduling, ...base } = previous;
  return upsertIdentity({
    ...base,
    profile,
    ...(scheduling ? { scheduling } : {}),
    updatedAt: now.toISOString(),
    updatedBy: previous.ffbCoachId,
  }).coaches[normalizeFfbCoachId(previous.ffbCoachId)]!;
}

export function upsertIdentity(record: CoachIdentityRecord): IdentityStore {
  const normalized = normalizedRecord(record);
  const key = normalizeFfbCoachId(normalized.ffbCoachId);
  const current = readIdentities();
  const store: IdentityStore = {
    version: 1,
    coaches: { ...current.coaches, [key]: normalized },
  };
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_IDENTITIES_FILE_BYTES)
    throw new Error(`identities store must be at most ${MAX_IDENTITIES_FILE_BYTES} bytes.`);

  const target = identitiesFile();
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });
  const temp = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
  return store;
}
