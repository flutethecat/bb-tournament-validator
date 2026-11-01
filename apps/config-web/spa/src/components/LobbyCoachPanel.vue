<script setup lang="ts">
// Fixture lobby, a coach panel (spec §8 LEFT TOP = YOU, RIGHT TOP = OPPONENT): avatar + presence dot, coach, standing,
// sideline chips, the team bar in the seat colour, the mini roster, and the status chips. The viewer's own panel
// carries Lock roster (with the recorder team on tabletop fixtures) and Ready.
import { computed, inject, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { initials } from "../leagues/league";
import { FIXTURE_LOBBY_KEY, kGold, type LobbySide, type LobbyView } from "../leagues/lobby";

const props = defineProps<{ view: LobbyView; side: LobbySide; mine: boolean }>();
const lobby = inject(FIXTURE_LOBBY_KEY)!;
const s = computed(() => props.view.sides[props.side]);
const label = computed(() => (props.mine && props.view.viewer.role === props.side ? "You" : props.side === "home" ? "Home coach" : "Away coach"));
const canEdit = computed(() => props.mine && props.view.viewer.role === props.side && props.view.open && !props.view.started);
const teamRef = ref(s.value.teamRef ?? "");
watch(() => s.value.teamRef, (v) => { if (v) teamRef.value = v; });
const busy = computed(() => lobby.state.busy !== "");
const teamLink = computed(() => `${props.view.links.competition}${props.view.links.competition.includes("?") ? "&" : "?"}tab=teams&team=${encodeURIComponent(s.value.team.id)}`);
const lockRoster = (): void => { void lobby.roster(true, props.view.mode === "tabletop" ? teamRef.value : undefined); };
</script>

<template>
  <section class="hm-panel fl-panel" :aria-labelledby="`fl-coach-${side}`" :data-side="side">
    <header class="hm-band" :data-seat="side">
      <h2 :id="`fl-coach-${side}`">{{ label }}</h2>
      <span class="hm-cap">{{ s.online ? "Online" : "Offline" }}</span>
    </header>
    <div class="fl-coach">
      <span class="fl-avatar" aria-hidden="true">{{ initials(s.coach) }}<span class="fl-dot" :data-on="s.online ? 'true' : 'false'" /></span>
      <div>
        <p class="fl-coach-name">{{ s.coach || "No coach yet" }}</p>
        <p class="fl-coach-sub">{{ s.stats.allTime.played }} games · {{ s.stats.allTime.wins }}-{{ s.stats.allTime.draws }}-{{ s.stats.allTime.losses }}</p>
      </div>
      <div v-if="s.standing" class="fl-rank">Rank<b>#{{ s.standing.rank }}</b>{{ s.standing.points }} pts</div>
    </div>
    <div class="fl-chips">
      <span class="sf-chip">Rerolls {{ s.team.rerolls ?? "-" }}</span>
      <span class="sf-chip" :data-tone="s.team.apothecary ? 'ok' : 'muted'">Apo {{ s.team.apothecary ? "yes" : "no" }}</span>
      <span class="sf-chip">Fans {{ s.team.fans ?? "-" }}</span>
      <span class="sf-chip">TV {{ kGold(s.team.tv) }}</span>
      <span class="sf-chip">Treasury {{ kGold(s.team.treasury) }}</span>
    </div>
    <div class="fl-teambar" :data-seat="side"><span>{{ s.team.name }}</span><span>{{ s.team.playerCount }} players</span></div>
    <ol v-if="s.team.roster.length" class="fl-roster" aria-label="Mini roster">
      <li v-for="p in s.team.roster" :key="`${p.number}-${p.name}`">
        <span class="fl-num">{{ p.number ?? "-" }}</span>
        <span class="fl-pname">{{ p.name }}<small>{{ p.position }}</small><span v-for="k in p.skills" :key="k" class="fl-skill">{{ k }}</span></span>
        <span class="fl-spp">{{ p.spp }} SPP</span>
      </li>
    </ol>
    <RouterLink v-if="s.team.id" class="fl-more" :to="teamLink">Full roster →</RouterLink>
    <div class="fl-status">
      <span class="sf-chip" :data-tone="s.rosterLocked ? 'ok' : 'muted'" data-chip="roster">{{ s.rosterLocked ? "Roster locked" : "Roster open" }}</span>
      <span class="sf-chip" :data-tone="s.ready ? 'ok' : 'muted'" data-chip="ready">{{ s.ready ? "Ready" : "Not ready" }}</span>
      <span v-if="s.inducements.hasStep" class="sf-chip" :data-tone="s.inducements.locked ? 'ok' : 'muted'" data-chip="inducements">{{ s.inducements.locked ? "Inducements locked" : "Inducements open" }}</span>
    </div>
    <div v-if="canEdit" class="fl-status" data-own-controls>
      <template v-if="!s.rosterLocked">
        <label v-if="view.mode === 'tabletop'" class="sf-field">
          <span class="sf-k">Recorder team</span>
          <select v-model="teamRef" class="fl-select" aria-label="Team you will record this match with">
            <option value="" disabled>Choose a team</option>
            <option v-for="t in view.recorderTeams ?? []" :key="t.ref" :value="t.ref">{{ t.name }}{{ t.race ? ` · ${t.race}` : "" }}</option>
          </select>
        </label>
        <button type="button" class="sf-btn small primary" :disabled="busy || (view.mode === 'tabletop' && !teamRef)" @click="lockRoster">Lock roster</button>
      </template>
      <template v-else>
        <button type="button" class="sf-btn small" :disabled="busy" @click="lobby.roster(false)">Unlock roster</button>
        <button type="button" class="sf-btn small" :class="{ primary: !s.ready }" :disabled="busy" :aria-pressed="s.ready ? 'true' : 'false'" @click="lobby.ready(!s.ready)">{{ s.ready ? "Not ready" : "Ready" }}</button>
      </template>
    </div>
  </section>
</template>
