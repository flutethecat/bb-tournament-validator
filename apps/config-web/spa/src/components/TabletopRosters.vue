<script setup lang="ts">
// Rosters popout: both rosters, one team at a time behind a team switch, like the client's in-game Rosters pane
// (team tabs with an eligible/size count, then one row per player: badge, number, name, position, MA ST AG PA AV,
// skills, SPP). Rows come from the team files the server returned; stats the team file lacks show as a dash.
import { computed, ref } from "vue";
import { uiIcon } from "../tabletop/feed";
import type { MatchView, RosterPlayerView, ServerTally, Side, TeamView } from "../tabletop/recorder";

const props = defineProps<{ match: MatchView; teams: Record<Side, TeamView | undefined>; tally: ServerTally }>();
const emit = defineEmits<{ (e: "close"): void }>();

const sides: Side[] = ["home", "away"];
const side = ref<Side>("home");
const players = computed(() => props.teams[side.value]?.players ?? []);
const STATS = ["ma", "st", "ag", "pa", "av"] as const;

const eligible = (s: Side): number => (props.teams[s]?.players ?? []).filter((p) => !p.dead && !p.mng).length;
const size = (s: Side): number => props.teams[s]?.players.length ?? 0;
const line = (p: RosterPlayerView) => props.tally.players[side.value].find((l) => l.id === p.id);

/** Status badge, in the client's order: dead (RIP), injury this game, MNG, niggles. */
function badge(p: RosterPlayerView): string {
  if (p.dead || line(p)?.injury?.result === "DEAD") return "RIP";
  const inj = line(p)?.injury?.result;
  if (inj) return inj === "stat loss" ? "STAT" : inj;
  if (p.mng) return "MNG";
  if (p.niggles) return "NI";
  return "";
}
/** MA and ST are plain values; AG, PA and AV are target numbers ("3+"); null / missing = "-". */
const stat = (p: RosterPlayerView, k: (typeof STATS)[number]): string => {
  const v = p[k];
  if (v === undefined || v === null) return "-";
  return k === "ma" || k === "st" ? String(v) : `${v}+`;
};
const spp = (p: RosterPlayerView): number => p.spp + (line(p)?.sppEarned ?? 0);
const gained = (p: RosterPlayerView): number => line(p)?.sppEarned ?? 0;
</script>

<template>
  <div class="tt-modal" role="dialog" aria-label="Rosters" @click.self="emit('close')">
    <div class="tt-modal-box tt-rosters">
      <div class="tt-rosters-head">
        <span class="tt-rosters-title"><img class="tt-glyph" :src="uiIcon('football-helmet')" alt="" />Rosters</span>
        <button class="tt-close" type="button" aria-label="Close rosters" @click="emit('close')">&#10005;</button>
      </div>
      <div class="tt-roster-tabs" role="group" aria-label="Select roster team">
        <button v-for="s in sides" :key="s" type="button" class="tt-roster-tab" :data-active="side === s" @click="side = s">
          <span class="tt-roster-tab-name">{{ match[s].teamName }}</span>
          <small>{{ match[s].coach }}</small>
          <span class="tt-roster-count" :title="`${eligible(s)} of ${size(s)} players available`">{{ eligible(s) }}/{{ size(s) }}</span>
        </button>
      </div>
      <p v-if="teams[side]?.treasury !== undefined" class="tt-roster-meta muted">Treasury {{ Math.round((teams[side]?.treasury ?? 0) / 1000) }}k</p>
      <ul class="tt-roster-list">
        <li v-if="!players.length" class="muted">No player records.</li>
        <li v-for="p in players" :key="p.id" :data-out="p.dead || p.mng ? 'true' : null">
          <span class="tt-lvl" :data-injury="badge(p) || null">{{ badge(p) }}</span>
          <span class="tt-roster-nr">{{ p.number !== undefined ? `#${p.number}` : "" }}</span>
          <span class="tt-roster-name">{{ p.name }}</span>
          <span class="tt-roster-pos">{{ p.positionName ?? p.position ?? p.positionId ?? "" }}</span>
          <span class="tt-roster-stats">
            <span v-for="k in STATS" :key="k"><small>{{ k.toUpperCase() }}</small>{{ stat(p, k) }}</span>
          </span>
          <span v-if="p.skills?.length" class="tt-roster-skills">
            <span v-for="(sk, i) in p.skills" :key="`${sk}-${i}`" class="tt-skill">{{ sk }}</span>
          </span>
          <span v-if="p.injuries?.length" class="tt-roster-inj muted">{{ p.injuries.join(", ") }}</span>
          <span class="tt-roster-spp" :data-zero="spp(p) === 0">{{ spp(p) }} SPP<b v-if="gained(p)" class="tt-gain"> (+{{ gained(p) }})</b></span>
        </li>
      </ul>
    </div>
  </div>
</template>
