// The signed-in coach's fork team library (GET /api/fork/library), loaded once per coach like the vanilla page did
// at boot. A failed read is an empty library ("No teams in your library yet"), never an error page.

import { ref, type InjectionKey, type Ref } from "vue";
import type { LibraryTeam } from "../shared/api";
import type { Fetcher } from "../session";

export interface Library {
  teams: Ref<LibraryTeam[]>;
  load(coach: string): Promise<void>;
}

export function createLibrary(fetcher: Fetcher): Library {
  const teams = ref<LibraryTeam[]>([]);
  let loadedFor = "";
  let inflight: Promise<void> | undefined;
  return {
    teams,
    load(coach) {
      if (loadedFor === coach) return inflight ?? Promise.resolve();
      loadedFor = coach;
      inflight = fetcher<{ teams: LibraryTeam[] }>(`/api/fork/library?coach=${encodeURIComponent(coach)}`)
        .then((res) => { if (loadedFor === coach) teams.value = res.teams ?? []; })
        .catch(() => { if (loadedFor === coach) teams.value = []; });
      return inflight;
    },
  };
}

export const LIBRARY_KEY: InjectionKey<Library> = Symbol("library");
