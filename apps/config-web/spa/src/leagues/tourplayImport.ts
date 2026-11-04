// TourPlay import upload in the SPA (lane L8; server: src/leagues/tourplayImport.ts). The organiser's own export, read in
// the browser (a .zip, or several .csv files) and sent to the server for a preview, then applied. Nothing is fetched from
// TourPlay (law 20a). The server is the authority for every rule: matching, suggestions, what a season becomes.

import { reactive } from "vue";
import { ApiError } from "../shared/api";

type Fetcher = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

export type MatchStatus = "matched" | "unmatched" | "ambiguous" | "conflict";
export type MatchBasis = "naf-name" | "naf-number" | "naf-name+number";

export interface TourplaySuggestion { coach: string; reasons: string[]; score: number }

export interface PreviewSeason {
  folder: string; slug: string; number: number; id: string; action: "new" | "update" | "replace-empty";
  problem?: string; removes?: string[]; name?: string; ruleset?: string; status?: string;
  teams?: number; players?: number; fixtures?: number; played?: number; phases?: string[]; standings?: number;
  honours?: number; awards?: number; mismatches?: number; ambiguities?: number;
  renumbered?: { from: number }; derivedTeams?: string[];
  merge?: { fixturesAdded: number; fixturesUpdated: number; teamsAdded: number; teamsUpdated: number; kept: number };
  conflicts?: MergeConflict[];
}

/** A re-import difference kept local by default (tourplayMerge.ts); the organiser may pick the export per row. */
/** Pairings ("possible correction" / "possible rename") carry keepBothId: `id` = the same row, keepBothId = keep both. */
export interface MergeConflict { id: string; kind: "fixture" | "result" | "roster" | "team" | "pairing" | "rename" | "ambiguous"; label: string; reason: string; local: string; export: string; keepBothId?: string; options?: Array<{ id: string; label: string }> }

export interface PreviewCoach {
  id: string; name: string; nafUser?: string; hasNafNumber: boolean; teams: string[]; seasons: number[];
  status: MatchStatus; basis: MatchBasis | "none"; proposed?: string; candidates?: { byName: string[]; byNumber: string[] };
  reason?: string; coachId?: string; decision?: { coachId: string | null; via: "organiser" | "claim" }; confirmed: boolean; suggestions: TourplaySuggestion[];
}

export interface TourplayPreview {
  seasons: PreviewSeason[]; coaches: PreviewCoach[];
  counts: { matched: number; unmatched: number; ambiguous: number; conflict: number; linked: number; proposed: number };
  problems: string[]; canApply: boolean;
}

export interface ReviewRow {
  id: string; name: string; nafUser?: string; hasNafNumber: boolean; nafNumber?: string;
  seasons: Array<{ seasonId: string; number: number; teams: string[] }>;
  status: MatchStatus; basis: MatchBasis | "none"; coachId?: string; obsolete?: boolean; candidates?: { byName: string[]; byNumber: string[] };
  reason?: string; decision?: { coachId: string | null; by: string; at: string; via: "organiser" | "claim" };
  assignedOnTeams?: boolean; needsReview: boolean; suggestions: TourplaySuggestion[];
  claims: Array<{ id: string; coach: string; at: string }>;
}

export interface TourplayReview {
  rows: ReviewRow[];
  claims: Array<{ id: string; row: string; name: string; coach: string; at: string; state: string; decidedBy?: string; decidedAt?: string }>;
  imports: Array<{ at: string; by: string; seasons: Array<{ id: string; slug: string; number: number; action: string }> }>;
  counts: { rows: number; review: number; linked: number; claims: number };
}

export interface ClaimableRow { id: string; name: string; teams: string[]; seasons: string[] }
export interface MyClaim { id: string; row: string; name: string; state: "pending" | "declined"; at: string }

/** Upload limits shown next to the picker (the server enforces them). */
export const ZIP_MAX_MB = 8;

export const STATUS_LABEL: Record<MatchStatus, string> = { matched: "Matched", unmatched: "No match", ambiguous: "Several matches", conflict: "Conflict" };
export const STATUS_TONE: Record<MatchStatus, string> = { matched: "ok", unmatched: "muted", ambiguous: "soon", conflict: "urgent" };
export const BASIS_LABEL: Record<MatchBasis | "none", string> = { "naf-name": "NAF name", "naf-number": "NAF number", "naf-name+number": "NAF name and number", none: "no NAF match" };
export const ACTION_LABEL: Record<PreviewSeason["action"], string> = { new: "New season", update: "Updates the imported season", "replace-empty": "Replaces the empty season" };

const base64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The request body for the picked files: one .zip, or .csv files (a folder's relative paths kept). */
export async function uploadBody(files: readonly File[]): Promise<{ zip: string } | { files: Array<{ name: string; text: string }> }> {
  if (!files.length) throw new Error("Pick the TourPlay export (a .zip, or its .csv files).");
  const zips = files.filter((f) => /\.zip$/i.test(f.name));
  if (zips.length) {
    if (zips.length > 1 || files.length > 1) throw new Error("Pick one .zip, or the .csv files without a zip.");
    if (zips[0]!.size > ZIP_MAX_MB * 1024 * 1024) throw new Error(`The zip must be at most ${ZIP_MAX_MB} MB.`);
    return { zip: base64(await zips[0]!.arrayBuffer()) };
  }
  const other = files.find((f) => !/\.csv$/i.test(f.name));
  if (other) throw new Error(`Only .csv files (or one .zip) are accepted: ${other.name} is not one.`);
  return {
    files: await Promise.all(files.map(async (f) => ({ name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, text: await f.text() }))),
  };
}

const message = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong.");

/** The organiser side: upload -> preview (with per-row picks) -> apply, and the review list. */
export function createTourplayImport(opts: { api: Fetcher }) {
  const state = reactive({
    leagueId: "",
    files: [] as File[],
    body: null as Awaited<ReturnType<typeof uploadBody>> | null,
    preview: null as TourplayPreview | null,
    /** Row id -> the organiser's pick for this apply (a coach, or null = no account). */
    decisions: {} as Record<string, string | null>,
    /** Merge conflicts resolved to the export (the rest keep the local value). */
    choices: [] as string[],
    review: null as TourplayReview | null,
    busy: "" as "" | "preview" | "apply" | "review" | "assign" | "claim",
    error: "",
    notice: "",
  });
  const base = (): string => `/api/leagues/${encodeURIComponent(state.leagueId)}/tourplay`;

  async function loadReview(leagueId: string): Promise<void> {
    state.leagueId = leagueId;
    state.busy = "review";
    try { state.review = await opts.api<TourplayReview>(base()); state.error = ""; } catch (e) { state.error = message(e); } finally { state.busy = ""; }
  }
  async function pick(leagueId: string, files: readonly File[]): Promise<void> {
    state.leagueId = leagueId;
    state.files = [...files];
    state.preview = null;
    state.decisions = {};
    state.choices = [];
    state.notice = "";
    try { state.body = await uploadBody(files); state.error = ""; } catch (e) { state.body = null; state.error = message(e); return; }
    await preview();
  }
  async function preview(): Promise<void> {
    if (!state.body) return;
    state.busy = "preview";
    try {
      state.preview = await opts.api<TourplayPreview>(`${base()}/preview`, { method: "POST", body: { ...state.body, decisions: state.decisions, choices: state.choices } });
      state.error = "";
    } catch (e) { state.error = message(e); } finally { state.busy = ""; }
  }
  /** The organiser's pick for one preview row (undefined = back to what the import found). */
  async function decide(rowId: string, coach: string | null | undefined): Promise<void> {
    if (coach === undefined) delete state.decisions[rowId]; else state.decisions[rowId] = coach;
    await preview();
  }
  /** "Confirm all exact matches": an explicit organiser action that turns every proposal into a decision. */
  async function confirmAll(): Promise<void> {
    for (const c of state.preview?.coaches ?? []) if (c.status === "matched" && c.proposed && !c.confirmed) state.decisions[c.id] = c.proposed;
    await preview();
  }
  async function choose(conflictId: string, useExport: boolean): Promise<void> {
    state.choices = useExport ? [...new Set([...state.choices, conflictId])] : state.choices.filter((x) => x !== conflictId);
    await preview();
  }
  /** A pairing: "match" (same game / team), "both" (different) or "" (undecided: nothing is added). */
  async function pair(c: { id: string; keepBothId?: string; options?: Array<{ id: string }> }, pick: "match" | "both" | "", optionId?: string): Promise<void> {
    const drop = new Set([c.id, c.keepBothId ?? "", ...(c.options ?? []).map((o) => o.id)]);
    const matchId = optionId ?? c.id;
    state.choices = [...state.choices.filter((x) => !drop.has(x)), ...(pick === "match" ? [matchId] : pick === "both" && c.keepBothId ? [c.keepBothId] : [])];
    await preview();
  }
  async function apply(): Promise<boolean> {
    if (!state.body) return false;
    state.busy = "apply";
    try {
      const r = await opts.api<{ seasons: Array<{ id: string; number: number }>; counts: { linked: number; review: number } }>(`${base()}/apply`, { method: "POST", body: { ...state.body, decisions: state.decisions, choices: state.choices } });
      state.notice = `Imported ${r.seasons.length === 1 ? `Season ${r.seasons[0]!.number}` : `${r.seasons.length} seasons`}: ${r.counts.linked} coaches linked, ${r.counts.review} to review.`;
      state.body = null; state.files = []; state.preview = null; state.decisions = {}; state.choices = []; state.error = "";
      await loadReview(state.leagueId);
      return true;
    } catch (e) {
      state.error = message(e);
      const data = e instanceof ApiError ? (e.data as { preview?: TourplayPreview } | undefined) : undefined;
      if (data?.preview) state.preview = data.preview;
      return false;
    } finally { state.busy = ""; }
  }
  function reset(): void { state.body = null; state.files = []; state.preview = null; state.decisions = {}; state.choices = []; state.error = ""; state.notice = ""; }
  async function assign(rowId: string, coachId: string | null, allSeasons = true): Promise<void> {
    state.busy = "assign";
    try {
      await opts.api(`${base()}/coaches/${encodeURIComponent(rowId)}/assign`, { method: "POST", body: { coachId, allSeasons } });
      state.notice = coachId ? `Linked to ${coachId}.` : "Marked as not on the site.";
      await loadReview(state.leagueId);
    } catch (e) { state.error = message(e); } finally { if (state.busy === "assign") state.busy = ""; }
  }
  async function decideClaim(claimId: string, verb: "approve" | "decline", allSeasons = true): Promise<void> {
    state.busy = "claim";
    try {
      await opts.api(`${base()}/claims/${encodeURIComponent(claimId)}/${verb}`, { method: "POST", body: verb === "approve" ? { allSeasons } : {} });
      state.notice = verb === "approve" ? "Claim approved: the teams are linked." : "Claim declined.";
      await loadReview(state.leagueId);
    } catch (e) { state.error = message(e); } finally { if (state.busy === "claim") state.busy = ""; }
  }
  return { state, loadReview, pick, preview, decide, confirmAll, choose, pair, apply, reset, assign, decideClaim };
}
export type TourplayImportController = ReturnType<typeof createTourplayImport>;

/** The coach side: "Is this you?" for imported names nobody is linked to. */
export function createTourplayClaims(opts: { api: Fetcher }) {
  const state = reactive({ leagueId: "", rows: [] as ClaimableRow[], mine: [] as MyClaim[], loaded: false, busy: "", error: "", notice: "" });
  const base = (): string => `/api/leagues/${encodeURIComponent(state.leagueId)}/tourplay`;
  async function load(leagueId: string): Promise<void> {
    state.leagueId = leagueId;
    try {
      const r = await opts.api<{ rows: ClaimableRow[]; mine: MyClaim[] }>(`${base()}/claimable`);
      state.rows = r.rows; state.mine = r.mine; state.error = "";
    } catch { state.rows = []; state.mine = []; } finally { state.loaded = true; }
  }
  async function claim(rowId: string): Promise<void> {
    state.busy = rowId;
    try {
      await opts.api(`${base()}/claims`, { method: "POST", body: { row: rowId } });
      state.notice = "Sent to the organisers. They will link the teams to your account if they agree.";
      await load(state.leagueId);
    } catch (e) { state.error = message(e); } finally { state.busy = ""; }
  }
  async function withdraw(claimId: string): Promise<void> {
    state.busy = claimId;
    try { await opts.api(`${base()}/claims/${encodeURIComponent(claimId)}/withdraw`, { method: "POST", body: {} }); state.notice = ""; await load(state.leagueId); }
    catch (e) { state.error = message(e); } finally { state.busy = ""; }
  }
  return { state, load, claim, withdraw };
}
