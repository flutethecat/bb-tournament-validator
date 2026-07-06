/**
 * SKETCH (unbuilt). Rule plumbing. Each rule is an isolated pure function over a
 * precomputed RuleContext; the runner concatenates findings. The PixiJS client
 * can run a subset by filtering the registry.
 */

import type { Finding } from "../model/findings";
import type { Roster, RosterPlayer } from "../model/roster";
import type { Dataset, DatasetPosition, DatasetRoster } from "../dataset/types";
import type { Access } from "../dataset/lookup";
import type { TournamentPackage } from "../package/types";

/** Per-player resolution, computed once in validate() so rules don't repeat it. */
export interface ResolvedPlayer {
  player: RosterPlayer;
  /** undefined = position not found in the dataset (its own finding). */
  position?: DatasetPosition;
  addedSkills: string[];
  /** Parallel to addedSkills. */
  access: Access[];
}

export interface RuleContext {
  roster: Roster;
  pkg: TournamentPackage;
  data: Dataset;
  /** undefined = race not in dataset (M1: everything but Amazon). */
  datasetRoster?: DatasetRoster;
  players: ResolvedPlayer[];
}

export interface Rule {
  id: string;
  /** Skip when the dataset roster is missing (most positional rules need it). */
  needsDatasetRoster?: boolean;
  check(ctx: RuleContext): Finding[];
}

export const err = (ruleId: string, message: string, extra?: Partial<Finding>): Finding => ({
  ruleId,
  severity: "error",
  message,
  ...extra,
});

export const warn = (ruleId: string, message: string, extra?: Partial<Finding>): Finding => ({
  ruleId,
  severity: "warning",
  message,
  ...extra,
});

export const info = (ruleId: string, message: string, extra?: Partial<Finding>): Finding => ({
  ruleId,
  severity: "info",
  message,
  ...extra,
});
