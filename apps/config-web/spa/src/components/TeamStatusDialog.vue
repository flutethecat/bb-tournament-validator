<script setup lang="ts">
// The team status cog (team page v2, organisers): Active / Inactive. Going inactive never cancels anything by itself:
// the organiser picks, per unplayed fixture or for all of them, Cancel (no result), Forfeit (the inactive team concedes)
// or Leave scheduled, or skips the step (the summary then says how many fixtures still need a decision and reopens this
// dialog in "decide" mode with the bulk actions). Opponents keep the results they already earned either way.
import { computed, reactive, ref } from "vue";
import type { FixtureDecision, TeamPageView } from "../teams/summary";
import LeagueDialog from "./LeagueDialog.vue";

const props = defineProps<{ view: TeamPageView; start: "status" | "decide"; busy?: boolean; error?: string }>();
const emit = defineEmits<{
  close: []; status: [status: "active" | "inactive", decide?: { decisions?: Array<{ fixtureId: string; decision: FixtureDecision }>; all?: FixtureDecision }];
  decide: [decide: { decisions?: Array<{ fixtureId: string; decision: FixtureDecision }>; all?: FixtureDecision }];
}>();
const inactive = computed(() => props.view.team.status === "inactive");
const want = ref<"active" | "inactive">(props.start === "decide" ? "inactive" : inactive.value ? "active" : "inactive");
const picks = reactive<Record<string, FixtureDecision | "">>(Object.fromEntries((props.view.fixtures ?? []).map((f) => [f.id, f.decision ?? ""])));
const fixtures = computed(() => props.view.fixtures ?? []);
const showFixtures = computed(() => want.value === "inactive" && fixtures.value.length > 0);
const LABEL: Record<FixtureDecision, string> = { cancel: "Cancel (no result)", forfeit: "Forfeit (opponent wins)", leave: "Leave scheduled" };
const chosen = computed(() => Object.entries(picks).filter(([id, d]) => d && d !== (fixtures.value.find((f) => f.id === id)?.decision ?? "")).map(([fixtureId, decision]) => ({ fixtureId, decision: decision as FixtureDecision })));
const changed = computed(() => (want.value === "inactive") !== inactive.value);

function save(): void {
  const decide = chosen.value.length ? { decisions: chosen.value } : undefined;
  if (props.start === "decide" || (!changed.value && want.value === "inactive")) { if (decide) emit("decide", decide); else emit("close"); return; }
  emit("status", want.value, want.value === "inactive" ? decide : undefined);
}
function bulk(d: FixtureDecision): void {
  if (props.start === "decide" || inactive.value) emit("decide", { all: d });
  else emit("status", "inactive", { all: d });
}
const title = computed(() => (props.start === "decide" ? "Unplayed fixtures" : "Team status"));
</script>

<template>
  <LeagueDialog id="ts-status" wide :title="title" :cap="view.team.name" :busy="busy" tag="form" @close="emit('close')" @submit="save">
    <fieldset v-if="start === 'status'" class="ts-status-pick">
      <legend class="tb-k">Status in the league</legend>
      <label class="sf-check"><input v-model="want" type="radio" value="active" name="ts-status" /> Active</label>
      <label class="sf-check"><input v-model="want" type="radio" value="inactive" name="ts-status" /> Inactive: hidden from results under "Inactive", no standings row. Opponents keep their earned results and points.</label>
    </fieldset>
    <template v-if="showFixtures">
      <p class="hm-small">Unplayed fixtures are never cancelled automatically. Decide each one now, all of them at once, or later from the team page.</p>
      <div class="sf-btn-row ts-bulk" role="group" aria-label="All unplayed fixtures">
        <span class="tb-k">All</span>
        <button v-for="d in (['cancel', 'forfeit', 'leave'] as const)" :key="d" type="button" class="sf-btn small" :disabled="busy" @click="bulk(d)">{{ LABEL[d] }}</button>
      </div>
      <table class="lg-table ts-fixtures">
        <thead><tr><th scope="col">Round</th><th scope="col">Opponent</th><th scope="col">Decision</th></tr></thead>
        <tbody>
          <tr v-for="f in fixtures" :key="f.id" :data-fixture="f.id">
            <td>{{ f.round }}<small v-if="f.date" class="muted"> · {{ f.date }}</small></td>
            <th scope="row">{{ f.opponent }}</th>
            <td>
              <select v-model="picks[f.id]" class="sf-input" :aria-label="`Decision for round ${f.round} against ${f.opponent}`" :disabled="busy || f.pending">
                <option value="">Decide later</option>
                <option v-for="d in (['cancel', 'forfeit', 'leave'] as const)" :key="d" :value="d">{{ LABEL[d] }}</option>
              </select>
              <small v-if="f.pending" class="muted">A Super FUMBBL game is under way.</small>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
    <p v-else-if="want === 'inactive' && start === 'decide'" class="hm-empty">No unplayed fixtures.</p>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" @click="emit('close')">{{ start === "decide" ? "Later" : "Cancel" }}</button>
      <button type="submit" class="sf-btn primary" :disabled="busy || (!changed && !chosen.length && start === 'status')">Save</button>
    </template>
  </LeagueDialog>
</template>
