import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CoachLevel = "player" | "organizer" | "admin";

export interface CoachIdentities {
  discordUserId?: string;
  discordUsername?: string;
  nafName?: string;
  nafId?: string;
  tournamentCoachId?: string;
}

export interface CoachIdentityRecord {
  forkName: string;
  level: CoachLevel;
  banned: boolean;
  silenced: boolean;
  note: string;
  identities: CoachIdentities;
  updatedAt: string;
  updatedBy: string;
}

export interface IdentityStore {
  version: 1;
  coaches: Record<string, CoachIdentityRecord>;
}

export const MAX_FORK_NAME_LENGTH = 40;
export const MAX_IDENTITY_VALUE_LENGTH = 200;
export const MAX_NOTE_LENGTH = 2_000;
export const MAX_IDENTITIES_FILE_BYTES = 1024 * 1024;

const DEFAULT_IDENTITIES_FILE = fileURLToPath(new URL("../../identities.json", import.meta.url));
const LEVELS = new Set<CoachLevel>(["player", "organizer", "admin"]);
const IDENTITY_FIELDS = new Set<keyof CoachIdentities>([
  "discordUserId",
  "discordUsername",
  "nafName",
  "nafId",
  "tournamentCoachId",
]);

const emptyStore = (): IdentityStore => ({ version: 1, coaches: {} });

export function normalizeForkName(forkName: string): string {
  return forkName.trim().toLowerCase();
}

function identitiesFile(): string {
  return process.env.IDENTITIES_FILE ? resolve(process.env.IDENTITIES_FILE) : DEFAULT_IDENTITIES_FILE;
}

export function readIdentities(): IdentityStore {
  try {
    const parsed = JSON.parse(readFileSync(identitiesFile(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !("coaches" in parsed)) return emptyStore();
    const coaches = (parsed as { coaches?: unknown }).coaches;
    if (!coaches || typeof coaches !== "object" || Array.isArray(coaches)) return emptyStore();
    return { version: 1, coaches: coaches as Record<string, CoachIdentityRecord> };
  } catch {
    return emptyStore();
  }
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (value.length > max) throw new Error(`${field} must be at most ${max} characters.`);
  return value;
}

function normalizedRecord(record: CoachIdentityRecord): CoachIdentityRecord {
  if (typeof record.forkName !== "string") throw new Error("forkName must be a string.");
  const forkName = boundedString(record.forkName.trim(), "forkName", MAX_FORK_NAME_LENGTH);
  if (!forkName) throw new Error("forkName is required.");
  if (!LEVELS.has(record.level)) throw new Error("level must be player, organizer, or admin.");
  if (typeof record.banned !== "boolean" || typeof record.silenced !== "boolean")
    throw new Error("banned and silenced must be booleans.");
  if (!record.identities || typeof record.identities !== "object" || Array.isArray(record.identities))
    throw new Error("identities must be an object.");
  const identities: CoachIdentities = {};
  for (const [field, value] of Object.entries(record.identities ?? {})) {
    if (!IDENTITY_FIELDS.has(field as keyof CoachIdentities)) continue;
    if (typeof value !== "string") throw new Error(`identities.${field} must be a string.`);
    identities[field as keyof CoachIdentities] = boundedString(value, `identities.${field}`, MAX_IDENTITY_VALUE_LENGTH);
  }
  return {
    forkName,
    level: record.level,
    banned: record.banned,
    silenced: record.silenced,
    note: boundedString(record.note ?? "", "note", MAX_NOTE_LENGTH),
    identities,
    updatedAt: boundedString(record.updatedAt, "updatedAt", MAX_IDENTITY_VALUE_LENGTH),
    updatedBy: boundedString(record.updatedBy, "updatedBy", MAX_IDENTITY_VALUE_LENGTH),
  };
}

export function upsertIdentity(record: CoachIdentityRecord): IdentityStore {
  const normalized = normalizedRecord(record);
  const key = normalizeForkName(normalized.forkName);
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
