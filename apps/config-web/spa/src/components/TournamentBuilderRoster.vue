<script setup lang="ts">
// Tournament Builder, the Roster table (centre of the Roster pane, owner 10-30 / 10-31): the roster in builder order (drag
// the slim gripper or Alt+Up / Alt+Down to reorder; numbers follow the order and the save keeps it). Each row is a player
// card: top line = number, portrait, the player's name (editable, with a reroll) over the position, cost and a red X that
// fires the player; second line = the
// stat strip with one square "+" at its right end (owner 11-01: it opens the Advance dialog, skills plus the stat bar where
// increases are allowed; stars never take either); then the skills (elite ones wear the diamond at their top-left corner).
// Added skills and stats wear a gold border and a red X badge that removes them. The
// skill key and the skill counts sit under the roster.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";
import { edgeStep, revealRow, REVEAL_FLASH_MS, rosterHeight, wideLayout } from "../teams/rosterReveal";
import { core, type BuilderPosition, type Slot } from "../teams/builderCore";
import { ELITE_ICON, PLAYER_NAME_MAX } from "../teams/builder";
import TournamentBuilderStats from "./TournamentBuilderStats.vue";
import TournamentBuilderSkillPicker from "./TournamentBuilderSkillPicker.vue";
import CustomStarSpecialRules from "./CustomStarSpecialRules.vue";
import TeamRosterTable from "./TeamRosterTable.vue";
import { summaryFromBuilder, type RosterCan } from "../teams/summary";
import { sheetModel } from "../teams/sheetRuleset";
import "../teams/summary.css";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

// ── Cards or Table (team page v2: the table-style roster of the shared team summary); the viewer's pick is remembered ──
const VIEW_KEY = "sf.builder.rosterView";
const readView = (): "cards" | "table" => { try { return globalThis.localStorage?.getItem(VIEW_KEY) === "table" ? "table" : "cards"; } catch { return "cards"; } };
const view = ref<"cards" | "table">("cards");
onMounted(() => { view.value = readView(); });
function setView(v: "cards" | "table"): void {
  view.value = v;
  try { globalThis.localStorage?.setItem(VIEW_KEY, v); } catch { /* storage blocked: this page only */ }
}
const tableRows = computed(() => (view.value === "table" && state.roster ? summaryFromBuilder(sheetModel(builder), {
  coach: "", teamValue: null, treasury: null, staff: state.staff, tier: "", eliteMark: (k) => builder.eliteMark(k), sprite: (positionFull) => builder.spritePath(positionFull),
}).rows : []));
const tableCan = computed<RosterCan>(() => ({ rename: true, fire: true, plus: true, plusFor: (id) => builder.advanceLock(Number(id)).offered, removeSkill: "added" }));

const totals = computed(() => builder.totals());
/** The Roster header's meta (owner 10-31): "Primary a/N · Secondary b/N", the count alone where no allowance is fixed. */
const skillMeta = computed(() => {
  const a = builder.skillAllowance();
  const part = (label: string, n: number, cap: number | null): string => `${label} ${n}${cap != null ? `/${cap}` : ""}`;
  return `${part("Primary", totals.value.primary, a.primary)} · ${part("Secondary", totals.value.secondary, a.secondary)}`;
});
const position = (s: Slot): BuilderPosition | null => builder.positionById(s.positionId);
const printed = (p: BuilderPosition | null): string[] => p?.skills ?? [];
const captainOn = (s: Slot): boolean => s.captain === true && builder.slotCanCaptain(s);
/** The subtitle under the name, only for stars (owner 10-31: the captain badge says Team Captain). */
const role = (s: Slot): string => (position(s)?.isStar ? "Star player: no added skills" : "");

// ── Team Captain (owner 11-13, replacing the 10-31 number-badge toggle): the name plate's right end reads [captain] [number]
// [cost] [fire]. While no captain is set every eligible row offers a "Make Captain" button left of its number. Once one is
// chosen the buttons go and the painted gold C sits on the captain's name line, after the reroll button; clicking the C
// removes the captaincy so another player can be chosen. Ineligible rows and stars never show either. A gold ring with a "C" stands in if the
// image fails to load. ──
const CAPTAIN_ON_HINT = "Team captain. Remove to choose another player.";
const CAPTAIN_OFF_HINT = "Make this player the team captain (gains Pro for free)";
const captainAt = computed(() => builder.captainIndex());
const showMakeCaptain = (s: Slot): boolean => captainAt.value < 0 && builder.slotCanCaptain(s);
const CAPTAIN_ICON = (px: 32 | 64): string => `/icons/builder/team-captain-gold-${px}.png`;
const captainIconBroken = ref(false);

// ── Blood Bowl Sevens Veteran (spec 11-02): a captain-style toggle on Lineman-keyword rows, one per team. While a Veteran is
// set only its row shows the chip (click to clear); then every eligible row offers "Make Veteran" again. The Veteran's stat
// strip prints MA one lower. ──
const VETERAN_ON_HINT = "Veteran: MA −1, one reroll a game. Click to choose another player.";
const VETERAN_OFF_HINT = "Make this Lineman the Veteran (MA −1, one reroll a game)";
const veteranAt = computed(() => builder.veteranIndex());
const showVeteran = (s: Slot, i: number): boolean => builder.canVeteran(s) && (veteranAt.value < 0 || veteranAt.value === i);
const veteranOn = (i: number): boolean => veteranAt.value === i;

// ── a hire scrolls its newest row into view and flashes it (owner 10-31); never on reorder, fire, load or remount ──
const ui = inject(TOURNAMENT_BUILDER_UI_KEY, null);
const rowEls = new Map<number, HTMLElement>();
function setRowEl(i: number, el: unknown): void { if (el) rowEls.set(i, el as HTMLElement); else rowEls.delete(i); }
/** Make Captain and the captain's C are different buttons, so the click's element is replaced: keep keyboard focus on
 *  the control that took its place on that row (the C after choosing, Make Captain after clearing). */
async function toggleCaptainAt(i: number): Promise<void> {
  builder.toggleCaptain(i);
  await nextTick();
  (rowEls.get(i)?.querySelector?.(".tb-captain, .tb-make-captain") as HTMLElement | null | undefined)?.focus?.();
}
const flash = ref<number | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => ui?.added, async (n, was) => {
  if (!n || n === was) return;
  await nextTick();
  const last = state.slots.length - 1;
  if (last < 0) return;
  revealRow(rowEls.get(last) ?? null, rowsEl.value);
  flash.value = last;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash.value = null; flashTimer = null; }, REVEAL_FLASH_MS);
});
onBeforeUnmount(() => { if (flashTimer) clearTimeout(flashTimer); });

// ── the single "+" (owner 11-01): opens the Advance dialog (skills, and the stat bar where increases are allowed) ──
const picker = ref<InstanceType<typeof TournamentBuilderSkillPicker> | null>(null);
const advance = (i: number) => builder.advanceLock(i);
const openAdvance = (i: number, e: MouseEvent): void => void picker.value?.openSkill(i, e.currentTarget as HTMLElement);

// ── player names (owner 11-01): click the name (or Enter / F2 on it) to rename inline; Enter or leaving the field saves,
// Escape cancels; an empty name keeps the old one. The ↻ beside it rerolls a generated name. ──
const editing = ref<number | null>(null);
const draft = ref("");
let nameInput: HTMLInputElement | null = null;
/** The slot being renamed: a reorder or a fire while the field is open must never rename another player. */
let editingSlot: Slot | null = null;
function setNameInput(el: unknown): void { nameInput = (el as HTMLInputElement | null) ?? null; }
async function startEdit(i: number): Promise<void> {
  editing.value = i;
  editingSlot = state.slots[i] ?? null;
  draft.value = editingSlot?.name ?? "";
  await nextTick();
  nameInput?.focus?.();
  nameInput?.select?.();
}
async function endEdit(i: number): Promise<void> {
  editing.value = null;
  await nextTick();
  rowsEl.value?.querySelector?.<HTMLElement>(`[data-name="${i}"]`)?.focus();
}
function commitName(i: number): void {
  if (editing.value !== i) return;
  const at = editingSlot ? state.slots.indexOf(editingSlot) : -1;
  editingSlot = null;
  if (at < 0) { editing.value = null; return; } // the player left or moved: drop the edit
  const ok = builder.renameSlot(at, draft.value);
  live.value = ok ? `Renamed to ${state.slots[at]?.name ?? ""}` : "Name unchanged";
  void endEdit(at);
}
function onNameKey(e: KeyboardEvent, i: number): void {
  if (e.key === "Enter") { e.preventDefault(); commitName(i); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); editingSlot = null; live.value = "Rename cancelled"; void endEdit(i); }
}
function onNameButtonKey(e: KeyboardEvent, i: number): void {
  if (e.key === "F2") { e.preventDefault(); void startEdit(i); }
}
function reroll(i: number): void {
  const name = builder.rerollName(i);
  if (name) live.value = `New name: ${name}`;
}

// ── reorder: pointer drag on the gripper (mouse, touch, pen) and Alt+Arrow on it ──
const live = ref("");
const drag = ref<{ id: number; from: number; to: number | null } | null>(null);
const rowsEl = ref<HTMLElement | null>(null);

// ── the roster scroller (three-column layout only): as tall as the viewport below the panel header, measured ──
const footEl = ref<HTMLElement | null>(null);
const listMax = ref<string | undefined>(undefined);
function measureList(): void {
  const el = rowsEl.value;
  if (!el || typeof window === "undefined" || !wideLayout()) { listMax.value = undefined; return; }
  const main = document.querySelector("main");
  // Rects and the window are in screen px; CSS lengths and scroll offsets in CSS px (the UI zoom, home.css --sf-zoom).
  const z = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
  const topAtRest = el.getBoundingClientRect().top / z + (window.scrollY || 0) / z + (main?.scrollTop ?? 0);
  const px = (v: string | undefined): number => Number.parseFloat(v ?? "") || 0;
  // Everything under the list that still has to fit (design.md §6, 1920x1080 with no page scroll): the foot with its top margin,
  // the panel's bottom padding and border, and the scrolling main's bottom padding.
  const panel = el.closest(".tb-panel");
  const below = (footEl.value ? footEl.value.getBoundingClientRect().height / z + px(getComputedStyle(footEl.value).marginTop) : 0)
    + (panel ? px(getComputedStyle(panel).paddingBottom) + px(getComputedStyle(panel).borderBottomWidth) : 0) + (main ? px(getComputedStyle(main).paddingBottom) : 0);
  listMax.value = `${rosterHeight(window.innerHeight / z, topAtRest, below)}px`;
}
onMounted(() => {
  measureList();
  if (typeof window !== "undefined") window.addEventListener("resize", measureList);
});
onBeforeUnmount(() => { if (typeof window !== "undefined") window.removeEventListener("resize", measureList); stopEdge(); });
watch(() => state.slots.length > 0, () => void nextTick(measureList));

// Dragging near the scroller's top or bottom edge scrolls it (a frame loop while the pointer rests there).
let edgeFrame = 0;
let lastPointer: { x: number; y: number } | null = null;
function stopEdge(): void { if (edgeFrame && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(edgeFrame); edgeFrame = 0; }
function edgeTick(): void {
  edgeFrame = 0;
  const el = rowsEl.value;
  if (!drag.value || !el || !lastPointer || el.scrollHeight <= el.clientHeight) return;
  const r = el.getBoundingClientRect();
  const step = edgeStep(lastPointer.y, r.top, r.bottom);
  if (!step) return;
  el.scrollTop += step;
  track(lastPointer.x, lastPointer.y);
  edgeFrame = requestAnimationFrame(edgeTick);
}
function rowAt(x: number, y: number): { index: number; after: boolean } | null {
  const row = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest?.("[data-row]") as HTMLElement | null;
  if (!row || !rowsEl.value?.contains(row)) return null;
  const rect = row.getBoundingClientRect();
  return { index: Number(row.dataset.row), after: y > rect.top + rect.height / 2 };
}
function onGripDown(e: PointerEvent, index: number): void {
  e.preventDefault();
  try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
  drag.value = { id: e.pointerId, from: index, to: null };
}
function onGripMove(e: PointerEvent): void {
  const d = drag.value;
  if (!d || e.pointerId !== d.id) return;
  lastPointer = { x: e.clientX, y: e.clientY };
  track(e.clientX, e.clientY);
  if (!edgeFrame && typeof requestAnimationFrame !== "undefined") edgeFrame = requestAnimationFrame(edgeTick);
}
function track(x: number, y: number): void {
  const d = drag.value;
  if (!d) return;
  const hit = rowAt(x, y);
  if (!hit) { d.to = null; return; }
  const to = hit.after ? hit.index + (hit.index < d.from ? 1 : 0) : hit.index - (hit.index > d.from ? 1 : 0);
  d.to = Math.max(0, Math.min(state.slots.length - 1, to));
}
function onGripUp(e: PointerEvent, commit: boolean): void {
  const d = drag.value;
  if (!d || e.pointerId !== d.id) return;
  drag.value = null;
  stopEdge();
  lastPointer = null;
  if (commit && d.to !== null && d.to !== d.from) move(d.from, d.to, false);
}
async function move(from: number, to: number, focus: boolean): Promise<void> {
  const slot = state.slots[from];
  const label = position(slot!)?.name ?? "player";
  if (!builder.moveSlot(from, to)) {
    live.value = `${label} is already ${to < from ? "first" : "last"}, position ${from + 1}`;
    return;
  }
  live.value = `Moved ${label} to position ${to + 1}`;
  if (focus) { await nextTick(); rowsEl.value?.querySelector<HTMLElement>(`[data-grip="${to}"]`)?.focus(); }
}
function onGripKey(e: KeyboardEvent, index: number): void {
  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  e.preventDefault();
  void move(index, index + (e.key === "ArrowUp" ? -1 : 1), true);
}
</script>

<template>
  <section class="hm-panel tb-panel tb-roster-panel" aria-labelledby="tb-roster-h">
    <header class="hm-band"><h2 id="tb-roster-h">Roster</h2><span class="hm-cap tb-skill-meta">{{ skillMeta }}</span>
      <span class="sf-tabs tb-view-toggle" role="group" aria-label="Roster view">
        <button type="button" class="sf-tab" :aria-pressed="view === 'cards' ? 'true' : 'false'" data-roster-view="cards" @click="setView('cards')">Cards</button>
        <button type="button" class="sf-tab" :aria-pressed="view === 'table' ? 'true' : 'false'" data-roster-view="table" @click="setView('table')">Table</button>
      </span>
    </header>
    <p v-if="!state.slots.length" class="hm-empty">Add a player from the hireable players.</p>
    <!-- Table view (team page v2): the shared team summary's roster table for this team; rename, fire, the "+" and removing
         added skills work here too. Reordering stays on the cards. -->
    <div v-else-if="view === 'table'" class="tb-table-view" data-roster-table :style="listMax ? { '--tb-list-max': listMax } : undefined">
      <TeamRosterTable :rows="tableRows" mode="builder" :season-stats="false" :can="tableCan" label="Roster table"
        @rename="(id, v) => { if (v) builder.renameSlot(Number(id), v); }" @fire="(id) => builder.removeSlot(Number(id))"
        @remove-skill="(id, k) => builder.removeSkill(Number(id), k)" @plus="(id, el) => void picker?.openSkill(Number(id), el)" />
    </div>
    <ol v-else ref="rowsEl" class="tb-rows tb-roster-scroll" :style="listMax ? { maxHeight: listMax } : undefined">
      <li v-for="(s, i) in state.slots" :key="i" :ref="(el) => setRowEl(i, el)" class="tb-row" :data-row="i"
        :class="{ dragging: drag?.from === i, 'drop-mark': drag && drag.to === i && drag.from !== i, captain: captainOn(s), 'tb-row-new': flash === i }">
        <button type="button" class="tb-grip" :data-grip="i" title="Drag to reorder"
          :aria-label="`Reorder ${position(s)?.name ?? 'player'}, player ${i + 1}. Alt plus Up or Down arrow moves it.`"
          @pointerdown="onGripDown($event, i)" @pointermove="onGripMove" @pointerup="onGripUp($event, true)" @pointercancel="onGripUp($event, false)"
          @keydown="onGripKey($event, i)"><i aria-hidden="true"></i></button>
        <span class="sprite-frame tb-sprite tb-row-sprite" aria-hidden="true"><span class="sprite-fallback">{{ builder.shortName(position(s)).slice(0, 2).toUpperCase() }}</span><img v-if="builder.spritePath(position(s)?.name ?? '')" class="sprite-image" :src="builder.spritePath(position(s)?.name ?? '')" alt="" loading="lazy" /></span>
        <span class="tb-who">
          <!-- the player's name in the header styling (owner 11-01), the position as the subheader under it; stars keep
               their own name and say they take no added skills -->
          <span class="tb-name-line">
            <strong v-if="position(s)?.isStar" class="tb-pname" :title="position(s)?.name">{{ builder.shortName(position(s)) || "Unknown position" }}</strong>
            <input v-else-if="editing === i" :ref="setNameInput" :value="draft" class="tb-name-input" type="text" :maxlength="PLAYER_NAME_MAX" autocomplete="off" spellcheck="false"
              :aria-label="`Name for #${i + 1} ${builder.shortName(position(s))}`" @input="draft = ($event.target as HTMLInputElement).value" @keydown="onNameKey($event, i)" @blur="commitName(i)" />
            <button v-else type="button" class="tb-pname" :data-name="i" :title="`Rename ${s.name || 'player'}`"
              :aria-label="`${s.name || 'Unnamed player'}, #${i + 1} ${builder.shortName(position(s))}. Press Enter to rename.`" @click="startEdit(i)" @keydown="onNameButtonKey($event, i)">{{ s.name || builder.shortName(position(s)) }}</button>
            <button v-if="!position(s)?.isStar && editing !== i" type="button" class="tb-reroll" :aria-label="`Reroll name for #${i + 1}`" title="Reroll name" @click="reroll(i)"><span aria-hidden="true">↻</span></button>
            <!-- the captain's gold C sits on the name line, after the reroll button (owner 11-13); it removes the captaincy -->
            <button v-if="captainOn(s)" type="button" class="tb-captain" :class="{ broken: captainIconBroken }"
              aria-pressed="true" :title="CAPTAIN_ON_HINT" :aria-description="CAPTAIN_ON_HINT"
              :aria-label="`Team captain: ${position(s)?.name ?? 'player'}, player ${i + 1}`" @click="toggleCaptainAt(i)"
            ><img v-if="!captainIconBroken" class="tb-captain-img" :src="CAPTAIN_ICON(32)" :srcset="`${CAPTAIN_ICON(32)} 1x, ${CAPTAIN_ICON(64)} 2x`"
              width="24" height="24" alt="" @error="captainIconBroken = true" /><span v-else aria-hidden="true">C</span></button>
          </span>
          <small class="tb-psub" :title="position(s)?.name">{{ position(s)?.isStar ? role(s) : builder.shortName(position(s)) || "Unknown position" }}</small>
        </span>
        <!-- the name plate's right end (owner 11-13): Make Captain, the row number, the cost, the fire X -->
        <button v-if="showMakeCaptain(s)" type="button" class="tb-vet tb-make-captain tb-row-cap" :title="CAPTAIN_OFF_HINT"
          :aria-label="`Make team captain: ${position(s)?.name ?? 'player'}, player ${i + 1}`" @click="toggleCaptainAt(i)"
        >Make Captain</button>
        <span class="tb-num">{{ i + 1 }}</span>
        <span class="tb-cost">{{ core.gold(position(s)?.cost) }}</span>
        <button type="button" class="tb-fire-x" :aria-label="`Fire ${position(s)?.name ?? 'player'} #${i + 1}`" title="Fire" @click="builder.removeSlot(i)"><span aria-hidden="true">×</span></button>
        <span class="tb-row-line2">
          <TournamentBuilderStats :position="builder.displayPosition(s)" :increases="builder.slotLocks(i).liveStats" :down="veteranOn(i) ? ['MA'] : undefined" class="tb-row-stats" />
          <span v-if="advance(i).offered" class="tb-row-actions">
            <button type="button" class="tb-advance" :disabled="Boolean(advance(i).reason)" :title="advance(i).reason || (advance(i).stats ? 'Add a skill or a stat increase' : 'Add a skill')"
              :aria-label="`${advance(i).stats ? 'Add skill or stat increase' : 'Add skill'} for #${i + 1} ${builder.shortName(position(s))}`" aria-haspopup="dialog" @click="openAdvance(i, $event)"><span aria-hidden="true">+</span></button>
          </span>
        </span>
        <span class="row-skills tb-row-skills">
          <button v-if="showVeteran(s, i)" type="button" class="tb-vet" :aria-pressed="veteranOn(i) ? 'true' : 'false'"
            :title="veteranOn(i) ? VETERAN_ON_HINT : VETERAN_OFF_HINT"
            :aria-label="`${veteranOn(i) ? 'Veteran' : 'Make Veteran'}: ${builder.shortName(position(s))}, player ${i + 1}`" @click="builder.toggleVeteran(i)"
          >{{ veteranOn(i) ? "Veteran" : "Make Veteran" }}</button>
          <span v-for="k in printed(position(s))" :key="`p-${k}`" :class="[builder.skillClass(k), { 'tb-elite-chip': builder.eliteMark(k) }]" :title="builder.eliteMark(k) ? 'Elite skill' : undefined"><img v-if="builder.eliteMark(k)" class="tb-elite-dot" :src="ELITE_ICON" alt="Elite skill" width="12" height="12" />{{ k }}</span>
          <template v-if="captainOn(s)"><span class="skill skill-trait tb-free" title="Team Captain: gains Pro for free">{{ core.TEAM_CAPTAIN }}</span><span class="skill skill-trait tb-free" title="Free with Team Captain">Pro</span></template>
          <span v-for="k in s.chosenSkills" :key="`a-${k}`" :class="[builder.skillClass(k), 'tb-added', 'tb-bought', `access-${builder.accessOf(s.positionId, k)}`, { 'tb-elite-chip': builder.eliteMark(k) }]" :title="builder.eliteMark(k) ? 'Elite skill' : undefined">
            <img v-if="builder.eliteMark(k)" class="tb-elite-dot" :src="ELITE_ICON" alt="Elite skill" width="12" height="12" />{{ k }}<button type="button" class="tb-chip-x" :aria-label="`Remove ${k}`" @click="builder.removeSkill(i, k)"><span aria-hidden="true">×</span></button>
          </span>
          <span v-for="k in builder.slotLocks(i).liveStats" :key="`s-${k}`" class="skill tb-stat-chip tb-bought">
            +{{ k }}<button type="button" class="tb-chip-x" :aria-label="`Remove +${k}`" @click="builder.removeStat(i, k)"><span aria-hidden="true">×</span></button>
          </span>
          <!-- a custom star's custom traits and rules, below its skills (creation wizards v2) -->
          <CustomStarSpecialRules :rules="builder.specialRulesOf(s.positionId)" compact />
        </span>
      </li>
    </ol>
    <p class="tn-sr" role="status" aria-live="polite">{{ live }}</p>
    <div ref="footEl" class="tb-roster-foot">
      <p class="tv-key tb-key" aria-label="Skill key">
        <span class="skill skill-general">General</span><span class="skill skill-agility">Agility</span><span class="skill skill-strength">Strength</span>
        <span class="skill skill-passing">Passing</span><span class="skill skill-mutation">Mutation</span><span class="skill skill-trait">Trait</span>
        <span class="skill skill-general tb-added access-primary">Primary</span><span class="skill skill-general tb-added access-secondary">Secondary</span>
      </p>
      <span class="hm-cap tb-player-count">{{ state.slots.length }} / {{ builder.maxPlayers() }} players</span>
    </div>
  </section>
  <TournamentBuilderSkillPicker ref="picker" />
</template>
