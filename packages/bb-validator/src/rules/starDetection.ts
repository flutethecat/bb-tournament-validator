import { isStarName } from "../dataset/lookup";
import type { Dataset } from "../dataset/types";
import type { ResolvedPlayer } from "./types";

export function rosteredStars<T extends Pick<ResolvedPlayer, "player">>(
  players: readonly T[],
  data: Dataset,
): T[] {
  return players.filter((rp) => isStarName(data, rp.player.positionName));
}
