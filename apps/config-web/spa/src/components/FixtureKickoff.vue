<script setup lang="ts">
// Fixture summary, kick-off checklist (league UX pass 11-02; the lobby's roster lock and Ready, moved off the old coach
// panels): each side's status chips (roster, inducements, ready) and, for the viewer's own side, Lock roster (with the
// recorder team on tabletop fixtures, or the submitted team on tournaments) and Ready. START sits under it (LobbyStart).
import { computed, inject, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { FIXTURE_LOBBY_KEY, type LobbySide, type LobbyView } from "../leagues/lobby";

const props = defineProps<{ view: LobbyView; left: LobbySide; proposeTo?: string; fixturesTo?: string }>();
const lobby = inject(FIXTURE_LOBBY_KEY)!;
const right = computed<LobbySide>(() => (props.left === "home" ? "away" : "home"));
const mine = computed<LobbySide | null>(() => (props.view.viewer.role === "home" || props.view.viewer.role === "away" ? props.view.viewer.role : null));
const own = computed(() => (mine.value ? props.view.sides[mine.value] : null));
const canEdit = computed(() => Boolean(mine.value) && props.view.open && !props.view.started);
const teamRef = ref(own.value?.teamRef ?? "");
watch(() => own.value?.teamRef, (v) => { if (v) teamRef.value = v; });
const busy = computed(() => lobby.state.busy !== "");
const fixed = computed(() => props.view.fixedTeam);
const fixedError = computed(() => (fixed.value && "error" in fixed.value ? fixed.value.error : ""));
const lockRoster = (): void => { void lobby.roster(true, props.view.mode === "tabletop" && !fixed.value ? teamRef.value : undefined); };
const who = (s: LobbySide): string => (s === mine.value ? "You" : props.view.sides[s].coach || (s === "home" ? "Home" : "Away"));
</script>

<template>
  <section class="hm-panel fl-panel" aria-labelledby="fs-kick-h" data-panel="kickoff">
    <header class="hm-band">
      <h2 id="fs-kick-h">Kick-off</h2>
      <span class="hm-cap">{{ view.mode === "fork" ? "Super FUMBBL" : "Tabletop" }}</span>
    </header>
    <div class="sf-btn-row fs-kick-links">
      <RouterLink v-if="proposeTo" class="sf-btn small primary" data-propose :to="proposeTo">Propose a time</RouterLink>
      <RouterLink v-if="fixturesTo" class="sf-btn small" :to="fixturesTo">All fixtures</RouterLink>
    </div>
    <ul class="fs-check">
      <li v-for="s in [left, right]" :key="s" :data-side="s">
        <b :data-seat="s">{{ who(s) }}</b>
        <span class="fl-status">
          <span class="sf-chip" :data-tone="view.sides[s].rosterLocked ? 'ok' : 'muted'" data-chip="roster">{{ view.sides[s].rosterLocked ? "Roster locked" : "Roster open" }}</span>
          <span v-if="view.sides[s].inducements.hasStep" class="sf-chip" :data-tone="view.sides[s].inducements.locked ? 'ok' : 'muted'" data-chip="inducements">{{ view.sides[s].inducements.locked ? "Inducements confirmed" : "Inducements open" }}</span>
          <span class="sf-chip" :data-tone="view.sides[s].ready ? 'ok' : 'muted'" data-chip="ready">{{ view.sides[s].ready ? "Ready" : "Not ready" }}</span>
        </span>
      </li>
    </ul>
    <div v-if="canEdit && own" class="fl-status" data-own-controls>
      <template v-if="!own.rosterLocked">
        <p v-if="fixed && 'ref' in fixed" class="fl-note" data-fixed-team>Plays your submitted team: <strong>{{ fixed.name }}</strong>{{ fixed.race ? ` · ${fixed.race}` : "" }}</p>
        <p v-else-if="fixedError" class="sf-error" role="alert" data-fixed-team>{{ fixedError }}</p>
        <label v-else-if="view.mode === 'tabletop'" class="sf-field">
          <span class="sf-k">Recorder team</span>
          <select v-model="teamRef" class="fl-select" aria-label="Team you will record this match with">
            <option value="" disabled>Choose a team</option>
            <option v-for="t in view.recorderTeams ?? []" :key="t.ref" :value="t.ref">{{ t.name }}{{ t.race ? ` · ${t.race}` : "" }}</option>
          </select>
        </label>
        <button type="button" class="sf-btn small primary" :disabled="busy || Boolean(fixedError) || (view.mode === 'tabletop' && !fixed && !teamRef)" @click="lockRoster">Lock roster</button>
      </template>
      <template v-else>
        <button type="button" class="sf-btn small" :disabled="busy" @click="lobby.roster(false)">Unlock roster</button>
        <button type="button" class="sf-btn small" :class="{ primary: !own.ready }" :disabled="busy" :aria-pressed="own.ready ? 'true' : 'false'" @click="lobby.ready(!own.ready)">{{ own.ready ? "Not ready" : "Ready" }}</button>
      </template>
    </div>
  </section>
</template>
