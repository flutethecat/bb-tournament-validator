<script setup lang="ts">
// League Participants tab (organisers and site admins; the league page hides the tab from everyone else): one row per
// season team with the five participant flags as toggles (Paid, Verified, Frozen, Checked in, Active; off = standby).
// The bulk bar marks every team, or the ticked ones, paid / verified / checked in / active, and clears those flags behind
// an inline confirmation (owner 10-29: "mark all as paid, all as validated"). "Shared" shows only what the coach chose to
// share with this league's organisers ("Not shared" otherwise). Coaches with an account hear about each change once.
import { computed, inject, ref, watch } from "vue";
import { API_KEY } from "../app";
import { LEAGUE_DETAIL_KEY } from "../leagues/league";
import {
  contactLines, createLeagueParticipants, FLAG_LABEL, flagCount, keepRow, LEAGUE_PARTICIPANTS_KEY, PARTICIPANT_FILTERS, PARTICIPANT_FLAGS,
  type ParticipantFilter, type ParticipantFlag,
} from "../leagues/participants";
import "../leagues/participants.css";

const props = defineProps<{ leagueId: string; seasonId: string; seasonName: string }>();
const fetcher = inject(API_KEY)!;
const detail = inject(LEAGUE_DETAIL_KEY, null);
const ctl = inject(LEAGUE_PARTICIPANTS_KEY, null) ?? createLeagueParticipants({
  api: fetcher,
  revision: () => detail?.state.season[props.seasonId]?.revision,
  onRevision: (r) => { const s = detail?.state.season[props.seasonId]; if (s) s.revision = r; },
});
const { state } = ctl;

const filter = ref<ParticipantFilter>("all");
const rows = computed(() => state.rows.filter((r) => keepRow(r, filter.value)));
const picked = ref<string[]>([]);
const pickedSet = computed(() => new Set(picked.value));
const allPicked = computed(() => rows.value.length > 0 && rows.value.every((r) => pickedSet.value.has(r.teamId)));
const somePicked = computed(() => !allPicked.value && rows.value.some((r) => pickedSet.value.has(r.teamId)));
function togglePick(id: string, on: boolean): void {
  picked.value = on ? [...new Set([...picked.value, id])] : picked.value.filter((x) => x !== id);
}
function toggleAll(on: boolean): void {
  const shown = new Set(rows.value.map((r) => r.teamId));
  picked.value = on ? [...new Set([...picked.value, ...shown])] : picked.value.filter((x) => !shown.has(x));
}
// Ticks only count for teams still listed (a reload may drop one).
const targets = computed(() => picked.value.filter((id) => state.rows.some((r) => r.teamId === id)));
const scope = computed(() => (targets.value.length ? "selected" : "all"));
const scopeCap = computed(() => (targets.value.length ? `${targets.value.length} selected` : `All ${state.rows.length} teams`));

const BULK: ReadonlyArray<{ flag: ParticipantFlag; on: string; off: string }> = [
  { flag: "paid", on: "Mark {s} paid", off: "Clear paid" },
  { flag: "rosterVerified", on: "Mark {s} verified", off: "Clear verified" },
  { flag: "checkedIn", on: "Check in {s}", off: "Clear check-in" },
  { flag: "active", on: "Mark {s} active", off: "Move {s} to standby" },
];
const label = (t: string): string => t.replace("{s}", scope.value);
const confirm = ref<{ flag: ParticipantFlag; text: string } | null>(null);
const busy = computed(() => Boolean(state.busy));
async function bulk(flag: ParticipantFlag, value: boolean): Promise<void> {
  confirm.value = null;
  await ctl.bulk(flag, value, targets.value);
}
function askClear(b: (typeof BULK)[number]): void {
  const who = targets.value.length ? `the ${targets.value.length} selected ${targets.value.length === 1 ? "team" : "teams"}` : `all ${state.rows.length} teams`;
  confirm.value = { flag: b.flag, text: b.flag === "active" ? `Move ${who} to standby?` : `${label(b.off)} for ${who}?` };
}
watch(() => `${props.leagueId}/${props.seasonId}`, () => { picked.value = []; confirm.value = null; void ctl.load(props.leagueId, props.seasonId); }, { immediate: true });

/** A refused change puts the box back to the stored value (the binding alone would not, as it never changed). */
async function setFlag(teamId: string, flag: ParticipantFlag, box: HTMLInputElement): Promise<void> {
  const ok = await ctl.setFlag(teamId, flag, box.checked);
  if (!ok) box.checked = state.rows.find((r) => r.teamId === teamId)?.flags[flag] ?? false;
}
const rowBusy = (id: string): boolean => state.busy === `row:${id}` || state.busy.startsWith("bulk:");
</script>

<template>
  <section class="hm-panel lg-part" aria-labelledby="lg-part-h">
    <header class="hm-band" data-tone="admin">
      <h2 id="lg-part-h">Participants</h2>
      <span class="hm-cap">{{ seasonName }} · {{ state.rows.length }} {{ state.rows.length === 1 ? "team" : "teams" }}</span>
    </header>
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded" class="hm-empty" role="status">Loading participants...</p>
    <p v-else-if="!state.rows.length" class="hm-empty">This season has no teams yet.</p>
    <template v-else>
      <div class="lg-part-tally" aria-label="Totals">
        <span v-for="f in PARTICIPANT_FLAGS" :key="f" class="sf-chip" :data-tone="flagCount(state.rows, f) === state.rows.length ? 'ok' : 'muted'">
          {{ FLAG_LABEL[f] }} {{ flagCount(state.rows, f) }}/{{ state.rows.length }}
        </span>
      </div>

      <div class="lg-part-bulk" role="group" aria-labelledby="lg-part-scope">
        <span id="lg-part-scope" class="sf-k lg-part-scope">{{ scopeCap }}</span>
        <div class="sf-btn-row">
          <button v-for="b in BULK" :key="b.flag" type="button" class="sf-btn small" :class="{ primary: b.flag === 'paid' || b.flag === 'rosterVerified' }" :disabled="busy" @click="bulk(b.flag, true)">{{ label(b.on) }}</button>
          <details class="lg-part-more">
            <summary class="sf-btn small">Clear...</summary>
            <div class="lg-part-menu" role="group" aria-label="Clear flags">
              <button v-for="b in BULK" :key="b.flag" type="button" class="sf-btn small" :disabled="busy" @click="askClear(b)">{{ label(b.off) }}</button>
            </div>
          </details>
          <button v-if="targets.length" type="button" class="sf-btn small" @click="picked = []">Clear selection</button>
        </div>
        <div v-if="confirm" class="lg-part-confirm" role="alertdialog" aria-labelledby="lg-part-confirm-t">
          <span id="lg-part-confirm-t">{{ confirm.text }}</span>
          <button type="button" class="sf-btn small" @click="confirm = null">Cancel</button>
          <button type="button" class="sf-btn small danger" :disabled="busy" @click="bulk(confirm.flag, false)">Clear</button>
        </div>
        <p v-if="state.writeError" class="sf-error" role="alert">{{ state.writeError }}</p>
        <p v-else-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>
      </div>

      <div class="sf-tabs small lg-part-filter" role="group" aria-label="Show participants">
        <button v-for="f in PARTICIPANT_FILTERS" :key="f.id" type="button" class="sf-tab" :aria-pressed="filter === f.id" @click="filter = f.id">{{ f.label }}</button>
      </div>
      <p v-if="!rows.length" class="hm-empty">Nobody matches this filter.</p>
      <div v-else class="lg-part-wrap">
        <table class="sf-table lg-part-table">
          <thead>
            <tr>
              <th class="lg-part-pick">
                <input
                  type="checkbox" :checked="allPicked" :indeterminate="somePicked" aria-label="Select every listed team"
                  @change="toggleAll(($event.target as HTMLInputElement).checked)"
                />
              </th>
              <th>Team</th><th>Coach</th><th>Shared</th>
              <th v-for="f in PARTICIPANT_FLAGS" :key="f" class="lg-part-flag">{{ FLAG_LABEL[f] }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.teamId" :data-picked="pickedSet.has(r.teamId) ? 'true' : undefined">
              <td class="lg-part-pick" data-label="Select">
                <input type="checkbox" :checked="pickedSet.has(r.teamId)" :aria-label="`Select ${r.team}`" @change="togglePick(r.teamId, ($event.target as HTMLInputElement).checked)" />
              </td>
              <td class="lg-part-team" data-label="Team"><strong>{{ r.team }}</strong><span class="lg-part-dim">{{ r.race }}</span></td>
              <td class="lg-part-coach" data-label="Coach">
                <span class="lg-part-lines">
                  <span>{{ r.coach }}</span>
                  <span v-if="r.coachId && r.coachId !== r.coach" class="lg-part-dim">Account: {{ r.coachId }}</span>
                  <span v-else-if="!r.coachId" class="lg-part-dim">No account</span>
                </span>
              </td>
              <td class="lg-part-shared" data-label="Shared">
                <span class="lg-part-lines">
                  <span v-for="(line, i) in contactLines(r)" :key="i">{{ line }}</span>
                  <span v-if="!contactLines(r).length" class="lg-part-dim">Not shared</span>
                </span>
              </td>
              <td v-for="f in PARTICIPANT_FLAGS" :key="f" class="lg-part-flag" :data-label="FLAG_LABEL[f]">
                <input
                  type="checkbox" :checked="r.flags[f]" :aria-label="`${FLAG_LABEL[f]}: ${r.team}`" :disabled="rowBusy(r.teamId)"
                  @change="setFlag(r.teamId, f, $event.target as HTMLInputElement)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="hm-small hm-empty">Coaches with an account get a notification when their flags change. Active off means standby.</p>
    </template>
  </section>
</template>
