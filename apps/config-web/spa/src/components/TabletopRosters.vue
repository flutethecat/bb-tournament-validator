<script setup lang="ts">
// Rosters popout in the Tournament Team Builder's language: notebook team tabs (crest, name, coach, an eligible/size
// count and icon chips for rerolls, apothecary, staff and fans), then the builder's roster grid (header band, one
// zebra row per player, via the shared TabletopRosterRow) and an Inducements table under it. Rows come from the team
// files the server returned; whatever the file lacks shows as a dash. Hover tips ride data-tip.
import { computed, onMounted, ref } from "vue";
import type { ArtManifests } from "../tabletop/art";
import { uiIcon } from "../tabletop/feed";
import type { MatchView, RecordedEvent, ServerTally, Side, TeamView } from "../tabletop/recorder";
import TabletopRosterRow from "./TabletopRosterRow.vue";
import TabletopSheetHead from "./TabletopSheetHead.vue";
import TabletopTeamTab from "./TabletopTeamTab.vue";

const props = defineProps<{
  match: MatchView; teams: Record<Side, TeamView | undefined>; tally: ServerTally; art?: ArtManifests;
  events?: RecordedEvent[]; inducementIcons?: Record<string, string>; initialSide?: Side;
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const sides: Side[] = ["home", "away"];
const side = ref<Side>(props.initialSide ?? "home");
const open = ref("");
const players = computed(() => props.teams[side.value]?.players ?? []);

const eligible = (s: Side): number => (props.teams[s]?.players ?? []).filter((p) => !p.dead && !p.mng).length;
const size = (s: Side): number => props.teams[s]?.players.length ?? 0;
const line = (id: string) => props.tally.players[side.value].find((l) => l.id === id);
// a team opened from the hero's "+K" chip scrolls to its Inducements table
onMounted(() => { if (props.initialSide) document.querySelector(".tt-ind")?.scrollIntoView({ block: "nearest" }); });
const toggle = (id: string): void => { open.value = open.value === id ? "" : id; };

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
      <TabletopSheetHead title="Rosters" @close="emit('close')">
        <p class="skill-key skill-key-compact" aria-label="Skill key">
          <span class="skill skill-general">General</span><span class="skill skill-agility">Agility</span><span class="skill skill-strength">Strength</span><span class="skill skill-passing">Passing</span><span class="skill skill-mutation">Mutation</span><span class="skill skill-trait">Trait</span><span class="skill tv-added skill-general">Added</span>
        </p>
      </TabletopSheetHead>
      <div class="tt-roster-tabs" role="group" aria-label="Select roster team">
        <TabletopTeamTab
          v-for="s in sides" :key="s" :match="match" :teams="teams" :side="s" :active="side === s" :art="art" :inducement-icons="inducementIcons"
          :count="`${eligible(s)}/${size(s)}`" :count-tip="`${eligible(s)} of ${size(s)} players available`" @select="side = s"
        />
      </div>
      <div class="tt-roster-page">
        <p v-if="teams[side]?.treasury !== undefined" class="tt-roster-meta muted">Treasury {{ Math.round((teams[side]?.treasury ?? 0) / 1000) }}k</p>
        <div class="roster-grid roster-header" aria-hidden="true"><span>#</span><span></span><span>Player</span><span class="tt-hd-stats">Stats</span><span>Skills</span><span class="tt-hd-spp">SPP</span></div>
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
