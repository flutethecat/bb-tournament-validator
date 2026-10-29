// SCHEDULE panel, availability editor only (spec §4.6): the coach's timezone (auto-detected default) and weekly
// availability blocks { day 0 = Monday .. 6 = Sunday, start, end } on a 7-column grid. GET/PUT /api/me/scheduling;
// the server validates again and is the authority. No DOM; rendered by HomeSchedule.vue.

import { reactive } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import { browserTimeZone, validTimeZone } from "./deadlines";

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const MAX_BLOCKS = 21;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface AvailabilityBlock { day: number; start: string; end: string }
/** A block in the editor: a client-only `id` keeps each row's identity stable while its times change (the week grid
 *  must NOT key rows by their times — editing a start used to re-sort the column and hand the focused inputs to the
 *  neighbouring block). Never sent to the server. */
export interface EditableBlock extends AvailabilityBlock { id: number }
let nextBlockId = 1;
const withId = (b: AvailabilityBlock): EditableBlock => ({ id: nextBlockId++, day: b.day, start: b.start, end: b.end });
const stripId = (b: AvailabilityBlock): AvailabilityBlock => ({ day: b.day, start: b.start, end: b.end });

export interface ScheduleState {
  timezone: string;
  /** True when the timezone shown is the browser's guess, not a saved one. */
  detected: boolean;
  blocks: EditableBlock[];
  /** True only after a successful GET: Save stays off until then, so a failed read can never PUT an empty week. */
  loaded: boolean;
  /** The last GET failed (the panel offers Retry). */
  loadFailed: boolean;
  saving: boolean;
  dirty: boolean;
  error: string;
  notice: string;
}

/** The first problem with a block list ("" = fine): day 0-6, HH:MM, start before end, no two blocks on a day intersecting
 *  (touching is fine), at most 21. Mirrors the server's PUT /api/me/scheduling check. */
export function blocksProblem(blocks: readonly AvailabilityBlock[]): string {
  if (blocks.length > MAX_BLOCKS) return `At most ${MAX_BLOCKS} blocks.`;
  for (const b of blocks) {
    const day = DAY_LABELS[b.day];
    if (!Number.isInteger(b.day) || !day) return "Pick a day for every block.";
    if (!HHMM.test(b.start) || !HHMM.test(b.end)) return `${day}: use 24-hour times (HH:MM).`;
    if (b.start >= b.end) return `${day} ${b.start}-${b.end}: the start must be before the end.`;
  }
  for (const [d, col] of byDay(blocks).entries()) {
    for (let i = 1; i < col.length; i++) {
      if (col[i]!.start < col[i - 1]!.end) return `${DAY_LABELS[d]} ${col[i]!.start}-${col[i]!.end} overlaps ${col[i - 1]!.start}-${col[i - 1]!.end}.`;
    }
  }
  return "";
}

/** Blocks per weekday column, each sorted by start. Pass `sort: false` for the editor, which must keep insertion
 *  order so a row stays where the coach is editing it (validation and display of saved weeks use the sorted form). */
export function byDay<B extends AvailabilityBlock>(blocks: readonly B[], opts: { sort?: boolean } = {}): B[][] {
  const cols: B[][] = DAY_LABELS.map(() => []);
  for (const b of blocks) cols[b.day]?.push(b);
  if (opts.sort !== false) for (const c of cols) c.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  return cols;
}

/** Timezone choices: the platform's IANA list when it has one, always including the current value. */
export function timeZoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    zones = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch { /* old engine */ }
  if (!zones.length) zones = ["UTC", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Stockholm", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo", "Australia/Sydney", "Asia/Tokyo"];
  if (current && !zones.includes(current)) zones = [current, ...zones];
  return zones;
}

export function createScheduleEditor(deps: { api: Fetcher; detect?: () => string; onSaved?: () => void }) {
  const detect = deps.detect ?? browserTimeZone;
  const state = reactive<ScheduleState>({ timezone: "", detected: false, blocks: [], loaded: false, loadFailed: false, saving: false, dirty: false, error: "", notice: "" });

  async function load(): Promise<void> {
    state.loadFailed = false;
    try {
      const res = await deps.api<{ timezone?: string; availability?: AvailabilityBlock[] }>("/api/me/scheduling");
      const saved = typeof res?.timezone === "string" ? res.timezone : "";
      state.timezone = saved || detect();
      state.detected = !saved;
      state.blocks = Array.isArray(res?.availability) ? res.availability.map(withId) : [];
      state.error = "";
      state.dirty = false;
      state.loaded = true;
    } catch (e) {
      // Nothing to edit: keep Save off (never PUT an empty week over saved blocks) and offer Retry.
      state.loaded = false;
      state.loadFailed = true;
      state.error = `Can't load your availability: ${e instanceof Error ? e.message : "try again."}`;
    }
  }

  const touch = () => { state.dirty = true; state.notice = ""; };

  return {
    state,
    load,
    setTimezone(tz: string): void { state.timezone = tz; state.detected = false; touch(); },
    addBlock(day: number, start = "18:00", end = "21:00"): boolean {
      if (!state.loaded) return false;
      if (state.blocks.length >= MAX_BLOCKS) { state.error = `At most ${MAX_BLOCKS} blocks.`; return false; }
      state.blocks.push(withId({ day, start, end }));
      state.error = "";
      touch();
      return true;
    },
    updateBlock(block: AvailabilityBlock, patch: Partial<AvailabilityBlock>): void { Object.assign(block, patch); touch(); },
    removeBlock(block: EditableBlock): void {
      const i = state.blocks.indexOf(block);
      if (i >= 0) state.blocks.splice(i, 1);
      touch();
    },
    async save(): Promise<boolean> {
      if (!state.loaded || state.saving) return false;
      const problem = blocksProblem(state.blocks) || (state.timezone && !validTimeZone(state.timezone) ? "Pick a timezone from the list." : "");
      if (problem) { state.error = problem; return false; }
      state.saving = true;
      try {
        const res = await deps.api<{ timezone?: string; availability?: AvailabilityBlock[] }>("/api/me/scheduling", {
          method: "PUT", body: { timezone: state.timezone, availability: state.blocks.map(stripId) },
        });
        state.timezone = res?.timezone || state.timezone;
        state.detected = false;
        state.blocks = Array.isArray(res?.availability) ? res.availability.map(withId) : state.blocks;
        state.error = "";
        state.notice = "Availability saved.";
        state.dirty = false;
        deps.onSaved?.();
        return true;
      } catch (e) {
        state.error = e instanceof ApiError || e instanceof Error ? e.message : "Can't save your availability.";
        return false;
      } finally {
        state.saving = false;
      }
    },
  };
}

export type ScheduleEditor = ReturnType<typeof createScheduleEditor>;
