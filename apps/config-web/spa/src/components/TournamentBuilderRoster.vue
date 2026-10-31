<script setup lang="ts">
// Tournament Builder, the Roster table (centre of the Roster pane, owner 10-30 / 10-31): the roster in builder order (drag
// the slim gripper or Alt+Up / Alt+Down to reorder; numbers follow the order and the save keeps it). Each row is a player
// card: top line = number, portrait, name, the Team Captain badge, cost and a red X that fires the player; second line = the
// stat strip with Add Skill / Add Stat at its right end (the picker offers only what the shared core's gates allow; stars
// never take either); then the skills. Added skills and stats wear a gold border and a red X badge that removes them. The
// skill key and the skill counts sit under the roster.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";
import { edgeStep, revealRow, REVEAL_FLASH_MS, rosterHeight, wideLayout } from "../teams/rosterReveal";
import { core, type BuilderPosition, type Slot } from "../teams/builderCore";
import TournamentBuilderStats from "./TournamentBuilderStats.vue";
import TournamentBuilderSkillPicker from "./TournamentBuilderSkillPicker.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

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

// ── Team Captain (owner 10-31): the owner's painted badge (gold = this player is the captain, grey = "make captain";
// the "C" glyph if the image fails to load). While a captain is set only the captain's row shows it; the coach clears it
// there before another row offers the toggle again. ──
const CAPTAIN_ON_HINT = "Team captain. Remove to choose another player.";
const CAPTAIN_OFF_HINT = "Make team captain";
const captainAt = computed(() => builder.captainIndex());
const showCaptain = (s: Slot, i: number): boolean => builder.slotCanCaptain(s) && (captainAt.value < 0 || captainAt.value === i);
const captainTone = (s: Slot): "gold" | "grey" => (captainOn(s) ? "gold" : "grey");
const captainSrc = (s: Slot, px: 24 | 32 | 48 | 64): string => `/icons/builder/team-captain-${captainTone(s)}-${px}.png`;
const brokenIcon = reactive<Record<string, boolean>>({});

// ── a hire scrolls its newest row into view and flashes it (owner 10-31); never on reorder, fire, load or remount ──
const ui = inject(TOURNAMENT_BUILDER_UI_KEY, null);
const rowEls = new Map<number, HTMLElement>();
function setRowEl(i: number, el: unknown): void { if (el) rowEls.set(i, el as HTMLElement); else rowEls.delete(i); }
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

// ── Add Skill / Add Stat ──
const picker = ref<InstanceType<typeof TournamentBuilderSkillPicker> | null>(null);
const openSkill = (i: number, e: MouseEvent): void => void picker.value?.openSkill(i, e.currentTarget as HTMLElement);
const openStat = (i: number, e: MouseEvent): void => picker.value?.openStat(i, e.currentTarget as HTMLElement);

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
  const topAtRest = el.getBoundingClientRect().top + (window.scrollY || 0) + (main?.scrollTop ?? 0);
  const below = footEl.value ? footEl.value.getBoundingClientRect().height : 0;
  listMax.value = `${rosterHeight(window.innerHeight, topAtRest, below)}px`;
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
    <header class="hm-band"><h2 id="tb-roster-h">Roster</h2><span class="hm-cap tb-skill-meta">{{ skillMeta }}</span></header>
    <p v-if="!state.slots.length" class="hm-empty">Add a player from the hireable players.</p>
    <ol v-else ref="rowsEl" class="tb-rows tb-roster-scroll" :style="listMax ? { maxHeight: listMax } : undefined">
      <li v-for="(s, i) in state.slots" :key="i" :ref="(el) => setRowEl(i, el)" class="tb-row" :data-row="i"
        :class="{ dragging: drag?.from === i, 'drop-mark': drag && drag.to === i && drag.from !== i, captain: captainOn(s), 'tb-row-new': flash === i }">
        <button type="button" class="tb-grip" :data-grip="i" title="Drag to reorder"
          :aria-label="`Reorder ${position(s)?.name ?? 'player'}, player ${i + 1}. Alt plus Up or Down arrow moves it.`"
          @pointerdown="onGripDown($event, i)" @pointermove="onGripMove" @pointerup="onGripUp($event, true)" @pointercancel="onGripUp($event, false)"
          @keydown="onGripKey($event, i)"><i aria-hidden="true"></i></button>
        <span class="tb-num">{{ i + 1 }}</span>
        <span class="sprite-frame tb-sprite tb-row-sprite" aria-hidden="true"><span class="sprite-fallback">{{ builder.shortName(position(s)).slice(0, 2).toUpperCase() }}</span><img v-if="builder.spritePath(position(s)?.name ?? '')" class="sprite-image" :src="builder.spritePath(position(s)?.name ?? '')" alt="" loading="lazy" /></span>
        <span class="tb-who">
          <strong :title="position(s)?.name">{{ builder.shortName(position(s)) || "Unknown position" }}</strong>
          <small v-if="role(s)">{{ role(s) }}</small>
        </span>
        <button v-if="showCaptain(s, i)" type="button" class="tb-captain" :aria-pressed="captainOn(s) ? 'true' : 'false'"
          :title="captainOn(s) ? CAPTAIN_ON_HINT : CAPTAIN_OFF_HINT" :aria-description="captainOn(s) ? CAPTAIN_ON_HINT : undefined"
          :aria-label="`${captainOn(s) ? 'Team captain' : 'Make team captain'}: ${position(s)?.name ?? 'player'}, player ${i + 1}`" @click="builder.toggleCaptain(i)"
        ><img v-if="!brokenIcon[captainTone(s)]" class="tb-captain-img" :src="captainSrc(s, 32)" :srcset="`${captainSrc(s, 32)} 1x, ${captainSrc(s, 64)} 2x`"
          width="32" height="32" alt="" @error="brokenIcon[captainTone(s)] = true" /><span v-else class="tb-captain-c" aria-hidden="true">C</span></button>
        <span class="tb-cost">{{ core.gold(position(s)?.cost) }}</span>
        <button type="button" class="tb-fire-x" :aria-label="`Fire ${position(s)?.name ?? 'player'} #${i + 1}`" title="Fire" @click="builder.removeSlot(i)"><span aria-hidden="true">×</span></button>
        <span class="tb-row-line2">
          <TournamentBuilderStats :position="position(s)" :increases="builder.slotLocks(i).liveStats" class="tb-row-stats" />
          <span v-if="!position(s)?.isStar" class="tm-acts tb-row-actions">
            <button type="button" class="tm-act" data-kind="skill" :disabled="builder.slotLocks(i).skillLocked || !builder.slotLocks(i).canMoreSkills"
              :title="builder.slotLocks(i).skillLocked ? 'A player with a stat increase can\'t also have an added skill.' : !builder.slotLocks(i).canMoreSkills ? 'This player can\'t take another skill.' : undefined"
              :aria-label="`Add a skill to #${i + 1} ${builder.shortName(position(s))}`" aria-haspopup="dialog" @click="openSkill(i, $event)">Add Skill</button>
            <button v-if="builder.slotLocks(i).statOffered" type="button" class="tm-act" data-kind="characteristic" :disabled="builder.slotLocks(i).statLocked || builder.slotLocks(i).statFull"
              :title="builder.slotLocks(i).statLocked ? 'A player with an added skill can\'t also take a stat increase.' : builder.slotLocks(i).statFull ? `Max ${builder.slotLocks(i).maxStats} stat increase${builder.slotLocks(i).maxStats === 1 ? '' : 's'} per player.` : undefined"
              :aria-label="`Add a stat to #${i + 1} ${builder.shortName(position(s))}`" aria-haspopup="dialog" @click="openStat(i, $event)">Add Stat</button>
          </span>
        </span>
        <span class="row-skills tb-row-skills">
          <span v-for="k in printed(position(s))" :key="`p-${k}`" :class="builder.skillClass(k)">{{ k }}</span>
          <template v-if="captainOn(s)"><span class="skill skill-trait tb-free" title="Team Captain: gains Pro for free">{{ core.TEAM_CAPTAIN }}</span><span class="skill skill-trait tb-free" title="Free with Team Captain">Pro</span></template>
          <span v-for="k in s.chosenSkills" :key="`a-${k}`" :class="[builder.skillClass(k), 'tb-added', 'tb-bought', `access-${builder.accessOf(s.positionId, k)}`]">
            {{ k }}<button type="button" class="tb-chip-x" :aria-label="`Remove ${k}`" @click="builder.removeSkill(i, k)"><span aria-hidden="true">×</span></button>
          </span>
          <span v-for="k in builder.slotLocks(i).liveStats" :key="`s-${k}`" class="skill tb-stat-chip tb-bought">
            +{{ k }}<button type="button" class="tb-chip-x" :aria-label="`Remove +${k}`" @click="builder.removeStat(i, k)"><span aria-hidden="true">×</span></button>
          </span>
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
      <span class="hm-cap tb-player-count">{{ state.slots.length }} / {{ core.MAX_PLAYERS }} players</span>
    </div>
  </section>
  <TournamentBuilderSkillPicker ref="picker" />
</template>
