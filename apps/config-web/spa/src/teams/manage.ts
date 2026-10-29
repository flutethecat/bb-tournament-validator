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
  playerIndex: number;
  kind: FlowKind;
  step: FlowStep;
  busy: boolean;
  error: string;
  pending: PendingAdvancement | null;
  /** The result line once applied. */
  result: string;
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

  /** Open the modal for a player. A stored pending roll for them opens at the pick step. */
  function open(playerIndex: number, kind: FlowKind): void {
    const pending = player(playerIndex)?.progress?.pending ?? null;
    const resumeKind: FlowKind = pending ? (pending.method === "characteristic" ? "characteristic" : "skill") : kind;
    state.flow = { playerIndex, kind: resumeKind, step: pending ? "pick" : "choose", busy: false, error: "", pending, result: "" };
  }

  function close(): void {
    const reload = state.flow?.step === "done" || Boolean(state.flow?.pending);
    state.flow = null;
    if (reload && state.ref) void load(state.ref);
  }

  async function post(body: Record<string, unknown>): Promise<{ pending?: PendingAdvancement; ok?: true; spentSpp?: number; valueIncrease?: number } | undefined> {
    const flow = state.flow;
    const teamId = state.model?.manage.teamId;
    if (!flow || !teamId || flow.busy) return undefined;
    flow.busy = true;
    flow.error = "";
    try {
      return await deps.api(`/api/teams/${enc(teamId)}/advancement`, { method: "POST", body });
    } catch (err) {
      flow.error = err instanceof Error ? err.message : "The advancement could not be applied.";
      if (statusOf(err) === 409) flow.error += " Close this window to reload the team.";
      return undefined;
    } finally {
      flow.busy = false;
    }
  }

  const base = () => {
    const p = player(state.flow?.playerIndex ?? -1)?.progress;
    return p && state.model?.manage.revision ? { playerId: p.id, revision: state.model.manage.revision } : undefined;
  };

  function finish(text: string, res: { spentSpp?: number; valueIncrease?: number }): void {
    if (!state.flow) return;
    const parts = [text];
    if (typeof res.spentSpp === "number") parts.push(`${res.spentSpp} SPP spent`);
    if (typeof res.valueIncrease === "number") parts.push(`team value +${k(res.valueIncrease)}`);
    state.flow.step = "done";
    state.flow.pending = null;
    state.flow.result = `${parts[0]}. ${parts.slice(1).join(", ")}${parts.length > 1 ? "." : ""}`.trim();
  }

  async function rollRandomPrimary(category: string): Promise<void> {
    const b = base();
    if (!b) return;
    const res = await post({ action: "rollRandomPrimary", ...b, category });
    if (res?.pending && state.flow) { state.flow.pending = res.pending; state.flow.step = "pick"; }
  }

  async function rollCharacteristic(): Promise<void> {
    const b = base();
    if (!b) return;
    const res = await post({ action: "rollCharacteristic", ...b });
    if (res?.pending && state.flow) { state.flow.pending = res.pending; state.flow.step = "pick"; }
  }

  async function chooseSkill(skill: string): Promise<void> {
    const b = base();
    if (!b) return;
    const res = await post({ action: "applySkill", ...b, method: "chosenPrimary", skill });
    if (res?.ok) finish(`${skill} added`, res);
  }

  /** Keep one option of the pending roll: a skill (random Primary or a characteristic roll's fallback) or a stat. */
  async function commit(choice: { type: "skill"; skill: string } | { type: "characteristic"; characteristic: string }): Promise<void> {
    const pending = state.flow?.pending;
    if (!pending) return;
    const body = {
      action: "commitRoll",
      playerId: pending.playerId,
      revision: pending.revision,
      token: pending.token,
      choice: choice.type === "skill" && pending.method === "characteristic" ? { ...choice, access: "primary" } : choice,
    };
    const res = await post(body);
    if (res?.ok) finish(choice.type === "skill" ? `${choice.skill} added` : `+${choice.characteristic} added`, res);
  }

  return { state, load, setShared, open, close, rollRandomPrimary, rollCharacteristic, chooseSkill, commit };
}

export type TeamManage = ReturnType<typeof createTeamManage>;
