// Team management page (/app/teams/:ref, owner 10-30): GET /api/me/teams/<ref> (the coach's own team in the shared team
// view's shape + progression), the share toggle (POST/DELETE /api/fork/team-builder/saves/<id>/share) and the advancement
// flow (POST /api/teams/<teamId>/advancement, src/teamAdvancement.ts): random Primary (pick a category -> two rolled
// skills -> keep one), chosen Primary (pick a skill), characteristic (D8 roll -> pick a stat or a Primary fallback).
// A roll is reserved on the server (SPP debited, the options stored on the team); it is resumed, never rerolled. No DOM.

import { reactive } from "vue";
import { ApiError, type SharedTeamView } from "../shared/api";
import type { Fetcher } from "../session";

export interface Capability { available: boolean; reason?: string }
export type MethodKey = "randomPrimary" | "chosenPrimary" | "chosenSecondary" | "characteristic";

export interface PendingAdvancement {
  token: string;
  playerId: string;
  revision: string;
  method: "randomPrimary" | "characteristic";
  cost: number;
  choices: string[];
  primaryFallbacks: string[];
  secondaryFallbacks: string[];
  expiresAt: string;
  roll?: number;
}

export interface PlayerProgress {
  id: string;
  spp: number;
  earnedSpp: number | null;
  advancements: number;
  rank: string;
  costs: Record<MethodKey, number> | null;
  methods: Record<MethodKey, Capability>;
  pending: PendingAdvancement | null;
  primaryCategories: string[];
  secondaryCategories: string[];
  primarySkills: string[];
  secondarySkills: string[];
  canAddSkill: boolean;
  canAddCharacteristic: boolean;
  mng: boolean;
  injuries: string[];
}

export type ManagedPlayer = SharedTeamView["players"][number] & { name?: string; progress?: PlayerProgress; sprite?: string | null };

export interface TeamManageModel {
  team: Omit<SharedTeamView, "players"> & { players: ManagedPlayer[]; verdict?: string; crest?: string | null; updatedAt?: string; avatarUrl?: string };
  manage: {
    kind: "library" | "save";
    ref: string;
    teamId?: string;
    revision?: string;
    saveId?: string;
    shareToken?: string;
    libraryRef?: string;
    treasury?: number;
    teamValue?: number;
    advancement: Capability;
  };
}

export type FlowKind = "skill" | "characteristic";
export type FlowStep = "choose" | "pick" | "done";

export interface AdvanceFlow {
  /** Distinct per opened modal: a response is applied only to the flow that sent its request. */
  id: number;
  playerIndex: number;
  /** The stored id of the player this flow advances (responses for another player are discarded). */
  playerId: string;
  kind: FlowKind;
  step: FlowStep;
  busy: boolean;
  error: string;
  pending: PendingAdvancement | null;
  /** The result line once applied. */
  result: string;
  /** The server refused with a conflict (409): the loaded team is stale and closing reloads it. */
  stale: boolean;
}

export interface TeamManageState {
  ref: string;
  model: TeamManageModel | null;
  loading: boolean;
  loaded: boolean;
  error: string;
  /** 403/404: the friendly "not your team" message instead of the raw error. */
  notFound: boolean;
  shareBusy: boolean;
  shareError: string;
  flow: AdvanceFlow | null;
}

const enc = encodeURIComponent;
/** HTTP status of a failed call (ApiError; duck-typed so a second copy of the module still reads it). */
const statusOf = (err: unknown): number => (err instanceof ApiError ? err.status : typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 0);
export const teamManagePath = (ref: string): string => `/teams/${enc(ref)}`;
export const shareUrl = (origin: string, token: string): string => `${origin.replace(/\/+$/, "")}/t/${token}`;
export const builderHref = (saveId: string): string => `/tournament-team-builder.html?save=${enc(saveId)}`;
const k = (gold: number): string => `${Math.round(gold / 1000)}k`;

/** One player's progression line ("SPP 12 (earned 20) · Emerging Star · 2 advancements"). */
export function progressLine(p: PlayerProgress): string {
  const spp = p.earnedSpp !== null && p.earnedSpp !== p.spp ? `SPP ${p.spp} (earned ${p.earnedSpp})` : `SPP ${p.spp}`;
  return [spp, p.rank, `${p.advancements} advancement${p.advancements === 1 ? "" : "s"}`].join(" · ");
}

/** "Next: Add Skill at 6 SPP" style hint when nothing is affordable yet. */
export function nextCostHint(p: PlayerProgress): string {
  if (!p.costs) return p.rank === "Ineligible" ? "This player cannot gain advancements." : "Six advancements: fully advanced.";
  if (p.canAddSkill || p.canAddCharacteristic || p.pending) return "";
  const skill = p.costs.randomPrimary;
  return p.spp < skill ? `Add Skill at ${skill} SPP` : "";
}

export function createTeamManage(deps: { api: Fetcher; onSignedOut?: () => void }) {
  const state = reactive<TeamManageState>({
    ref: "", model: null, loading: false, loaded: false, error: "", notFound: false, shareBusy: false, shareError: "", flow: null,
  });
  let gen = 0;

  async function load(ref: string): Promise<void> {
    if (state.ref !== ref) state.model = null;
    state.ref = ref;
    const mine = ++gen;
    state.loading = true;
    try {
      const model = await deps.api<TeamManageModel>(`/api/me/teams/${enc(ref)}`);
      if (mine !== gen) return;
      state.model = model;
      state.error = "";
      state.notFound = false;
    } catch (err) {
      if (mine !== gen) return;
      state.model = null;
      const status = statusOf(err);
      if (status === 401 && deps.onSignedOut) deps.onSignedOut();
      state.notFound = status === 403 || status === 404;
      state.error = err instanceof Error ? err.message : "Can't load this team.";
    } finally {
      if (mine === gen) { state.loading = false; state.loaded = true; }
    }
  }

  async function setShared(on: boolean): Promise<void> {
    const saveId = state.model?.manage.saveId;
    if (!saveId || state.shareBusy) return;
    state.shareBusy = true;
    state.shareError = "";
    try {
      if (on) {
        const res = await deps.api<{ shareToken: string }>(`/api/fork/team-builder/saves/${enc(saveId)}/share`, { method: "POST" });
        if (state.model) state.model.manage.shareToken = res.shareToken;
      } else {
        await deps.api(`/api/fork/team-builder/saves/${enc(saveId)}/share`, { method: "DELETE" });
        if (state.model) delete state.model.manage.shareToken;
      }
    } catch (err) {
      state.shareError = err instanceof Error ? err.message : "Could not update the share link.";
    } finally {
      state.shareBusy = false;
    }
  }

  const player = (i: number): ManagedPlayer | undefined => state.model?.team.players[i];

  let flowSeq = 0;

  /** Open the modal for a player. A stored pending roll for them opens at the pick step. Ignored while a request of the
   *  current modal is in flight (its response must land in the modal that sent it). */
  function open(playerIndex: number, kind: FlowKind): boolean {
    if (state.flow?.busy) return false;
    const progress = player(playerIndex)?.progress;
    if (!progress) return false;
    const pending = progress.pending ?? null;
    const resumeKind: FlowKind = pending ? (pending.method === "characteristic" ? "characteristic" : "skill") : kind;
    state.flow = { id: ++flowSeq, playerIndex, playerId: progress.id, kind: resumeKind, step: pending ? "pick" : "choose", busy: false, error: "", pending, result: "", stale: false };
    return true;
  }

  /** Close the modal (ignored while a request is in flight). Reloads the team after a change, a reserved roll, or a conflict. */
  function close(): boolean {
    const flow = state.flow;
    if (flow?.busy) return false;
    const reload = flow ? flow.step === "done" || Boolean(flow.pending) || flow.stale : false;
    state.flow = null;
    if (reload && state.ref) void load(state.ref);
    return true;
  }

  type AdvanceResponse = { pending?: PendingAdvancement; ok?: true; spentSpp?: number; valueIncrease?: number };

  /** POST one action for `flow`. The response is returned only while that same flow is still the open one. */
  async function post(flow: AdvanceFlow, body: Record<string, unknown>): Promise<AdvanceResponse | undefined> {
    const teamId = state.model?.manage.teamId;
    if (state.flow !== flow || !teamId || flow.busy) return undefined;
    flow.busy = true;
    flow.error = "";
    let res: AdvanceResponse | undefined;
    try {
      res = await deps.api<AdvanceResponse>(`/api/teams/${enc(teamId)}/advancement`, { method: "POST", body });
    } catch (err) {
      flow.error = err instanceof Error ? err.message : "The advancement could not be applied.";
      if (statusOf(err) === 409) {
        flow.stale = true;
        flow.error += " Close this window to reload the team.";
      }
    } finally {
      flow.busy = false;
    }
    if (state.flow !== flow) {
      // The modal changed while the request ran: never show this result elsewhere; reload so a reservation shows up.
      if (res && state.ref) void load(state.ref);
      return undefined;
    }
    return res;
  }

  /** The current flow plus the body fields for a first-step action, bound to the flow's own player. */
  const begin = (): { flow: AdvanceFlow; playerId: string; revision: string } | undefined => {
    const flow = state.flow;
    const p = flow ? player(flow.playerIndex)?.progress : undefined;
    const revision = state.model?.manage.revision;
    if (!flow || !p || p.id !== flow.playerId || !revision) return undefined;
    return { flow, playerId: flow.playerId, revision };
  };

  function finish(flow: AdvanceFlow, text: string, res: { spentSpp?: number; valueIncrease?: number }): void {
    const parts = [text];
    if (typeof res.spentSpp === "number") parts.push(`${res.spentSpp} SPP spent`);
    if (typeof res.valueIncrease === "number") parts.push(`team value +${k(res.valueIncrease)}`);
    flow.step = "done";
    flow.pending = null;
    flow.result = `${parts[0]}. ${parts.slice(1).join(", ")}${parts.length > 1 ? "." : ""}`.trim();
  }

  /** A roll reservation for this flow's player only. */
  function takePending(flow: AdvanceFlow, res: AdvanceResponse | undefined): void {
    if (!res?.pending || res.pending.playerId !== flow.playerId) return;
    flow.pending = res.pending;
    flow.step = "pick";
  }

  async function rollRandomPrimary(category: string): Promise<void> {
    const b = begin();
    if (!b) return;
    takePending(b.flow, await post(b.flow, { action: "rollRandomPrimary", playerId: b.playerId, revision: b.revision, category }));
  }

  async function rollCharacteristic(): Promise<void> {
    const b = begin();
    if (!b) return;
    takePending(b.flow, await post(b.flow, { action: "rollCharacteristic", playerId: b.playerId, revision: b.revision }));
  }

  async function chooseSkill(skill: string): Promise<void> {
    const b = begin();
    if (!b) return;
    const res = await post(b.flow, { action: "applySkill", playerId: b.playerId, revision: b.revision, method: "chosenPrimary", skill });
    if (res?.ok) finish(b.flow, `${skill} added`, res);
  }

  /** Keep one option of the pending roll: a skill (random Primary or a characteristic roll's fallback) or a stat. */
  async function commit(choice: { type: "skill"; skill: string } | { type: "characteristic"; characteristic: string }): Promise<void> {
    const flow = state.flow;
    const pending = flow?.pending;
    if (!flow || !pending || pending.playerId !== flow.playerId) return;
    const body = {
      action: "commitRoll",
      playerId: pending.playerId,
      revision: pending.revision,
      token: pending.token,
      choice: choice.type === "skill" && pending.method === "characteristic" ? { ...choice, access: "primary" } : choice,
    };
    const res = await post(flow, body);
    if (res?.ok) finish(flow, choice.type === "skill" ? `${choice.skill} added` : `+${choice.characteristic} added`, res);
  }

  return { state, load, setShared, open, close, rollRandomPrimary, rollCharacteristic, chooseSkill, commit };
}

export type TeamManage = ReturnType<typeof createTeamManage>;
