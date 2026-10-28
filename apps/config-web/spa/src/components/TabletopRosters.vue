<script setup lang="ts">
// Rosters popout in the Tournament Team Builder's language: notebook team tabs (crest, name, coach, an eligible/size
// count and a chip row), then the builder's roster grid: a header band and one zebra row per player (slot number,
// sprite frame, player copy, row-stats boxes, row-skills chips, cost-style SPP). Rows come from the team files the
// server returned; whatever the file lacks shows as a dash. Hover tips ride data-tip (see the recorder's tooltip).
import { computed, ref } from "vue";
import { resolveCrest, type ArtManifests } from "../tabletop/art";
import { uiIcon } from "../tabletop/feed";
import type { MatchView, RosterPlayerView, ServerTally, Side, TeamView } from "../tabletop/recorder";

const props = defineProps<{ match: MatchView; teams: Record<Side, TeamView | undefined>; tally: ServerTally; art?: ArtManifests }>();
const emit = defineEmits<{ (e: "close"): void }>();

const sides: Side[] = ["home", "away"];
const side = ref<Side>("home");
const open = ref("");
const players = computed(() => props.teams[side.value]?.players ?? []);
const STATS = ["ma", "st", "ag", "pa", "av"] as const;
type StatKey = (typeof STATS)[number];
const STAT_NAMES: Record<StatKey, string> = { ma: "Movement Allowance", st: "Strength", ag: "Agility", pa: "Passing Ability", av: "Armour Value" };

const eligible = (s: Side): number => (props.teams[s]?.players ?? []).filter((p) => !p.dead && !p.mng).length;
const size = (s: Side): number => props.teams[s]?.players.length ?? 0;
const line = (p: RosterPlayerView) => props.tally.players[side.value].find((l) => l.id === p.id);
const crest = (s: Side): string => (props.art ? resolveCrest(props.art, props.teams[s]?.rosterId ?? props.teams[s]?.race) : "");
const crestInitials = (s: Side): string => (props.match[s].teamName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();

/** Status badge, in the client's order: dead (RIP), injury this game, MNG, niggles. */
function badge(p: RosterPlayerView): string {
  if (p.dead || line(p)?.injury?.result === "DEAD") return "RIP";
  const inj = line(p)?.injury?.result;
  if (inj) return inj === "stat loss" ? "STAT" : inj;
  if (p.mng) return "MNG";
  if (p.niggles) return "NI";
  return "";
}
const BADGE_NAMES: Record<string, string> = { RIP: "Dead", KO: "Knocked out", stunned: "Stunned", BH: "Badly Hurt", MNG: "Miss Next Game", NI: "Niggling Injury", STAT: "Characteristic reduced" };
/** MA and ST are plain values; AG, PA and AV are target numbers ("3+"); null / missing = "-". */
const stat = (p: RosterPlayerView, k: StatKey): string => {
  const v = p[k];
  if (v === undefined || v === null) return "-";
  return k === "ma" || k === "st" ? String(v) : `${v}+`;
};
/** +1 when the stat is better than the position's printed one, -1 when worse (AG / PA improve downwards). */
function change(p: RosterPlayerView, k: StatKey): number {
  const base = p.printedStats?.[k];
  const now = p[k];
  if (base === undefined || base === null || now === undefined || now === null || base === now) return 0;
  const better = k === "ag" || k === "pa" ? now < base : now > base;
  return better ? 1 : -1;
}
const statTip = (p: RosterPlayerView, k: StatKey): string => {
  const c = change(p, k);
  const base = p.printedStats?.[k];
  return `${STAT_NAMES[k]}${c && base !== undefined && base !== null ? ` (printed ${k === "ma" || k === "st" ? base : `${base}+`})` : ""}`;
};
const spp = (p: RosterPlayerView): number => p.spp + (line(p)?.sppEarned ?? 0);
const gained = (p: RosterPlayerView): number => line(p)?.sppEarned ?? 0;
const sppTip = (p: RosterPlayerView): string => `${spp(p)} SPP${gained(p) ? `, +${gained(p)} this match` : ""}`;
const skillClass = (category: string): string => {
  const c = category.toLowerCase();
  return ["general", "agility", "strength", "passing", "mutation"].includes(c) ? `skill-${c}` : "skill-trait";
};
const skillTip = (sk: { name: string; category: string }, isAdded: boolean): string => `${sk.name}: ${sk.category} skill${isAdded ? ", added" : ""}`;
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
        <h2 class="section-title tt-rosters-title"><img class="tt-glyph" :src="uiIcon('football-helmet')" alt="" />Rosters</h2>
        <p class="skill-key skill-key-compact" aria-label="Skill key">
          <span class="skill skill-general">General</span><span class="skill skill-agility">Agility</span><span class="skill skill-strength">Strength</span><span class="skill skill-passing">Passing</span><span class="skill skill-mutation">Mutation</span><span class="skill skill-trait">Trait</span><span class="skill chosen-chip skill-general">Added</span>
        </p>
        <button class="tt-close" type="button" aria-label="Close rosters" @click="emit('close')">&#10005;</button>
      </div>
      <div class="tt-roster-tabs" role="group" aria-label="Select roster team">
        <button v-for="s in sides" :key="s" type="button" class="tt-roster-tab" :data-seat="s" :data-active="side === s" @click="side = s">
          <span class="sprite-frame crest-frame" aria-hidden="true"><span class="sprite-fallback">{{ crestInitials(s) }}</span><img v-if="crest(s)" class="crest-image" :src="crest(s)" alt="" /></span>
          <span class="tt-roster-tab-main">
            <span class="tt-roster-tab-name">{{ match[s].teamName }}</span>
            <small class="tt-roster-coach">{{ match[s].coach }}</small>
            <span class="tt-roster-chips">
              <span v-if="teams[s]?.rerolls" class="tt-roster-chip" :data-tip="`Team rerolls: ${teams[s]?.rerolls}`">RR {{ teams[s]?.rerolls }}</span>
              <span v-if="teams[s]?.apothecary" class="tt-roster-chip" data-tip="Apothecary">Apo</span>
              <span v-if="teams[s]?.teamValue" class="tt-roster-chip" data-tip="Team value">TV {{ Math.round((teams[s]?.teamValue ?? 0) / 1000) }}k</span>
            </span>
          </span>
          <span class="tt-roster-count" :data-tip="`${eligible(s)} of ${size(s)} players available`">{{ eligible(s) }}/{{ size(s) }}</span>
        </button>
      </div>
      <div class="tt-roster-page">
        <p v-if="teams[side]?.treasury !== undefined" class="tt-roster-meta muted">Treasury {{ Math.round((teams[side]?.treasury ?? 0) / 1000) }}k</p>
        <div class="roster-grid roster-header" aria-hidden="true"><span>#</span><span>Player</span><span>Stats</span><span>Skills</span><span class="tt-hd-spp">SPP</span></div>
        <ul class="tt-roster-list">
          <li v-if="!players.length" class="muted roster-empty">No player records.</li>
          <li v-for="p in players" :key="p.id" class="roster-row roster-grid tt-rp" :data-out="p.dead || p.mng ? 'true' : null" :data-dead="p.dead ? 'true' : null" :data-active="open === p.id ? 'true' : null" @click="toggle(p.id)">
            <span class="slot-number tt-roster-nr">{{ p.number !== undefined ? `#${p.number}` : "" }}</span>
            <div class="player-cell">
              <span class="sprite-frame roster-sprite" aria-hidden="true"><span class="sprite-fallback">{{ initials(p) }}</span><img v-if="spriteSrc(p)" class="sprite-image" :src="spriteSrc(p)" alt="" loading="lazy" decoding="async" /></span>
              <span class="player-copy">
                <strong class="tt-roster-name" :data-seat="side">{{ p.name }}</strong>
                <small class="tt-roster-pos">{{ p.positionName ?? p.position ?? p.positionId ?? "" }}</small>
                <span class="tt-lvl" :data-injury="badge(p) || null" :data-tip="BADGE_NAMES[badge(p)] ?? null">{{ badge(p) }}</span>
              </span>
            </div>
            <div class="row-stats">
              <span v-for="k in STATS" :key="k" :class="{ improved: change(p, k) > 0, worse: change(p, k) < 0 }" :data-tip="statTip(p, k)"><b>{{ stat(p, k) }}</b><small>{{ k.toUpperCase() }}</small></span>
            </div>
            <div class="row-skills">
              <span v-for="(sk, i) in printed(p)" :key="`${sk.name}-${i}`" class="skill" :class="skillClass(sk.category)" :data-tip="skillTip(sk, false)">{{ sk.name }}</span>
              <span v-for="(sk, i) in added(p)" :key="`a-${sk.name}-${i}`" class="chosen-chip skill" :class="skillClass(sk.category)" :data-tip="skillTip(sk, true)">{{ sk.name }}</span>
            </div>
            <span class="cost tt-roster-spp" :data-zero="spp(p) === 0" :data-tip="sppTip(p)">{{ spp(p) }} SPP<b v-if="gained(p)" class="tt-gain"> (+{{ gained(p) }})</b></span>
            <span v-if="open === p.id || p.injuries?.length" class="tt-roster-inj">
              <template v-if="p.injuries?.length">&#9877; {{ p.injuries.join(" · ") }}</template>
              <template v-if="open === p.id"><span class="muted"> {{ p.unavailableReason ?? (p.available === false ? "Unavailable" : "Available") }}<template v-if="p.niggles"> · {{ p.niggles }} niggling</template></span></template>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
