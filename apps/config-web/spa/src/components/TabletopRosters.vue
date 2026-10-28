<script setup lang="ts">
// Rosters popout in the Super FUMBBL client's roster language: team switch (coach-panel tabs with an eligible/size
// count and a chip row), then one bezelled card per player: sprite, number, seat-tinted name, position, five stat
// boxes (a stat above or below the printed one is marked), categorised skill chips (added skills in the gold box),
// status badge and SPP. Rows come from the team files the server returned; whatever the file lacks shows as a dash.
import { computed, ref } from "vue";
import { uiIcon } from "../tabletop/feed";
import type { MatchView, RosterPlayerView, ServerTally, Side, TeamView } from "../tabletop/recorder";

const props = defineProps<{ match: MatchView; teams: Record<Side, TeamView | undefined>; tally: ServerTally }>();
const emit = defineEmits<{ (e: "close"): void }>();

const sides: Side[] = ["home", "away"];
const side = ref<Side>("home");
const open = ref("");
const players = computed(() => props.teams[side.value]?.players ?? []);
const STATS = ["ma", "st", "ag", "pa", "av"] as const;
type StatKey = (typeof STATS)[number];

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
const stat = (p: RosterPlayerView, k: StatKey): string => {
  const v = p[k];
  if (v === undefined || v === null) return "-";
  return k === "ma" || k === "st" ? String(v) : `${v}+`;
};
/** +1 when the stat is better than the position's printed one, -1 when worse (AG / PA / AV: AG and PA improve downwards). */
function change(p: RosterPlayerView, k: StatKey): number {
  const base = p.printedStats?.[k];
  const now = p[k];
  if (base === undefined || base === null || now === undefined || now === null || base === now) return 0;
  const better = k === "ag" || k === "pa" ? now < base : now > base;
  return better ? 1 : -1;
}
const spp = (p: RosterPlayerView): number => p.spp + (line(p)?.sppEarned ?? 0);
const gained = (p: RosterPlayerView): number => line(p)?.sppEarned ?? 0;
const skillClass = (category: string): string => {
  const c = category.toLowerCase();
  return ["general", "agility", "strength", "passing", "mutation"].includes(c) ? `skill-${c}` : "skill-trait";
};
/** Printed then added skills with their category; a team file without the split lists its skills as traits. */
const printed = (p: RosterPlayerView): Array<{ name: string; category: string }> => p.printed ?? (p.added ? [] : (p.skills ?? []).map((name) => ({ name, category: "Trait" })));
const added = (p: RosterPlayerView): Array<{ name: string; category: string }> => p.added ?? [];
const initials = (p: RosterPlayerView): string => (p.positionName ?? p.position ?? p.positionId ?? p.name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const spriteSrc = (p: RosterPlayerView): string => (typeof p.sprite === "string" && /^sprites\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.png$/.test(p.sprite) ? `/${p.sprite}` : "");
const toggle = (id: string): void => { open.value = open.value === id ? "" : id; };
</script>

<template>
  <div class="tt-modal" role="dialog" aria-label="Rosters" @click.self="emit('close')">
    <div class="tt-modal-box tt-rosters">
      <div class="tt-rosters-head">
        <span class="tt-rosters-title"><img class="tt-glyph" :src="uiIcon('football-helmet')" alt="" />Rosters</span>
        <p class="tv-key" aria-label="Skill key">
          <span class="skill skill-general">General</span><span class="skill skill-agility">Agility</span><span class="skill skill-strength">Strength</span><span class="skill skill-passing">Passing</span><span class="skill skill-mutation">Mutation</span><span class="skill skill-trait">Trait</span><span class="skill tv-added skill-general">Added</span>
        </p>
        <button class="tt-close" type="button" aria-label="Close rosters" @click="emit('close')">&#10005;</button>
      </div>
      <div class="tt-roster-tabs" role="group" aria-label="Select roster team">
        <button v-for="s in sides" :key="s" type="button" class="tt-roster-tab" :data-seat="s" :data-active="side === s" @click="side = s">
          <span class="tt-roster-tab-name">{{ match[s].teamName }}</span>
          <small class="tt-roster-coach">{{ match[s].coach }}</small>
          <span class="tt-roster-chips">
            <span v-if="teams[s]?.rerolls" class="tt-roster-chip" title="Team rerolls">RR {{ teams[s]?.rerolls }}</span>
            <span v-if="teams[s]?.apothecary" class="tt-roster-chip" title="Apothecary">Apo</span>
            <span v-if="teams[s]?.teamValue" class="tt-roster-chip" title="Team value">TV {{ Math.round((teams[s]?.teamValue ?? 0) / 1000) }}k</span>
          </span>
          <span class="tt-roster-count" :title="`${eligible(s)} of ${size(s)} players available`">{{ eligible(s) }}/{{ size(s) }}</span>
        </button>
      </div>
      <p v-if="teams[side]?.treasury !== undefined" class="tt-roster-meta muted">Treasury {{ Math.round((teams[side]?.treasury ?? 0) / 1000) }}k</p>
      <ul class="tt-roster-list">
        <li v-if="!players.length" class="muted">No player records.</li>
        <li v-for="p in players" :key="p.id" class="tt-rp" :data-out="p.dead || p.mng ? 'true' : null" :data-dead="p.dead ? 'true' : null" :data-active="open === p.id ? 'true' : null" @click="toggle(p.id)">
          <span class="tv-sprite" aria-hidden="true"><span class="sprite-fallback">{{ initials(p) }}</span><img v-if="spriteSrc(p)" class="sprite-image" :src="spriteSrc(p)" alt="" loading="lazy" decoding="async" /></span>
          <span class="tt-rp-who">
            <span class="tt-rp-top">
              <span class="tt-lvl" :data-injury="badge(p) || null">{{ badge(p) }}</span>
              <span class="tt-roster-nr">{{ p.number !== undefined ? `#${p.number}` : "" }}</span>
              <span class="tt-roster-name" :data-seat="side">{{ p.name }}</span>
            </span>
            <span class="tt-roster-pos">{{ p.positionName ?? p.position ?? p.positionId ?? "" }}</span>
          </span>
          <span class="tt-roster-stats">
            <span v-for="k in STATS" :key="k" class="tv-stat-box" :data-change="change(p, k) || null"><small>{{ k.toUpperCase() }}</small>{{ stat(p, k) }}<i v-if="change(p, k)" class="tv-up-mark" :class="change(p, k) > 0 ? 'tv-up' : 'tv-down'">{{ change(p, k) > 0 ? "▲" : "▼" }}</i></span>
          </span>
          <span v-if="printed(p).length || added(p).length" class="tt-roster-skills row-skills">
            <span v-for="(sk, i) in printed(p)" :key="`${sk.name}-${i}`" class="skill tt-skill" :class="skillClass(sk.category)">{{ sk.name }}</span>
            <span v-for="(sk, i) in added(p)" :key="`a-${sk.name}-${i}`" class="skill tt-skill tv-added" :class="skillClass(sk.category)" :title="`Skill added: ${sk.name}`">{{ sk.name }}</span>
          </span>
          <span class="tt-roster-spp" :data-zero="spp(p) === 0">{{ spp(p) }} SPP<b v-if="gained(p)" class="tt-gain"> (+{{ gained(p) }})</b></span>
          <span v-if="open === p.id || p.injuries?.length" class="tt-roster-inj">
            <template v-if="p.injuries?.length">&#9877; {{ p.injuries.join(" · ") }}</template>
            <template v-if="open === p.id"><span class="muted"> {{ p.unavailableReason ?? (p.available === false ? "Unavailable" : "Available") }}<template v-if="p.niggles"> · {{ p.niggles }} niggling</template></span></template>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>
