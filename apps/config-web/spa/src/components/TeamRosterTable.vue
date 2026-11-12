<script setup lang="ts">
// The table-style roster of the shared team summary (team page v2; owner's reference: the league team page): number,
// a portrait (TabletopRosterRow's sprite frame: the generated sprite, initials when there is none; not in the organiser's
// edit mode), player (name over position and level), MA / ST / AG / PA / AV, skills (custom stars' special rules under them), then the
// season columns (TD, CAS, MVP, SPP, the Super FUMBBL counters a player has, unspent SPP, Seasons Played) and the value.
// The same table serves the league page and the Roster Builder (teams/summary.ts holds the row model). Editing is opt-in
// per capability: rename / renumber (coach and organiser), +/- over the stats and every number (organiser edit mode),
// skill chips with a remove badge, the row "+" (skills; the organiser's band-aid lives in the menu it opens) and fire.
import { computed, reactive } from "vue";
import type { RosterCan, SummaryCounter, SummaryMode, SummaryRow } from "../teams/summary";
import { artInitials, kValue, statStep } from "../teams/summary";

const props = withDefaults(defineProps<{
  rows: SummaryRow[];
  mode?: SummaryMode;
  seasonStats?: boolean;
  counters?: SummaryCounter[];
  focusId?: string;
  busy?: boolean;
  /** Edit capabilities (all off = the read-only table). */
  can?: RosterCan;
  label?: string;
}>(), { mode: "view", seasonStats: true, counters: () => [], focusId: "", busy: false, can: () => ({}), label: "Roster" });
const emit = defineEmits<{
  rename: [id: string, name: string]; renumber: [id: string, n: number]; fire: [id: string]; plus: [id: string, el: HTMLElement];
  set: [id: string, field: string, value: number | boolean]; removeSkill: [id: string, skill: string];
}>();

type Stat = "ma" | "st" | "ag" | "pa" | "av";
const STATS: ReadonlyArray<{ key: Stat; label: string; plus: boolean }> = [
  { key: "ma", label: "MA", plus: false }, { key: "st", label: "ST", plus: false }, { key: "ag", label: "AG", plus: true }, { key: "pa", label: "PA", plus: true }, { key: "av", label: "AV", plus: true },
];
const shown = (r: SummaryRow, s: (typeof STATS)[number]): string => (r[s.key] === null ? "-" : `${r[s.key]}${s.plus ? "+" : ""}`);
const seasons = computed(() => props.seasonStats && (props.can.numbers || props.rows.some((r) => (r.seasonsPlayed ?? 0) > 0)));
const actions = computed(() => Boolean(props.can.fire || props.can.plus));
const editing = computed(() => Boolean(props.can.rename || props.can.renumber || props.can.stats || props.can.numbers));
/** The portrait column, except in the organiser's edit mode, where the steppers and number inputs need the width. */
const portraits = computed(() => !(props.can.stats || props.can.numbers));
/** Portraits whose file failed to load: the frame keeps its initials (a missing file never shows a broken image). */
const broken = reactive(new Set<string>());
const who = (r: SummaryRow): string => `${r.name || r.position}${r.number !== null ? ` #${r.number}` : ""}`;

function commitName(r: SummaryRow, e: Event): void {
  const v = (e.target as HTMLInputElement).value.trim();
  if (v !== r.name) emit("rename", r.id, v);
}
function commitNumber(r: SummaryRow, e: Event): void {
  const n = Number.parseInt((e.target as HTMLInputElement).value, 10);
  if (Number.isFinite(n) && n !== r.number) emit("renumber", r.id, n);
  else (e.target as HTMLInputElement).value = r.number === null ? "" : String(r.number);
}
function commitNum(r: SummaryRow, field: string, current: number | null, e: Event, scale = 1): void {
  const n = Number.parseInt((e.target as HTMLInputElement).value, 10);
  if (Number.isFinite(n) && n * scale !== current) emit("set", r.id, field, n * scale);
}
function step(r: SummaryRow, s: Stat, better: boolean): void {
  const to = statStep(s, r[s], better);
  if (to !== null) emit("set", r.id, s, to);
}
const removable = (skill: { added?: boolean }): boolean => props.can.removeSkill === "all" || (props.can.removeSkill === "added" && skill.added === true);
const NUMBER_COLS: ReadonlyArray<{ key: "td" | "cas" | "mvp" | "spp"; field: string; label: string; title: string }> = [
  { key: "td", field: "td", label: "TD", title: "Touchdowns this season" }, { key: "cas", field: "cas", label: "CAS", title: "Casualties caused (inflicted) this season" },
  { key: "mvp", field: "mvp", label: "MVP", title: "MVP awards this season" }, { key: "spp", field: "spp", label: "SPP", title: "SPP earned this season" },
];
</script>

<template>
  <div class="lg-scroll ts-table-wrap">
    <table class="lg-table lg-players ts-table" :class="{ 'ts-editing': editing }" :aria-label="label" :aria-busy="busy ? 'true' : undefined">
      <thead>
        <tr>
          <th scope="col" class="lg-num">#</th><th v-if="portraits" scope="col" class="ts-sprite-h"><span class="tn-sr">Portrait</span></th><th scope="col">Player</th>
          <th v-for="s in STATS" :key="s.key" scope="col" class="lg-num">{{ s.label }}</th>
          <th scope="col">Skills</th>
          <template v-if="seasonStats">
            <th v-for="c in NUMBER_COLS" :key="c.key" scope="col" class="lg-num" :title="c.title">{{ c.label }}</th>
            <th v-for="c in counters" :key="c.key" scope="col" class="lg-num" :title="c.title">{{ c.label }}</th>
            <th scope="col" class="lg-num" title="Unspent SPP">Avail.</th>
            <th v-if="seasons" scope="col" class="lg-num" title="Seasons Played">Seas.</th>
          </template>
          <th scope="col" class="lg-num">Value</th>
          <th v-if="actions" scope="col" class="ts-act-h"><span class="tn-sr">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id" :id="mode === 'builder' ? undefined : `player-${r.id}`" :data-player="r.id" :class="{ 'lg-row-picked': r.id === focusId, 'ts-mng': r.mng }" :aria-current="r.id === focusId ? 'true' : undefined">
          <td class="lg-num ts-num">
            <input v-if="can.renumber && !r.star" class="ts-in ts-in-num" type="number" min="1" max="99" :value="r.number ?? ''" :aria-label="`Number for ${who(r)}`" :disabled="busy" @change="commitNumber(r, $event)" />
            <template v-else>{{ r.number ?? "" }}</template>
          </td>
          <td v-if="portraits" class="ts-sprite-cell" data-sprite-cell>
            <span class="sprite-frame ts-sprite" aria-hidden="true"><span class="sprite-fallback">{{ artInitials(r.star ? r.position : r.position || r.name) }}</span><img v-if="r.sprite && !broken.has(r.sprite)" class="sprite-image" :src="r.sprite" alt="" loading="lazy" decoding="async" @error="broken.add(r.sprite ?? '')" /></span>
          </td>
          <th scope="row" class="lg-team-cell ts-player">
            <input v-if="can.rename && !r.star" class="ts-in ts-in-name" type="text" maxlength="60" :value="r.name" :placeholder="r.position" :aria-label="`Name for ${r.position}${r.number !== null ? ` #${r.number}` : ''}`" :disabled="busy" @change="commitName(r, $event)" @keydown.enter.prevent="($event.target as HTMLInputElement).blur()" />
            <span v-else class="lg-team-name">{{ r.name || r.position }}</span>
            <small>{{ r.position }}<template v-for="s in r.sub" :key="s"> · {{ s }}</template></small>
            <label v-if="can.mng" class="ts-mng-toggle"><input type="checkbox" :checked="r.mng" :disabled="busy" @change="emit('set', r.id, 'missNextGame', ($event.target as HTMLInputElement).checked)" /> MNG</label>
            <small v-for="line in r.shared" :key="line" class="lg-shared" data-shared-total>{{ line }}</small>
          </th>
          <td v-for="s in STATS" :key="s.key" class="lg-num ts-stat">
            <span v-if="can.stats && !r.star" class="ts-stepper">
              <button type="button" class="ts-step" :aria-label="`Raise ${s.label} of ${who(r)}`" :disabled="busy || r[s.key] === null" @click="step(r, s.key, true)">+</button>
              <b>{{ shown(r, s) }}</b>
              <button type="button" class="ts-step" :aria-label="`Lower ${s.label} of ${who(r)}`" :disabled="busy || r[s.key] === null" @click="step(r, s.key, false)">−</button>
            </span>
            <template v-else>{{ shown(r, s) }}</template>
          </td>
          <td class="lg-skills ts-skills">
            <template v-if="!can.removeSkill && !r.skills.some((k) => k.added)">{{ r.skills.map((k) => k.name).join(", ") }}</template>
            <template v-else-if="!can.removeSkill"><template v-for="(k, i) in r.skills" :key="k.name"><span v-if="k.added" class="ts-skill ts-added" :class="{ 'ts-secondary': k.access === 'secondary' }" :title="`${k.access === 'secondary' ? 'Secondary' : 'Primary'} skill added`">{{ k.name }}</span><template v-else>{{ k.name }}</template><template v-if="i < r.skills.length - 1">, </template></template></template>
            <template v-for="(k, i) in r.skills" v-else :key="k.name">
              <span class="ts-skill" :class="{ 'ts-added': k.added, 'ts-secondary': k.access === 'secondary' }">{{ k.name }}<button v-if="removable(k)" type="button" class="tb-chip-x ts-chip-x" :aria-label="`Remove ${k.name} from ${who(r)}`" :disabled="busy" @click="emit('removeSkill', r.id, k.name)"><span aria-hidden="true">×</span></button></span><template v-if="i < r.skills.length - 1 && !removable(k)">, </template>
            </template>
            <ul v-if="r.specialRules?.length" class="ts-rules" :aria-label="`${who(r)} special rules`">
              <li v-for="rule in r.specialRules" :key="rule.name"><b>{{ rule.name }}</b><template v-if="rule.description">: {{ rule.description }}</template></li>
            </ul>
          </td>
          <template v-if="seasonStats">
            <td v-for="c in NUMBER_COLS" :key="c.key" class="lg-num" :class="{ 'lg-pts': c.key === 'spp' }">
              <input v-if="can.numbers" class="ts-in ts-in-n" type="number" min="0" :value="r[c.key] ?? 0" :aria-label="`${c.label} of ${who(r)}`" :disabled="busy" @change="commitNum(r, c.field, r[c.key], $event)" />
              <template v-else>{{ r[c.key] ?? "-" }}</template>
            </td>
            <td v-for="c in counters" :key="c.key" class="lg-num" :data-counter="c.key">{{ r.counters[c.key] ?? 0 }}</td>
            <td class="lg-num">
              <input v-if="can.numbers" class="ts-in ts-in-n" type="number" min="0" :value="r.avail ?? 0" :aria-label="`Unspent SPP of ${who(r)}`" :disabled="busy" @change="commitNum(r, 'availableSpp', r.avail, $event)" />
              <template v-else>{{ r.avail ?? "-" }}</template>
            </td>
            <td v-if="seasons" class="lg-num" data-col="seasons">
              <input v-if="can.numbers" class="ts-in ts-in-n" type="number" min="0" max="99" :value="r.seasonsPlayed ?? 0" :aria-label="`Seasons Played of ${who(r)}`" :disabled="busy" @change="commitNum(r, 'seasonsPlayed', r.seasonsPlayed, $event)" />
              <template v-else>{{ r.seasonsPlayed ?? 0 }}</template>
            </td>
          </template>
          <td class="lg-num">
            <input v-if="can.numbers" class="ts-in ts-in-k" type="number" min="0" step="5" :value="r.value === null ? '' : Math.round(r.value / 1000)" :aria-label="`Value of ${who(r)} in thousands`" :disabled="busy" @change="commitNum(r, 'value', r.value, $event, 1000)" />
            <template v-else>{{ kValue(r.value) }}</template>
          </td>
          <td v-if="actions" class="ts-act">
            <button v-if="can.plus && !r.star && (!can.plusFor || can.plusFor(r.id))" type="button" class="tb-row-plus ts-plus" :aria-label="`Add skill${mode === 'organiser' ? ' or injury' : ''} for ${who(r)}`" aria-haspopup="dialog" :disabled="busy" @click="emit('plus', r.id, $event.currentTarget as HTMLElement)"><span aria-hidden="true">+</span></button>
            <button v-if="can.fire" type="button" class="tb-fire-x ts-fire" :aria-label="`Fire ${who(r)}`" title="Fire" :disabled="busy" @click="emit('fire', r.id)"><span aria-hidden="true">×</span></button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
