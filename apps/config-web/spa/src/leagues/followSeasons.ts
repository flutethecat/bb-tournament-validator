// League management keeps two readers of the same league: the settings controller (its season actions reload its season
// list) and the league detail controller behind the section header and Participants. After Start a new season, Finish,
// Reopen or a stage change, the detail controller re-reads the league so the new season shows without a page reload.

import { watch, type WatchStopHandle } from "vue";

type SeasonLike = { id: string; status: string; stage?: string };
const key = (list: readonly SeasonLike[]): string => list.map((x) => `${x.id}:${x.status}:${x.stage ?? ""}`).join(",");

export function followSeasons(
  settings: { readonly id: string; readonly seasons: readonly SeasonLike[] },
  detail: { state: { readonly id: string; readonly loaded: boolean; readonly seasons: readonly SeasonLike[] }; load(id: string): Promise<void> },
  leagueId: () => string,
): WatchStopHandle {
  return watch(() => key(settings.seasons), (now) => {
    const id = leagueId();
    if (settings.id === id && detail.state.loaded && detail.state.id === id && now !== key(detail.state.seasons)) void detail.load(id);
  });
}
