<script setup lang="ts">
// Rosters popout in the Tournament Team Builder's language: notebook team tabs (crest, name, coach, an eligible/size
// count and icon chips for rerolls, apothecary, staff and fans), then the builder's roster grid (header band, one
// zebra row per player, via the shared TabletopRosterRow) and an Inducements table under it. Rows come from the team
// files the server returned; whatever the file lacks shows as a dash. Hover tips ride data-tip.
import { computed, ref } from "vue";
import { resolveCrest, type ArtManifests } from "../tabletop/art";
import { uiIcon } from "../tabletop/feed";
import type { MatchView, RecordedEvent, ServerTally, Side, TeamView } from "../tabletop/recorder";
import TabletopRosterRow from "./TabletopRosterRow.vue";

const props = defineProps<{
  match: MatchView; teams: Record<Side, TeamView | undefined>; tally: ServerTally; art?: ArtManifests;
  events?: RecordedEvent[]; inducementIcons?: Record<string, string>;
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const sides: Side[] = ["home", "away"];
const side = ref<Side>("home");
const open = ref("");
const players = computed(() => props.teams[side.value]?.players ?? []);

const eligible = (s: Side): number => (props.teams[s]?.players ?? []).filter((p) => !p.dead && !p.mng).length;
const size = (s: Side): number => props.teams[s]?.players.length ?? 0;
const line = (id: string) => props.tally.players[side.value].find((l) => l.id === id);
const crest = (s: Side): string => {
  const a = props.teams[s]?.avatarUrl;
  if (typeof a === "string" && /^\/[\w./-]+$/.test(a)) return a;
  return props.art ? resolveCrest(props.art, props.teams[s]?.rosterId ?? props.teams[s]?.race) : "";
};
const crestInitials = (s: Side): string => (props.match[s].teamName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();
const toggle = (id: string): void => { open.value = open.value === id ? "" : id; };

interface Chip { key: string; src: string; label: string; qty: number; show: boolean }
const iconPath = (key: string, fallback: string): string => (props.inducementIcons?.[key] ? `/${props.inducementIcons[key]}` : fallback);
/** Icon chips for the tab: rerolls, apothecary, assistant coaches, cheerleaders, dedicated fans; a zero count hides the chip. */
function chips(s: Side): Chip[] {
  const t = props.teams[s];
  if (!t) return [];
  const out: Chip[] = [
    { key: "rr", src: uiIcon("re_roll"), label: "Team rerolls", qty: t.rerolls ?? 0, show: (t.rerolls ?? 0) > 0 },
    { key: "apo", src: uiIcon("apothecary"), label: "Apothecary", qty: 1, show: t.apothecary === true },
    { key: "ac", src: iconPath("part_time_assistant_coaches", "/icons/inducements/part_time_assistant_coaches.png"), label: "Assistant coaches", qty: t.assistantCoaches ?? 0, show: (t.assistantCoaches ?? 0) > 0 },
    { key: "ch", src: iconPath("temp_agency_cheerleaders", "/icons/inducements/temp_agency_cheerleaders.png"), label: "Cheerleaders", qty: t.cheerleaders ?? 0, show: (t.cheerleaders ?? 0) > 0 },
    { key: "fans", src: uiIcon("dedicated_fans"), label: "Dedicated fans", qty: t.dedicatedFans ?? 0, show: (t.dedicatedFans ?? 0) > 0 },
  ];
  return out.filter((c) => c.show);
}
const chipTip = (c: Chip): string => (c.key === "apo" ? c.label : `${c.label}: ${c.qty}`);

/** The inducements the team bought: its latest pre-game submission (picks carry name, qty and cost). */
interface IndRow { key: string; name: string; qty: number; cost: number | null; src: string }
const inducements = computed((): { rows: IndRow[]; total: number | null } | null => {
  if (!props.events) return null;
  const e = [...props.events].reverse().find((x) => x.type === "inducement" && x.team === side.value);
  if (!e) return { rows: [], total: null };
  const picks = Array.isArray(e.payload.picks) ? (e.payload.picks as Array<Record<string, unknown>>) : [];
  const rows = picks.map((k, i): IndRow => {
    const id = String(k.id ?? "");
    const name = String(k.name ?? id);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const path = props.inducementIcons?.[id] ?? props.inducementIcons?.[slug] ?? props.inducementIcons?.[`${slug}s`];
    return { key: `${id}-${i}`, name, qty: Number(k.qty ?? 1), cost: typeof k.cost === "number" ? k.cost : null, src: path ? `/${path}` : "" };
  });
  return { rows, total: typeof e.payload.total === "number" ? e.payload.total : null };
});
const gold = (n: number): string => `${Math.round(n / 1000)}k`;
</script>

<template>
  <div class="tt-modal" role="dialog" aria-label="Rosters" @click.self="emit('close')">
    <div class="tt-modal-box tt-rosters">
      <div class="tt-rosters-head">
        <h2 class="section-title tt-rosters-title"><img class="tt-glyph" :src="uiIcon('football-helmet')" alt="" />Rosters</h2>
        <p class="skill-key skill-key-compact" aria-label="Skill key">
          <span class="skill skill-general">General</span><span class="skill skill-agility">Agility</span><span class="skill skill-strength">Strength</span><span class="skill skill-passing">Passing</span><span class="skill skill-mutation">Mutation</span><span class="skill skill-trait">Trait</span><span class="skill tv-added skill-general">Added</span>
        </p>
        <button class="tt-close" type="button" aria-label="Close rosters" @click="emit('close')">&#10005;</button>
      </div>
      <div class="tt-roster-tabs" role="group" aria-label="Select roster team">
        <button v-for="s in sides" :key="s" type="button" class="tt-roster-tab" :data-seat="s" :data-active="side === s" @click="side = s">
          <span class="sprite-frame crest-frame tt-crest-frame" aria-hidden="true"><span class="sprite-fallback">{{ crestInitials(s) }}</span><img v-if="crest(s)" class="crest-image" :src="crest(s)" alt="" /></span>
          <span class="tt-roster-tab-main">
            <span class="tt-roster-tab-name">{{ match[s].teamName }}</span>
            <small class="tt-roster-coach">{{ match[s].coach }}</small>
            <span class="tt-roster-chips">
              <span v-for="c in chips(s)" :key="c.key" class="tt-rchip" :data-tip="chipTip(c)"><img class="tt-rchip-img" :src="c.src" alt="" /><b v-if="c.key !== 'apo' && c.qty > 0" class="tt-qty">{{ c.qty }}</b></span>
              <span v-if="teams[s]?.teamValue" class="tt-roster-chip" data-tip="Team value">TV {{ Math.round((teams[s]?.teamValue ?? 0) / 1000) }}k</span>
            </span>
          </span>
          <span class="tt-roster-count" :data-tip="`${eligible(s)} of ${size(s)} players available`">{{ eligible(s) }}/{{ size(s) }}</span>
        </button>
      </div>
      <div class="tt-roster-page">
        <p v-if="teams[side]?.treasury !== undefined" class="tt-roster-meta muted">Treasury {{ Math.round((teams[side]?.treasury ?? 0) / 1000) }}k</p>
        <div class="roster-grid roster-header" aria-hidden="true"><span>#</span><span>Player</span><span class="tt-hd-stats">Stats</span><span>Skills</span><span class="tt-hd-spp">SPP</span></div>
        <ul class="tt-roster-list">
          <li v-if="!players.length" class="muted roster-empty">No player records.</li>
          <TabletopRosterRow v-for="p in players" :key="p.id" :player="p" :side="side" :line="line(p.id)" :open="open === p.id" @select="toggle(p.id)" />
        </ul>
        <section v-if="inducements" class="tt-ind" aria-label="Inducements">
          <h3 class="section-title tt-ind-title">Inducements</h3>
          <table class="tt-ind-table">
            <tbody>
              <tr v-if="!inducements.rows.length"><td colspan="3" class="muted">None</td></tr>
              <tr v-for="r in inducements.rows" :key="r.key">
                <td class="tt-ind-cell"><img v-if="r.src" class="tt-ind-icon" :src="r.src" alt="" aria-hidden="true" /><span>{{ r.name }}</span></td>
                <td class="num">{{ r.qty }}</td>
                <td class="num">{{ r.cost !== null ? gold(r.cost) : "" }}</td>
              </tr>
            </tbody>
            <tfoot v-if="inducements.total !== null"><tr><th scope="row" colspan="2">Total</th><td class="num">{{ gold(inducements.total) }}</td></tr></tfoot>
          </table>
        </section>
      </div>
    </div>
  </div>
</template>
