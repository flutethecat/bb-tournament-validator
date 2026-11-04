/**
 * Competition templates store (src/competition/templates.ts has the shapes and the rules):
 *
 *   <FORK_STATE_DIR>/competition-templates.json   { version: 1, templates: TemplateRecord[] }
 *
 * A template belongs to its owner (a coach, stored in the identity record's spelling, matched by the identity key:
 * trim + lower case), never to a league or tournament. `sharedWith` lists the organisers the owner granted read + copy
 * access. Reads are STRICT: only a missing file is empty; an unreadable or malformed file throws, so a write never
 * replaces it with an empty list (and an access check never fails open). Every write is atomic and synchronous, so one
 * request's read-modify-write never interleaves with another's.
 *
 * Privacy (laws §E 26): exported per coach and removed on account deletion (src/privacy/collectors.ts
 * "competition-templates"): the coach's own templates go, and every share grant naming them goes.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { assertNotFenced } from "../privacy/fence.js";
import { isTemplateKind, SHARES_PER_TEMPLATE, TEMPLATE_ID, TemplateError, TEMPLATES_PER_OWNER, type TemplateKind } from "../competition/templates.js";

export interface TemplateShare {
  /** The organiser's account (identity spelling at share time). */
  coach: string;
  at: string;
}

export interface TemplateRecord {
  id: string;
  kind: TemplateKind;
  /** The owning coach's account (identity spelling). */
  owner: string;
  name: string;
  description: string;
  /** Kind-specific settings (SeasonTemplateContent / TournamentTemplateContent), checked by the kind's parser. */
  content: Record<string, unknown>;
  sharedWith: TemplateShare[];
  /** The template this one was copied from ("Make a copy"); informational. */
  copiedFrom?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

interface TemplateFile { version: 1; templates: TemplateRecord[] }

export const TEMPLATES_FILE = "competition-templates.json";
export const templateKey = (coach: string): string => coach.trim().toLowerCase();
export const templatesFile = (stateDir: string): string => join(stateDir, TEMPLATES_FILE);

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

function validRecord(raw: unknown): TemplateRecord | undefined {
  if (!isObj(raw)) return undefined;
  if (typeof raw.id !== "string" || !TEMPLATE_ID.test(raw.id) || !isTemplateKind(raw.kind)) return undefined;
  if (typeof raw.owner !== "string" || !raw.owner.trim() || typeof raw.name !== "string" || !isObj(raw.content)) return undefined;
  const shares = Array.isArray(raw.sharedWith)
    ? raw.sharedWith.filter((s): s is TemplateShare => isObj(s) && typeof s.coach === "string" && s.coach.trim() !== "" && typeof s.at === "string")
    : [];
  return {
    id: raw.id, kind: raw.kind, owner: raw.owner, name: raw.name, description: typeof raw.description === "string" ? raw.description : "",
    content: raw.content, sharedWith: shares.map((s) => ({ coach: s.coach, at: s.at })),
    ...(typeof raw.copiedFrom === "string" && TEMPLATE_ID.test(raw.copiedFrom) ? { copiedFrom: raw.copiedFrom } : {}),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "", updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    revision: typeof raw.revision === "number" && Number.isInteger(raw.revision) ? raw.revision : 0,
  };
}

export interface TemplateStoreOptions { now?: () => Date; newId?: () => string }

export class TemplateStore {
  readonly file: string;
  constructor(readonly stateDir: string, private readonly opts: TemplateStoreOptions = {}) {
    this.file = templatesFile(stateDir);
  }

  private nowIso(): string { return (this.opts.now?.() ?? new Date()).toISOString(); }

  /** Every template. Throws (500) on an unreadable or malformed file. */
  all(): TemplateRecord[] {
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch (e) {
      if (isEnoent(e)) return [];
      throw new TemplateError(500, "The templates store is unreadable.");
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new TemplateError(500, "The templates store is unreadable."); }
    if (!isObj(data) || !Array.isArray(data.templates)) throw new TemplateError(500, "The templates store is unreadable.");
    return data.templates.map(validRecord).filter((r): r is TemplateRecord => Boolean(r));
  }

  private write(templates: TemplateRecord[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const data: TemplateFile = { version: 1, templates };
    atomicWriteTextFile(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }

  get(id: string): TemplateRecord | undefined {
    if (!TEMPLATE_ID.test(id)) return undefined;
    return this.all().find((t) => t.id === id);
  }

  /** The coach's own templates and those shared with them (by identity key), oldest first. */
  visibleTo(coach: string, kind?: TemplateKind): { own: TemplateRecord[]; shared: TemplateRecord[] } {
    const k = templateKey(coach);
    const list = this.all().filter((t) => !kind || t.kind === kind);
    return {
      own: list.filter((t) => templateKey(t.owner) === k),
      shared: list.filter((t) => templateKey(t.owner) !== k && t.sharedWith.some((s) => templateKey(s.coach) === k)),
    };
  }

  create(input: { kind: TemplateKind; owner: string; name: string; description: string; content: Record<string, unknown>; copiedFrom?: string }): TemplateRecord {
    assertNotFenced(input.owner);
    const all = this.all();
    const k = templateKey(input.owner);
    if (all.filter((t) => templateKey(t.owner) === k).length >= TEMPLATES_PER_OWNER)
      throw new TemplateError(409, `You have ${TEMPLATES_PER_OWNER} templates. Delete one before saving another.`);
    let id = this.opts.newId?.() ?? `tp${randomBytes(6).toString("hex")}`;
    while (all.some((t) => t.id === id)) id = `tp${randomBytes(6).toString("hex")}`;
    const at = this.nowIso();
    const rec: TemplateRecord = {
      id, kind: input.kind, owner: input.owner, name: input.name, description: input.description, content: structuredClone(input.content),
      sharedWith: [], ...(input.copiedFrom ? { copiedFrom: input.copiedFrom } : {}), createdAt: at, updatedAt: at, revision: 0,
    };
    this.write([...all, rec]);
    return structuredClone(rec);
  }

  /** Read-modify-write of one template (the caller has checked ownership). */
  update(id: string, actor: string, fn: (t: TemplateRecord) => void): TemplateRecord {
    assertNotFenced(actor);
    const all = this.all();
    const t = all.find((x) => x.id === id);
    if (!t) throw new TemplateError(404, "Template not found.");
    fn(t);
    if (t.sharedWith.length > SHARES_PER_TEMPLATE) throw new TemplateError(409, `A template can be shared with at most ${SHARES_PER_TEMPLATE} organisers.`);
    t.updatedAt = this.nowIso();
    t.revision += 1;
    this.write(all);
    return structuredClone(t);
  }

  remove(id: string, actor: string): void {
    assertNotFenced(actor);
    const all = this.all();
    if (!all.some((t) => t.id === id)) throw new TemplateError(404, "Template not found.");
    this.write(all.filter((t) => t.id !== id));
  }

  /**
   * Account deletion (privacy): drop every template owned by one of `names` (identity keys) and every share grant
   * naming one of them. Strict: an unreadable file throws so the delete step is retried. Bypasses the fence (the job
   * that set it runs this).
   */
  removeCoach(names: ReadonlySet<string>): void {
    const all = this.all();
    let changed = false;
    const kept = all.filter((t) => {
      if (names.has(templateKey(t.owner))) { changed = true; return false; }
      return true;
    });
    for (const t of kept) {
      const before = t.sharedWith.length;
      t.sharedWith = t.sharedWith.filter((s) => !names.has(templateKey(s.coach)));
      if (t.sharedWith.length !== before) changed = true;
    }
    if (changed) this.write(kept);
  }
}
