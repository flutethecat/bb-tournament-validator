<script setup lang="ts">
// League fixture summary (Fixtures tab, ?fixture=<id>): the match, its result and, when the league plays on Super FUMBBL
// and an organiser allowed the fixture, the Super FUMBBL panel: "Generate fixture on Super FUMBBL" for the seated coaches
// and the organisers, "Start Game on Super FUMBBL" for each seated coach, the status steps (teams built, game scheduled,
// in progress, result recorded; a failure with its reason), and for organisers the per-game settings (allow, late
// launch, cancel), "Check for result" and "Reset fork game" with a reason. The result's player lines show once played,
// with each team's casualties suffered and the server's legal-concession verdict when the result carried them.
import { computed, inject, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { createFixtureSummary, FIXTURE_SUMMARY_KEY, FORK_STATUS_TONE, forkSteps, sideLabel } from "../leagues/fixture";
import { day, fixtureOutcome, fixturePlayed, fixtureTime } from "../leagues/league";
import type { ForkPlayerLine, ForkSide } from "../leagues/types";

const props = defineProps<{ leagueId: string; seasonId: string; fixtureId: string; back: Record<string, string> }>();
const fetcher = inject(API_KEY)!;
const ctl = inject(FIXTURE_SUMMARY_KEY, null) ?? createFixtureSummary({ api: fetcher });
const { state } = ctl;
const key = computed(() => `${props.leagueId}/${props.seasonId}/${props.fixtureId}`);
const ensure = (): void => { if (state.key !== key.value || !state.loaded) void ctl.load(props.leagueId, props.seasonId, props.fixtureId); };
onMounted(ensure);
watch(key, ensure);

const s = computed(() => (state.key === key.value ? state.summary : null));
const f = computed(() => s.value?.fixture);
const fork = computed(() => s.value?.fork);
const played = computed(() => (f.value ? fixturePlayed(f.value) : false));
const outcome = computed(() => (f.value ? fixtureOutcome(f.value) : undefined));
const steps = computed(() => (fork.value ? forkSteps(fork.value) : []));
const showFork = computed(() => Boolean(s.value?.league.playOnFork && fork.value && (fork.value.enabled || fork.value.status !== "none" || fork.value.canConfigure)));
const reason = ref("");
const resetOpen = ref(false);
const doReset = async (): Promise<void> => {
  if (!reason.value.trim()) return;
  if (await ctl.reset(reason.value.trim())) { reason.value = ""; resetOpen.value = false; }
};
const lines = (side: ForkSide): ForkPlayerLine[] => fork.value?.result?.[side].lines ?? [];
/** The server's legal-concession verdict for the conceding side (" (legal concession)"), or "" when it sent none. */
const legal = (side: ForkSide): string => {
  const v = fork.value?.result?.[side].concededLegally;
  return v === undefined ? "" : v ? " (legal concession)" : " (not a legal concession)";
};
const sufferedText = (side: ForkSide): string => {
  const c = fork.value?.result?.[side].casualtiesSuffered;
  return c ? `${c.badlyHurt} BH, ${c.seriousInjury} SI, ${c.rip} dead` : "none";
};
const anySuffered = computed(() => Boolean(fork.value?.result && (fork.value.result.home.casualtiesSuffered || fork.value.result.away.casualtiesSuffered)));
const when = (iso?: string): string => (iso ? day(iso) : "");
const checked = (e: Event): boolean => (e.target as HTMLInputElement).checked;
</script>

<template>
  <section class="hm-panel lg-fixture" aria-labelledby="lg-fixture-h">
    <header class="hm-band">
      <h2 id="lg-fixture-h">Fixture summary</h2>
      <RouterLink class="sf-btn small" :to="{ query: back }" replace>All fixtures</RouterLink>
    </header>
    <p v-if="state.error && state.key === key" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!f" class="hm-empty" role="status">Loading fixture...</p>
    <template v-else>
      <div class="lg-fixture-match" :aria-label="`${f.home.team} against ${f.away.team}`">
        <div class="lg-fixture-side" :data-outcome="outcome?.home ?? ''">
          <span class="lg-team-name">{{ f.home.team }}</span>
          <small>{{ f.home.coach }} · {{ f.home.race }}</small>
        </div>
        <div class="lg-fixture-score">
          <strong>{{ played ? `${f.home.score} - ${f.away.score}` : "vs" }}</strong>
          <small v-if="played && f.home.cas !== null && f.away.cas !== null">CAS {{ f.home.cas }} - {{ f.away.cas }}</small>
        </div>
        <div class="lg-fixture-side lg-fx-away" :data-outcome="outcome?.away ?? ''">
          <span class="lg-team-name">{{ f.away.team }}</span>
          <small>{{ f.away.coach }} · {{ f.away.race }}</small>
        </div>
      </div>
      <p class="hm-small">{{ [s!.season.name, f.phase, f.group, `Round ${f.round}`, day(fixtureTime(f))].filter(Boolean).join(" · ") }}</p>
      <p v-if="f.home.conceded || f.away.conceded" class="hm-small" data-concession>{{ f.home.conceded ? f.home.team : f.away.team }} conceded{{ legal(f.home.conceded ? "home" : "away") }}.</p>
      <p v-if="anySuffered" class="hm-small" data-cas-suffered>Casualties suffered: {{ f.home.team }} {{ sufferedText("home") }} · {{ f.away.team }} {{ sufferedText("away") }}</p>

      <section v-if="showFork && fork" class="ls-sub lg-fork-panel" aria-labelledby="lg-fork-h" :data-status="fork.status">
        <h3 id="lg-fork-h" class="ls-sub-h">
          Super FUMBBL
          <span class="sf-chip" :data-tone="FORK_STATUS_TONE[fork.status]" data-fork-status>{{ fork.statusLabel }}</span>
        </h3>
        <p v-if="!fork.enabled && fork.status === 'none'" class="hm-small">This fixture is not allowed on Super FUMBBL.</p>
        <ol v-if="fork.status !== 'none'" class="lg-fork-steps">
          <li v-for="st in steps" :key="st.label" :data-done="st.done ? 'true' : 'false'">{{ st.label }}</li>
        </ol>
        <p v-if="fork.status === 'launch_failed' && fork.error" class="sf-error" role="alert">Failed: {{ fork.error }}</p>
        <p v-else-if="fork.error" class="hm-small">{{ fork.error }}</p>
        <p v-if="fork.cancelled" class="hm-small">Super FUMBBL play is cancelled for this fixture.</p>
        <p v-if="!s!.forkAvailable && fork.enabled" class="hm-small">Super FUMBBL is not connected right now.</p>

        <div class="lg-fork-actions">
          <button v-if="fork.canGenerate" class="sf-btn primary" type="button" :disabled="Boolean(state.busy) || !s!.forkAvailable" @click="ctl.generate()">
            {{ state.busy === "generate" ? "Generating..." : "Generate fixture on Super FUMBBL" }}
          </button>
          <button v-if="fork.canStart" class="sf-btn primary" type="button" :disabled="Boolean(state.busy)" @click="ctl.start()">
            {{ state.busy === "start" ? "Starting..." : "Start Game on Super FUMBBL" }}
          </button>
        </div>
        <p v-if="fork.blocker && fork.status === 'none'" class="hm-small" data-blocker>{{ fork.blocker }}</p>
        <p v-if="fork.mySide && fork.launched?.[fork.mySide]" class="hm-small">You took your launch file {{ when(fork.launched[fork.mySide]) }}.</p>
        <p v-if="state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
        <p v-else-if="state.notice" class="hm-small" role="status">{{ state.notice }}</p>

        <div v-if="fork.canConfigure" class="lg-fork-admin" aria-label="Super FUMBBL settings for this fixture">
          <label class="lg-fork-switch">
            <input type="checkbox" role="switch" :checked="Boolean(f.forkEnabled)" :disabled="Boolean(state.busy) || played" @change="ctl.setAllowed(checked($event))" />
            <span>Allow Super FUMBBL for this fixture</span>
          </label>
          <label class="lg-fork-switch">
            <input type="checkbox" role="switch" :checked="fork.allowLate" :disabled="Boolean(state.busy)" @change="ctl.setLate(checked($event))" />
            <span>Allow late launch</span>
          </label>
          <label class="lg-fork-switch">
            <input type="checkbox" role="switch" :checked="fork.cancelled" :disabled="Boolean(state.busy) || fork.status === 'finished'" @change="ctl.setCancelled(checked($event))" />
            <span>Cancel Super FUMBBL play</span>
          </label>
          <div class="lg-fork-actions">
            <button v-if="fork.status === 'scheduled' || fork.status === 'in_progress'" class="sf-btn" type="button" :disabled="Boolean(state.busy)" @click="ctl.sync()">Check for result</button>
            <button v-if="fork.canReset && !resetOpen" class="sf-btn" type="button" :disabled="Boolean(state.busy)" @click="resetOpen = true">Reset fork game</button>
          </div>
          <form v-if="fork.canReset && resetOpen" class="lg-fork-reset" @submit.prevent="doReset">
            <label class="ls-field"><span>Reason for the reset</span><input v-model="reason" type="text" maxlength="300" required /></label>
            <button class="sf-btn" type="button" @click="resetOpen = false">Cancel</button>
            <button class="sf-btn danger" type="submit" :disabled="!reason.trim() || Boolean(state.busy)">Reset fork game</button>
          </form>
          <details v-if="fork.log?.length" class="lg-fork-log">
            <summary>History</summary>
            <ul><li v-for="(e, i) in fork.log" :key="i"><small>{{ when(e.at) }} · {{ e.by }}</small> {{ e.text }}</li></ul>
          </details>
        </div>
      </section>

      <section v-if="fork?.canConfigure" class="lg-fork-admin" aria-label="Game admin">
        <label class="lg-fork-switch">
          <input type="checkbox" role="switch" :checked="f.defectionRolls !== false" :disabled="Boolean(state.busy)" @change="ctl.setDefections(checked($event))" />
          <span>Defection rolls after an illegal concession (forfeit dialog)</span>
        </label>
        <p v-if="f.forfeit" class="hm-small">Forfeited<template v-if="f.forfeit.home"> by {{ f.home.team }}</template><template v-if="f.forfeit.away"><template v-if="f.forfeit.home"> and</template> by {{ f.away.team }}</template><template v-if="f.forfeit.noStandings">, no effect on standings</template>.</p>
      </section>

      <section v-if="fork?.result" class="lg-fork-result" aria-label="Player lines">
        <p v-if="fork.result.source === 'basic'" class="hm-small">Score and player counters only: SPP and injuries were not in this result.</p>
        <p v-if="fork.result.financialPending" class="hm-small" data-financial-pending>Treasuries were not updated from this game: an organiser settles the winnings.</p>
        <p v-if="fork.result.penalty" class="hm-small">Penalty shootout {{ fork.result.penalty.home }} - {{ fork.result.penalty.away }}.</p>
        <div v-for="side in (['home', 'away'] as const)" :key="side" class="lg-scroll">
          <table v-if="lines(side).length" class="lg-table">
            <caption>{{ sideLabel(side) }}: {{ f[side].team }}</caption>
            <thead><tr><th scope="col">Player</th><th scope="col" class="lg-num">TD</th><th scope="col" class="lg-num">CAS</th><th scope="col" class="lg-num">CMP</th><th scope="col" class="lg-num">INT</th><th scope="col" class="lg-num">MVP</th><th scope="col" class="lg-num">SPP</th><th scope="col">Injuries</th></tr></thead>
            <tbody>
              <tr v-for="l in lines(side)" :key="l.forkPlayerId">
                <td>{{ l.name || "Player" }}</td><td class="lg-num">{{ l.td }}</td><td class="lg-num">{{ l.cas }}</td><td class="lg-num">{{ l.completions }}</td>
                <td class="lg-num">{{ l.interceptions }}</td><td class="lg-num">{{ l.mvp }}</td><td class="lg-num">{{ l.spp ?? "" }}</td><td>{{ l.injuries.join(", ") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </section>
</template>
