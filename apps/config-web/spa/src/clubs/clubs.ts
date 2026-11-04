// Coach clubs in the SPA (creation wizards v2 rounds 2-3): the directory (/app/clubs), the club page (/app/clubs/:id?tab=)
// with Overview / Members / Results / Stats / Board, and the admins' management (/app/clubs/:id/manage, the cog). The server
// (src/clubs/api.ts) is the authority for every rule and computes the stats; this module reads and writes through /api/clubs.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import { fetchUpload, type RawUploader } from "../leagues/league";
import { writesAllowed, type Fetcher, type SessionStore } from "../session";

export interface ClubSummary { id: string; name: string; homeRegion: string; description: string; memberCount: number; createdAt: string; crestUrl?: string; archived?: true }
export interface ClubMemberView { coach: string; role: "admin" | "member"; joinedAt: string; avatar?: string }
export interface ClubView {
  id: string; name: string; homeRegion: string; description: string; createdAt: string; revision: number; crestUrl?: string; archivedAt?: string;
  ladderGamesCount: boolean; members: ClubMemberView[]; memberCount: number;
}
export interface ClubMe { member: boolean; role?: "admin" | "member"; notify?: { wins: boolean; board: boolean }; requested: boolean; canRequest: boolean; siteAdmin: boolean }
export interface ClubGameSide { coach: string; team: string; race?: string; clubId?: string }
export interface ClubGame {
  id: string; clubId: string; kind: "tournament" | "league" | "ladder"; competitionId: string; competitionName: string; seasonName?: string; link: string;
  round?: string; at?: string; member: ClubGameSide; opponent: ClubGameSide; score: { for: number; against: number }; cas: { for: number; against: number };
  result: "win" | "draw" | "loss"; recorded: boolean;
}
export interface ClubHonour { id: string; kind: "podium" | "title"; competitionName: string; seasonName?: string; link: string; coach: string; team?: string; place: 1 | 2 | 3; at?: string }
export interface ClubRecordLine { coach: string; games: number; wins: number; draws: number; losses: number; tdFor: number; tdAgainst: number; casFor: number; casAgainst: number }
export interface ClubStats {
  totals: ClubRecordLine & { competitions: number; titles: number; podiums: number; coaches: number };
  members: Array<ClubRecordLine & { role: "admin" | "member"; joinedAt: string }>;
  former: Array<ClubRecordLine & { leftAt?: string }>;
  leaders: Array<{ key: string; label: string; coach: string; value: number; display: string }>;
  results: ClubGame[];
  honours: ClubHonour[];
  ladderExcluded: boolean;
}
export interface ClubManage {
  requests: Array<{ coach: string; at: string; message?: string }>;
  webhook: { configured: boolean; maskedUrl: string };
  settings: { ladderGamesCount: boolean; webhookEvents: { results: boolean; podiums: boolean; titles: boolean } };
  revision: number;
  review?: { reason: "creator-deleted"; at: string };
}
export interface ClubPage { club: ClubView; latest: ClubGame[]; me: ClubMe | null; manage?: ClubManage }

export const clubLink = (id: string, tab?: string) => ({ name: "club-detail", params: { id }, ...(tab && tab !== "overview" ? { query: { tab } } : {}) });

/** "3-1-2" (W-D-L). */
export const wdl = (l: Pick<ClubRecordLine, "wins" | "draws" | "losses">): string => `${l.wins}-${l.draws}-${l.losses}`;
/** Win rate as a percentage (draws count half), or "-" without games. */
export const winRate = (l: Pick<ClubRecordLine, "games" | "wins" | "draws">): string => (l.games ? `${Math.round(((l.wins + l.draws / 2) / l.games) * 100)}%` : "-");
export const RESULT_LABEL: Record<ClubGame["result"], string> = { win: "W", draw: "D", loss: "L" };
export const RESULT_TONE: Record<ClubGame["result"], string> = { win: "ok", draw: "muted", loss: "urgent" };
export const KIND_LABEL: Record<ClubGame["kind"], string> = { tournament: "Tournament", league: "League", ladder: "Ladder" };
export const PLACE_LABEL: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd" };
export const shortDate = (iso?: string): string => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
};
export const initialsOf = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]!.toUpperCase()).join("") || "?";

/** Who may create a club: any signed-in coach on a session that may write (the onboarding gate answers on the server). */
export const canCreateClub = (session: SessionStore): boolean => session.signedIn() && writesAllowed(session);

const message = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

// ---- directory --------------------------------------------------------------------------------------------------------

export function createClubDirectory(deps: { api: Fetcher }) {
  const state = reactive({ items: [] as ClubSummary[], loaded: false, loading: false, error: "", q: "", busy: false, createError: "" });
  return {
    state,
    async load(): Promise<void> {
      state.loading = true;
      try {
        const q = state.q.trim();
        const res = await deps.api<{ clubs?: ClubSummary[] }>(`/api/clubs${q ? `?q=${encodeURIComponent(q)}` : ""}`);
        state.items = Array.isArray(res?.clubs) ? res.clubs : [];
        state.error = "";
      } catch (err) { state.error = message(err, "Can't load the clubs."); } finally { state.loading = false; state.loaded = true; }
    },
    async create(input: { name: string; homeRegion: string; description: string }): Promise<string | undefined> {
      state.busy = true;
      state.createError = "";
      try {
        const res = await deps.api<ClubPage>("/api/clubs", { method: "POST", body: input });
        return res.club.id;
      } catch (err) { state.createError = message(err, "Can't create the club."); return undefined; } finally { state.busy = false; }
    },
  };
}

// ---- one club -----------------------------------------------------------------------------------------------------------

export interface ClubBoardPost { id: string; author: string; text: string; at: string; editedAt?: string; removed?: { by: "author" | "moderator"; at: string }; mine: boolean; canEdit: boolean; canRemove: boolean }
export interface ClubBoardThread extends ClubBoardPost { title: string; lastAt: string; replies: ClubBoardPost[] }
export interface ClubBoardView { threads: ClubBoardThread[]; canPost: boolean; canModerate: boolean; seenAt?: string }

export function createClubDetail(deps: { api: Fetcher; upload?: RawUploader }) {
  const upload = deps.upload ?? fetchUpload;
  const state = reactive({
    id: "", page: null as ClubPage | null, stats: null as ClubStats | null, manage: null as ClubManage | null,
    loaded: false, notFound: false, error: "", busy: "", actionError: "", notice: "", statsError: "",
  });
  const base = () => `/api/clubs/${encodeURIComponent(state.id)}`;
  async function act<T>(key: string, run: () => Promise<T>, done?: string): Promise<T | undefined> {
    state.busy = key;
    state.actionError = "";
    state.notice = "";
    try {
      const r = await run();
      if (done) state.notice = done;
      return r;
    } catch (err) { state.actionError = message(err, "That didn't work."); return undefined; } finally { state.busy = ""; }
  }
  const take = (r: ClubPage | undefined) => { if (r?.club) { state.page = { club: r.club, latest: r.latest ?? state.page?.latest ?? [], me: r.me ?? state.page?.me ?? null }; if (r.manage) state.manage = r.manage; } };
  return {
    state,
    async load(id: string): Promise<void> {
      if (state.id !== id) { state.page = null; state.stats = null; state.manage = null; state.loaded = false; }
      state.id = id;
      try {
        const page = await deps.api<ClubPage>(base());
        if (state.id !== id) return;
        state.page = page;
        state.notFound = false;
        state.error = "";
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) state.notFound = true;
        else state.error = message(err, "Can't load the club.");
      } finally { state.loaded = true; }
    },
    async loadStats(): Promise<void> {
      try { state.stats = await deps.api<ClubStats>(`${base()}/stats`); state.statsError = ""; } catch (err) { state.statsError = message(err, "Can't load the club's results."); }
    },
    async loadManage(): Promise<void> {
      try { state.manage = await deps.api<ClubManage>(`${base()}/manage`); } catch (err) { state.actionError = message(err, "Can't load the club's management."); }
    },
    request: (msg: string) => act("request", async () => take(await deps.api<ClubPage>(`${base()}/requests`, { method: "POST", body: msg.trim() ? { message: msg.trim() } : {} })), "Request sent. The club's admins will decide."),
    cancelRequest: () => act("cancel", async () => take(await deps.api<ClubPage>(`${base()}/requests/cancel`, { method: "POST", body: {} })), "Request withdrawn."),
    leave: () => act("leave", async () => take(await deps.api<ClubPage>(`${base()}/leave`, { method: "POST", body: {} })), "You left the club."),
    setNotify: (patch: { wins?: boolean; board?: boolean }) => act("notify", async () => take(await deps.api<ClubPage>(`${base()}/notify`, { method: "POST", body: patch }))),
    decide: (coach: string, verb: "approve" | "decline") => act(`req:${coach}`, async () => take(await deps.api<ClubPage>(`${base()}/requests/${encodeURIComponent(coach)}/${verb}`, { method: "POST", body: {} })), verb === "approve" ? `${coach} joined the club.` : "Request declined."),
    setRole: (coach: string, role: "admin" | "member") => act(`role:${coach}`, async () => take(await deps.api<ClubPage>(`${base()}/members/${encodeURIComponent(coach)}/role`, { method: "POST", body: { role } }))),
    remove: (coach: string) => act(`rm:${coach}`, async () => take(await deps.api<ClubPage>(`${base()}/members/${encodeURIComponent(coach)}/remove`, { method: "POST", body: {} })), `${coach} was removed.`),
    save: (patch: Record<string, unknown>) => act("save", async () => take(await deps.api<ClubPage>(base(), { method: "PATCH", body: { revision: state.page?.club.revision, ...patch } })), "Saved."),
    setWebhook: (url: string | null) => act("webhook", async () => { state.manage = await deps.api<ClubManage>(`${base()}/webhook`, { method: "PUT", body: { url } }); }, url ? "Webhook saved." : "Webhook removed."),
    setArchived: (archived: boolean) => act("archive", async () => take(await deps.api<ClubPage>(`${base()}/archive`, { method: "POST", body: { archived } })), archived ? "Club archived." : "Club restored."),
    destroy: () => act("delete", async () => deps.api<{ deleted?: boolean; archived?: boolean }>(base(), { method: "DELETE", body: { revision: state.page?.club.revision } })),
    uploadCrest: (file: Blob) => act("crest", async () => { await upload(`${base()}/crest`, file); }, "Crest saved."),
    removeCrest: () => act("crest", async () => { await deps.api(`${base()}/crest`, { method: "DELETE" }); }, "Crest removed."),
  };
}

// ---- board (generic: a board lives at <base>/board) -------------------------------------------------------------------

export function createBoard(deps: { api: Fetcher; base: () => string }) {
  const state = reactive({ view: null as ClubBoardView | null, loaded: false, error: "", code: "", busy: "", actionError: "" });
  const path = () => `${deps.base()}/board`;
  async function act(key: string, run: () => Promise<{ board?: ClubBoardView } | undefined>): Promise<boolean> {
    state.busy = key;
    state.actionError = "";
    try { const r = await run(); if (r?.board) state.view = r.board; return true; } catch (err) { state.actionError = message(err, "That didn't work."); return false; } finally { state.busy = ""; }
  }
  return {
    state,
    async load(): Promise<void> {
      try {
        state.view = await deps.api<ClubBoardView>(path());
        state.error = ""; state.code = "";
        // Opening the board is a POST (reads never change state): it coalesces the "new posts" notes.
        void deps.api(`${path()}/seen`, { method: "POST", body: {} }).catch(() => undefined);
      } catch (err) {
        state.error = message(err, "Can't load the board.");
        state.code = err instanceof ApiError ? String(err.status) : "";
      } finally { state.loaded = true; }
    },
    post: (title: string, text: string) => act("post", () => deps.api(path(), { method: "POST", body: { title, text } })),
    reply: (threadId: string, text: string) => act(`reply:${threadId}`, () => deps.api(`${path()}/${encodeURIComponent(threadId)}/replies`, { method: "POST", body: { text } })),
    edit: (postId: string, text: string, title?: string) => act(`edit:${postId}`, () => deps.api(`${path()}/${encodeURIComponent(postId)}`, { method: "PATCH", body: { text, ...(title !== undefined ? { title } : {}) } })),
    remove: (postId: string) => act(`rm:${postId}`, () => deps.api(`${path()}/${encodeURIComponent(postId)}`, { method: "DELETE" })),
  };
}

// ---- the club pick at join (the join sheets) ----------------------------------------------------------------------------

export interface MyClub { id: string; name: string; role: "admin" | "member"; crestUrl?: string }

/** The coach's clubs for a join sheet's club pick: [] when signed out or on any failure (the pick then shows "No club"). */
export async function loadMyClubs(api: Fetcher): Promise<MyClub[]> {
  try {
    const r = await api<{ clubs?: MyClub[] }>("/api/me/clubs");
    return Array.isArray(r?.clubs) ? r.clubs : [];
  } catch { return []; }
}

export type ClubDetail = ReturnType<typeof createClubDetail>;
export const CLUB_DETAIL_KEY: InjectionKey<ClubDetail> = Symbol("club-detail");
