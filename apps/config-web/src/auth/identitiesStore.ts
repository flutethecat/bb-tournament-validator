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
  secondaryEmail?: string;
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

/** A NAF record confirmed against the public NAF coach page (src/auth/connections.ts). It proves the record exists and
 *  matches what the coach entered, NOT that the coach owns it: the NAF offers no sign-in or OAuth. Only valid while the
 *  identity's nafId/nafName still equal the verified pair (every writer that changes either drops it). */
export interface NafConnection {
  verifiedAt: string;
  source: "coachpage";
  nafId: string;
  nafName: string;
}

export interface CoachConnections {
  naf?: NafConnection;
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
  /** Verified provider links (Account page Connections). Absent = nothing verified. */
  connections?: CoachConnections;
  updatedAt: string;
  updatedBy: string;
}

export interface IdentityStore {
  version: 1;
  coaches: Record<string, CoachIdentityRecord>;
  /** Discord signups whose fork account is not confirmed yet, keyed by Discord user id. Written BEFORE the fork
   *  insert so an unknown outcome or a restart resumes from it (never a returning-user shortcut). Carried
   *  through every write that does not set it explicitly. */
  provisionalSignups?: Record<string, ProvisionalSignup>;
}

export interface ProvisionalSignup {
  discordUserId: string;
  coachName: string;
  /** The generated fork credential digest: ownership proof (the fork row must carry exactly this digest). */
  generatedDigest: string;
  operationId: string;
  state: "provisional";
  createdAt: string;
  /** Last time a completion worked on this record (resume / insert / failed recovery); the 24 h purge counts from
   *  here, so a recovery that just failed keeps its record usable. */
  lastActiveAt?: string;
}

function normalizedProvisional(value: unknown): ProvisionalSignup | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const str = (x: unknown, max: number) => (typeof x === "string" && x.length > 0 && x.length <= max ? x : undefined);
  const discordUserId = str(v.discordUserId, MAX_IDENTITY_VALUE_LENGTH);
  const coachName = str(v.coachName, MAX_FFB_COACH_ID_LENGTH);
  const generatedDigest = typeof v.generatedDigest === "string" && /^[a-f0-9]{32}$/i.test(v.generatedDigest) ? v.generatedDigest.toLowerCase() : undefined;
  const operationId = str(v.operationId, 64);
  const createdAt = str(v.createdAt, 64) ?? "";
  const lastActiveAt = str(v.lastActiveAt, 64);
  if (!discordUserId || !coachName || !generatedDigest || !operationId || v.state !== "provisional") return undefined;
  return { discordUserId, coachName, generatedDigest, operationId, state: "provisional", createdAt, ...(lastActiveAt ? { lastActiveAt } : {}) };
}

/** Provisional signups older than this, with no operation in flight, are purged (the fork account the attempt may
 *  have created is left on the fork). */
export const PROVISIONAL_SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;
/** Operation ids whose fork insert is in flight in this process (never purged while listed). */
export const activeProvisionalOperations = new Set<string>();

function isStaleProvisional(rec: ProvisionalSignup, now = Date.now()): boolean {
  const created = Date.parse(rec.lastActiveAt ?? rec.createdAt);
  return !activeProvisionalOperations.has(rec.operationId) && (!Number.isFinite(created) || now - created > PROVISIONAL_SIGNUP_TTL_MS);
}

function readProvisionalSection(): Record<string, ProvisionalSignup> {
  try {
    const parsed = JSON.parse(readFileSync(identitiesFile(), "utf8")) as { provisionalSignups?: unknown };
    const raw = parsed?.provisionalSignups;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, ProvisionalSignup> = {};
    for (const value of Object.values(raw)) {
      const rec = normalizedProvisional(value);
      if (rec) out[rec.discordUserId] = rec;
    }
    return out;
  } catch {
    return {};
  }
}

/** The provisional signup of a Discord user, if any. A stale one is purged here (a sign-in reads it). */
export function readProvisionalSignup(discordUserId: string): ProvisionalSignup | undefined {
  const rec = readProvisionalSection()[discordUserId];
  if (rec && isStaleProvisional(rec)) {
    writeIdentityStore(readIdentities()); // the write path purges stale records
    return undefined;
  }
  return rec;
}

/**
 * Confirm a provisional signup in ONE durable write: the identity link is stored and the matching provisional
 * record (same operation id) removed together, so there is never a moment with neither.
 */
export function confirmProvisionalSignup(record: CoachIdentityRecord, discordUserId: string, operationId: string): void {
  const normalized = normalizedRecord(record);
  const current = readIdentities();
  const section = readProvisionalSection();
  if (section[discordUserId]?.operationId === operationId) delete section[discordUserId];
  writeIdentityStore({
    version: 1,
    coaches: { ...current.coaches, [normalizeFfbCoachId(normalized.ffbCoachId)]: normalized },
    provisionalSignups: section,
  });
}

/** Persist (replace) a provisional signup durably, before the fork insert. */
export function putProvisionalSignup(record: ProvisionalSignup): void {
  const rec = normalizedProvisional(record);
  if (!rec) throw new Error("Invalid provisional signup record.");
  const current = readIdentities();
  writeIdentityStore({ ...current, provisionalSignups: { ...readProvisionalSection(), [rec.discordUserId]: rec } });
}

/** Refresh a provisional record's activity time (same operation only). */
export function touchProvisionalSignup(discordUserId: string, operationId: string, now = new Date()): boolean {
  const section = readProvisionalSection();
  const rec = section[discordUserId];
  if (rec?.operationId !== operationId) return false;
  section[discordUserId] = { ...rec, lastActiveAt: now.toISOString() };
  writeIdentityStore({ ...readIdentities(), provisionalSignups: section });
  return true;
}

/** Remove a provisional signup ONLY if it is still the same operation (never a newer attempt's record). */
export function removeProvisionalSignup(discordUserId: string, operationId: string): boolean {
  const section = readProvisionalSection();
  if (section[discordUserId]?.operationId !== operationId) return false;
  delete section[discordUserId];
  writeIdentityStore({ ...readIdentities(), provisionalSignups: section });
  return true;
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
  "secondaryEmail",
  "nafName",
  "nafId",
  "tournamentCoachId",
]);

const emptyStore = (): IdentityStore => ({ version: 1, coaches: {} });

export function normalizeFfbCoachId(ffbCoachId: string): string {
  return ffbCoachId.trim().toLowerCase();
}

/** A NAF coach id: 1 to 10 digits. The one validator for identity writes, the NAF scrape and the cache (src/nafRecords.ts). */
export const NAF_ID_PATTERN = /^\d{1,10}$/;
export const isNafId = (value: unknown): value is string => typeof value === "string" && NAF_ID_PATTERN.test(value);

export function identitiesFile(): string {
  return process.env.IDENTITIES_FILE ? resolve(process.env.IDENTITIES_FILE) : DEFAULT_IDENTITIES_FILE;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (value.length > max) throw new Error(`${field} must be at most ${max} characters.`);
  return value;
}

function boundedSecondaryEmail(value: unknown, field: string): string {
  const email = boundedString(value, field, MAX_IDENTITY_VALUE_LENGTH);
  if (email && !/^[^@\s]+@[^@\s]+$/.test(email))
    throw new Error(`${field} must be a valid email address.`);
  return email;
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

function normalizedConnections(value: unknown): CoachConnections | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const naf = (value as Record<string, unknown>).naf;
  if (!naf || typeof naf !== "object" || Array.isArray(naf)) return undefined;
  const n = naf as Record<string, unknown>;
  const ok = typeof n.verifiedAt === "string" && n.verifiedAt.length > 0 && n.verifiedAt.length <= 64 && n.source === "coachpage" &&
    isNafId(n.nafId) && typeof n.nafName === "string" && n.nafName.length > 0 && n.nafName.length <= MAX_IDENTITY_VALUE_LENGTH;
  return ok ? { naf: { verifiedAt: n.verifiedAt as string, source: "coachpage", nafId: n.nafId as string, nafName: n.nafName as string } } : undefined;
}

/** The connections that survive an identity edit: the NAF verification is kept only while nafId and nafName still
 *  equal the verified pair. */
export function connectionsAfterIdentityEdit(previous: CoachIdentityRecord, identities: CoachIdentities): CoachConnections | undefined {
  const naf = previous.connections?.naf;
  if (!naf) return previous.connections;
  if (identities.nafId === naf.nafId && identities.nafName === naf.nafName) return previous.connections;
  const { naf: _dropped, ...rest } = previous.connections ?? {};
  return Object.keys(rest).length ? rest : undefined;
}

/** A record with `connections` replaced. The key is always present (undefined = deliberately none), so upsertIdentity
 *  never carries the stored connections forward over an explicit removal. */
export function withConnections(record: CoachIdentityRecord, connections: CoachConnections | undefined): CoachIdentityRecord {
  const { connections: _old, ...base } = record;
  return { ...base, connections: connections && Object.keys(connections).length ? connections : undefined };
}

/** A NAF number in one spelling: digits only, leading zeros stripped ("034116" -> "34116"); undefined when not a NAF id. */
export function canonicalNafId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!isNafId(v)) return undefined;
  return v.replace(/^0+(?=\d)/, "");
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
    identities[identityField as keyof CoachIdentities] = identityField === "secondaryEmail"
      ? boundedSecondaryEmail(item, `identities.${identityField}`)
      : boundedString(item, `identities.${identityField}`, MAX_IDENTITY_VALUE_LENGTH);
  }
  const scheduling = record.scheduling === undefined
    ? undefined
    : normalizedScheduling(record.scheduling);
  const connections = normalizedConnections(record.connections);
  return {
    ffbCoachId,
    level: record.level as CoachLevel,
    banned: record.banned,
    silenced: record.silenced,
    note: boundedString(record.note ?? "", "note", MAX_NOTE_LENGTH),
    profile: normalizedProfile(record.profile ?? {}),
    ...(scheduling ? { scheduling } : {}),
    identities,
    ...(connections ? { connections } : {}),
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
  const hasIdentities = "identities" in patch;
  if (!hasProfile && !hasScheduling && !hasIdentities)
    throw new Error("profile, scheduling, or identities is required.");
  const previous = ownIdentityRecord(coach);
  const profile = hasProfile
    ? normalizedProfile({ ...previous.profile, ...normalizedProfile(patch.profile, "profile") })
    : previous.profile;
  const scheduling = hasScheduling
    ? normalizedScheduling(patch.scheduling, "scheduling")
    : previous.scheduling;
  const identities: CoachIdentities = { ...previous.identities };
  if (hasIdentities) {
    if (!patch.identities || typeof patch.identities !== "object" || Array.isArray(patch.identities))
      throw new Error("identities must be an object.");
    for (const [field, item] of Object.entries(patch.identities)) {
      if (field !== "nafId" && field !== "secondaryEmail")
        throw new Error(`identities.${field} is not editable through /api/account.`);
      const value = field === "secondaryEmail"
        ? boundedSecondaryEmail(item, `identities.${field}`)
        : boundedString(item, `identities.${field}`, MAX_IDENTITY_VALUE_LENGTH);
      if (field === "nafId" && value !== "" && !isNafId(value)) throw new Error("identities.nafId must be 1 to 10 digits.");
      if (value === "") delete identities[field];
      else identities[field] = value;
    }
  }
  const { scheduling: _previousScheduling, ...base } = withConnections(previous, connectionsAfterIdentityEdit(previous, identities));
  return upsertIdentity({
    ...base,
    profile,
    identities,
    ...(scheduling ? { scheduling } : {}),
    updatedAt: now.toISOString(),
    updatedBy: previous.ffbCoachId,
  }).coaches[normalizeFfbCoachId(previous.ffbCoachId)]!;
}

export function organizerUpdateIdentity(
  actingCoach: string,
  targetFfbCoachId: string,
  body: unknown,
  now = new Date(),
): CoachIdentityRecord {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("A JSON object is required.");
  const previous = ownIdentityRecord(targetFfbCoachId);
  const identities: CoachIdentities = { ...previous.identities };
  for (const [field, item] of Object.entries(body)) {
    if (field !== "nafName" && field !== "nafId")
      throw new Error(`${field} is not editable through the organizer NAF identity route.`);
    if (item === undefined) continue;
    const value = boundedString(item, field, MAX_IDENTITY_VALUE_LENGTH);
    if (field === "nafId" && value !== "" && !isNafId(value)) throw new Error("nafId must be 1 to 10 digits.");
    if (value === "") delete identities[field];
    else identities[field] = value;
  }

  // Owner intent: organizers manage NAF identity for coaches in their tournaments. No
  // tournament-participant registry exists yet, so organizer level is the enforceable gate.
  return upsertIdentity({
    ...withConnections(previous, connectionsAfterIdentityEdit(previous, identities)),
    identities,
    updatedAt: now.toISOString(),
    updatedBy: actingCoach,
  }).coaches[normalizeFfbCoachId(previous.ffbCoachId)]!;
}

/**
 * Writes one record. A writer that rebuilds the record without a `connections` key (Discord sign-in, the admin
 * identities route, test sign-in) keeps the stored connections, minus a NAF verification whose nafId/nafName pair the
 * new identities no longer carry. A writer that means to set or remove them passes the key (withConnections).
 */
export function upsertIdentity(record: CoachIdentityRecord): IdentityStore {
  const key = normalizeFfbCoachId(record.ffbCoachId);
  const current = readIdentities();
  const stored = current.coaches[key];
  const carried = !Object.hasOwn(record, "connections") && stored?.connections
    ? withConnections(record, connectionsAfterIdentityEdit(stored, record.identities))
    : record;
  const normalized = normalizedRecord(carried);
  const store: IdentityStore = {
    version: 1,
    coaches: { ...current.coaches, [key]: normalized },
  };
  writeIdentityStore(store);
  return store;
}

const writeListeners = new Set<(store: IdentityStore) => void>();
/** Called after every successful identities write in this process (ban/unban, merge, profile, admin edits, signups),
 *  with the coaches now stored. Used to drop caches derived from the store (src/coachAvatars.ts). Returns an unsubscribe. */
export function onIdentitiesWritten(listener: (store: IdentityStore) => void): () => void {
  writeListeners.add(listener);
  return () => { writeListeners.delete(listener); };
}

function writeIdentityStore(store: IdentityStore): void {
  // Writers that only know about coaches must not drop the provisional-signup section.
  const provisionalSignups = Object.fromEntries(
    Object.entries(store.provisionalSignups ?? readProvisionalSection()).filter(([, rec]) => !isStaleProvisional(rec)),
  );
  const full: IdentityStore = Object.keys(provisionalSignups).length
    ? { version: 1, coaches: store.coaches, provisionalSignups }
    : { version: 1, coaches: store.coaches };
  const payload = `${JSON.stringify(full, null, 2)}\n`;
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
  for (const listener of writeListeners) {
    try { listener({ version: 1, coaches: store.coaches }); } catch { /* a cache listener never fails a write */ }
  }
}

function mergeStringMaps(
  target: Record<string, string | undefined>,
  source: Record<string, string | undefined>,
  field: string,
): Record<string, string | undefined> {
  const merged = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!sourceValue) continue;
    const targetValue = merged[key];
    if (targetValue && targetValue !== sourceValue) {
      throw new Error(`${field}.${key} conflicts between the source and target identities.`);
    }
    merged[key] = sourceValue;
  }
  return merged;
}

/**
 * Move identity/profile metadata from an accidental source identity onto the real
 * fork coach. The target's permissions and moderation flags remain authoritative.
 * The source identity-store row is removed atomically; this deliberately does not
 * delete or rename the underlying fork account, teams, or games.
 */
export function mergeIdentityRecords(
  sourceFfbCoachId: string,
  targetFfbCoachId: string,
  actingCoach: string,
  now = new Date(),
): { sourceFfbCoachId: string; coach: CoachIdentityRecord } {
  const sourceKey = normalizeFfbCoachId(sourceFfbCoachId);
  const targetKey = normalizeFfbCoachId(targetFfbCoachId);
  if (!sourceKey || !targetKey) throw new Error("sourceFfbCoachId and targetFfbCoachId are required.");
  if (sourceKey === targetKey) throw new Error("Source and target fork coaches must be different.");
  const current = readIdentities();
  const source = current.coaches[sourceKey];
  if (!source) throw new Error("Source identity record was not found.");
  const target = current.coaches[targetKey] ?? ownIdentityRecord(targetFfbCoachId);
  const identities = mergeStringMaps(
    target.identities as Record<string, string | undefined>,
    source.identities as Record<string, string | undefined>,
    "identities",
  ) as CoachIdentities;
  // Profile/scheduling belong to the real fork coach: fill target gaps from the
  // accidental identity, but never overwrite the target's own preferences.
  const profile = { ...source.profile, ...target.profile } as CoachProfile;
  const naf = target.connections?.naf ?? source.connections?.naf;
  const connections = naf && naf.nafId === identities.nafId && naf.nafName === identities.nafName ? { naf } : undefined;
  const coach = normalizedRecord({
    ...withConnections(target, connections),
    ffbCoachId: target.ffbCoachId || targetFfbCoachId.trim(),
    profile,
    identities,
    ...(target.scheduling ?? source.scheduling
      ? { scheduling: target.scheduling ?? source.scheduling }
      : {}),
    updatedAt: now.toISOString(),
    updatedBy: actingCoach,
  });
  const coaches = { ...current.coaches, [targetKey]: coach };
  delete coaches[sourceKey];
  writeIdentityStore({ version: 1, coaches });
  return { sourceFfbCoachId: source.ffbCoachId, coach };
}
