<script setup lang="ts">
// The shared team summary (team page v2; league UX pass Q4: "the team page becomes the Roster Builder Summary"; owner 11-11:
// the same look on the Roster Builder's last step and the share link, with portraits). ONE component on the league team
// page (LeagueTeams.vue), the Roster Builder's Summary step (TournamentBuilderSummary.vue) and the public share page
// (TeamShareView.vue): the identity block (crest or team avatar, name, caption, the race's special rules), the header strip
// (team value, treasury, rerolls, fans, staff, tier), the awards, the table-style roster (TeamRosterTable, a portrait per
// player) with the hire / staff accordions on its left when the viewer may hire, the panel row (the model's Team costs and
// Inducements plus what the page adds; right of the roster on 1920-class screens), "Left the roster", and slots for what
// each page adds (assign coach, the status cog, the redraft budget, history). Organiser edit mode turns the strip's numbers
// into inputs. It renders only what it is given (teams/summary.ts builds the model).
import { computed, ref, useSlots } from "vue";
import { artInitials, type RosterCan, type SummaryMode, type SummaryRow, type SummaryTeam } from "../teams/summary";
import TeamRosterTable from "./TeamRosterTable.vue";
import "../leagues/leagues.css";
import "../teams/summary.css";

const props = withDefaults(defineProps<{
  team: SummaryTeam;
  mode?: SummaryMode;
  focusId?: string;
  busy?: boolean;
  can?: RosterCan;
  /** The summary's own band heading id (the builder and the league page both label their panel with it). */
  headingId?: string;
  /** Opt-in (TeamRosterTable): each player name is a button with this accessible name that emits `open`. */
  openLabel?: (r: SummaryRow) => string;
  /** The hidden heading of the roster's per-row actions column (the `row-actions` slot). */
  rowActionsLabel?: string;
}>(), { mode: "view", focusId: "", busy: false, can: () => ({}), headingId: "", openLabel: undefined, rowActionsLabel: "Actions" });
const emit = defineEmits<{
  rename: [id: string, name: string]; renumber: [id: string, n: number]; fire: [id: string]; plus: [id: string, el: HTMLElement];
  set: [id: string, field: string, value: number | boolean]; removeSkill: [id: string, skill: string]; fact: [field: string, value: number | boolean];
  open: [id: string, el: HTMLElement];
}>();
const slots = useSlots();
/** Read on every render: slots are not reactive, and the left slot comes and goes with the edit mode. */
const hasLeft = (): boolean => Boolean(slots.left);
const editFacts = computed(() => props.mode === "organiser");
const hid = computed(() => props.headingId || `ts-h-${props.team.id}`);
/** A crest or avatar file that failed to load: the frame keeps the team's initials. */
const crestBroken = ref("");
const crest = computed(() => (props.team.crest && props.team.crest !== crestBroken.value ? props.team.crest : ""));
const panels = computed(() => props.team.panels ?? {});
/** The panel row under the roster: the model's panels and whatever the page adds (read on every render, as hasLeft). */
const hasPanels = (): boolean => Boolean(panels.value.costs?.length || panels.value.inducements || slots.panels);

function commitFact(field: string, kind: "number" | "gold" | "bool", e: Event, raw: number | boolean | null): void {
  const el = e.target as HTMLInputElement;
  if (kind === "bool") { emit("fact", field, el.checked); return; }
  const n = Number.parseInt(el.value, 10);
  if (!Number.isFinite(n)) return;
  const v = kind === "gold" ? n * 1000 : n;
  if (v !== raw) emit("fact", field, v);
}
</script>

<template>
  <div class="ts-layout" :class="{ 'ts-with-side': hasPanels() && !hasLeft() }">
    <section class="hm-panel lg-roster ts-summary" :class="{ 'ts-wide': hasLeft() }" :data-mode="mode" :data-inactive="team.inactive ? 'true' : undefined" :aria-labelledby="hid" data-team-summary>
      <header class="hm-band ts-band">
        <span class="sprite-frame crest-frame ts-crest" aria-hidden="true" data-team-crest><span class="sprite-fallback">{{ artInitials(team.name) }}</span><img v-if="crest" class="crest-image" :src="crest" alt="" decoding="async" @error="crestBroken = crest" /></span>
        <h2 :id="hid">{{ team.name }}</h2>
        <slot name="band" />
        <span class="hm-cap ts-caption">{{ team.caption }}<small v-if="team.specialRules?.length" class="ts-rules-inline" aria-label="Special rules" data-special-rules>{{ team.specialRules.join(" / ") }}</small></span>
        <slot name="band-end" />
      </header>
      <slot name="top" />
      <dl class="lg-team-facts ts-facts">
        <div v-for="f in team.facts" :key="f.key" :data-tv="f.key === 'tv' || f.key === 'ctv' ? f.key : undefined">
          <dt>{{ f.label }}</dt>
          <dd v-if="editFacts && f.edit">
            <label v-if="f.edit.kind === 'bool'" class="ts-fact-check"><input type="checkbox" :checked="f.edit.raw === true" :disabled="busy" :aria-label="f.label" @change="commitFact(f.edit.field, 'bool', $event, f.edit.raw)" /> {{ f.edit.raw ? "Yes" : "No" }}</label>
            <span v-else class="ts-fact-in">
              <input class="ts-in" type="number" :value="f.edit.raw === null ? '' : f.edit.kind === 'gold' ? Math.round(Number(f.edit.raw) / 1000) : f.edit.raw" :aria-label="f.edit.kind === 'gold' ? `${f.label} in thousands` : f.label" :disabled="busy"
                @change="commitFact(f.edit.field, f.edit.kind, $event, f.edit.raw)" /><span v-if="f.edit.kind === 'gold'" aria-hidden="true">k</span>
            </span>
          </dd>
          <dd v-else>{{ f.value }} <small v-if="f.secondary" class="lg-tv-secondary">{{ f.secondary }}</small></dd>
        </div>
      </dl>
      <slot name="awards" />
      <div class="ts-body">
        <div v-if="hasLeft()" class="ts-left"><slot name="left" /></div>
        <div class="ts-main">
          <slot name="roster-top" />
          <p v-if="!team.rows.length" class="hm-empty">No roster recorded.</p>
          <TeamRosterTable
            v-else :rows="team.rows" :mode="mode" :season-stats="team.seasonStats" :counters="team.counters" :focus-id="focusId" :busy="busy" :can="can" :label="`${team.name} roster`" :extra-columns="team.extraColumns" :open-label="openLabel" :row-actions-label="rowActionsLabel"
            @rename="(id, v) => emit('rename', id, v)" @renumber="(id, n) => emit('renumber', id, n)" @fire="(id) => emit('fire', id)" @plus="(id, el) => emit('plus', id, el)"
            @set="(id, f, v) => emit('set', id, f, v)" @remove-skill="(id, k) => emit('removeSkill', id, k)" @open="(id, el) => emit('open', id, el)"
          >
            <template v-if="slots['row-actions']" #row-actions="{ row }"><slot name="row-actions" :row="row" /></template>
          </TeamRosterTable>
        </div>
      </div>
    </section>
    <div v-if="hasPanels()" class="ts-panels" data-summary-panels>
      <slot name="panels-start" />
      <section v-if="panels.costs?.length" class="hm-panel ts-costs" :aria-labelledby="`${hid}-costs`" data-summary-costs>
        <header class="hm-band"><h2 :id="`${hid}-costs`">Team costs</h2></header>
        <dl class="ts-pairs">
          <div v-for="c in panels.costs" :key="c.key" :data-tone="c.tone"><dt>{{ c.label }}</dt><dd>{{ c.value }}</dd></div>
        </dl>
      </section>
      <section v-if="panels.inducements" class="hm-panel ts-inducements" :aria-labelledby="`${hid}-ind`" data-summary-inducements>
        <header class="hm-band"><h2 :id="`${hid}-ind`">Inducements</h2><span v-if="panels.inducements.total" class="hm-cap">{{ panels.inducements.total }}</span></header>
        <p v-if="!panels.inducements.items.length" class="hm-empty hm-small">None</p>
        <ul v-else class="ts-ind-list">
          <li v-for="i in panels.inducements.items" :key="i.name"><img v-if="i.icon" class="ts-ind-icon" :src="i.icon" alt="" aria-hidden="true" loading="lazy" /><span>{{ i.name }}</span><b>{{ i.count }}</b></li>
        </ul>
      </section>
      <slot name="panels" />
    </div>
  </div>
  <slot name="middle" />
  <section v-if="team.former.length" class="hm-panel ts-former" :aria-label="`${team.name} former players`">
    <header class="hm-band"><h2>Left the roster</h2><span class="hm-cap">{{ team.former.length }} players</span></header>
    <div class="lg-scroll">
      <table class="lg-table">
        <thead><tr><th scope="col">Player</th><th scope="col" class="lg-num">TD</th><th scope="col" class="lg-num">CAS</th><th scope="col" class="lg-num">MVP</th><th scope="col" class="lg-num">SPP</th><th v-for="c in team.formerCounters" :key="c.key" scope="col" class="lg-num" :title="c.title">{{ c.label }}</th></tr></thead>
        <tbody>
          <tr v-for="p in team.former" :key="p.id" :id="`player-${p.id}`" :data-player="p.id" :class="{ 'lg-row-picked': p.id === focusId }" :aria-current="p.id === focusId ? 'true' : undefined">
            <th scope="row" class="lg-team-cell"><span class="lg-team-name">{{ p.name }}</span><small>{{ p.position }}</small></th>
            <td class="lg-num">{{ p.td }}</td><td class="lg-num">{{ p.cas }}</td><td class="lg-num">{{ p.mvp }}</td><td class="lg-num lg-pts">{{ p.spp }}</td>
            <td v-for="c in team.formerCounters" :key="c.key" class="lg-num" :data-counter="c.key">{{ p.counters[c.key] ?? 0 }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <slot name="after" />
</template>
