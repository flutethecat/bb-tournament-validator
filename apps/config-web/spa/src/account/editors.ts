// The Account page's per-coach editors (Identity + Schedule, and the proposals list the calendar reads). They belong to
// one signed-in coach: when the session coach changes (Test sign-in, sign out and back in) every editor is recreated, so
// nothing of the previous coach stays on screen and no save can reach the new session from the old coach's form.
// Responses still in flight for the previous coach land on discarded editors (the profile editor also checks its tag).

import { ref, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import type { Fetcher } from "../session";
import { createScheduleEditor, type ScheduleEditor } from "../home/schedule";
import { createProfileEditor, type ProfileEditor } from "./profile";
import { loadProposals as defaultLoadProposals, type ProposedTime } from "./calendar";

export interface AccountEditors {
  /** The session coach the editors belong to ("" = signed out). */
  coach: Readonly<Ref<string>>;
  profile: ShallowRef<ProfileEditor>;
  schedule: ShallowRef<ScheduleEditor>;
  proposals: Ref<ProposedTime[]>;
  /** Reads the proposed times for the current coach (a late answer for a previous coach is dropped). */
  refreshProposals(): Promise<void>;
  stop(): void;
}

export function createAccountEditors(deps: {
  api: Fetcher;
  /** The live session coach ("" when signed out). Reactive: read inside a watcher. */
  currentCoach: () => string;
  onScheduleSaved?: () => void;
  loadProposals?: () => Promise<ProposedTime[]>;
}): AccountEditors {
  const coach = ref(deps.currentCoach());
  const makeProfile = (c: string) => createProfileEditor({ api: deps.api, coach: c, currentCoach: deps.currentCoach });
  const makeSchedule = () => createScheduleEditor({ api: deps.api, onSaved: deps.onScheduleSaved });
  const profile = shallowRef(makeProfile(coach.value));
  const schedule = shallowRef(makeSchedule());
  const proposals = ref<ProposedTime[]>([]);
  const load = deps.loadProposals ?? (() => defaultLoadProposals(deps.api));

  async function refreshProposals(): Promise<void> {
    const forCoach = coach.value;
    if (!forCoach) return;
    const list = await load();
    if (coach.value === forCoach) proposals.value = list;
  }

  const stop = watch(deps.currentCoach, (next) => {
    if (next === coach.value) return;
    coach.value = next;
    profile.value = makeProfile(next);
    schedule.value = makeSchedule();
    proposals.value = [];
    if (next) void refreshProposals();
  }, { flush: "sync" });

  return { coach, profile, schedule, proposals, refreshProposals, stop };
}
