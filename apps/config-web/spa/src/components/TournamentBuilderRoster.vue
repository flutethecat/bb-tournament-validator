<script setup lang="ts">
// Tournament Builder, the Roster table (centre of the Roster pane, owner 10-30): the roster in builder order (drag the
// gripper or Alt+Up / Alt+Down to reorder; numbers follow the order and the save keeps it), the Team Captain toggle, and per
// row Add Skill / Add Stat as on the team management page (the picker offers only what the shared core's gates allow; stars
// never take either). Added skills and stats carry a remove ×. The skill key and the skill counts sit under the roster.
import { computed, inject, nextTick, ref } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core, type BuilderPosition, type Slot } from "../teams/builderCore";
import TournamentBuilderStats from "./TournamentBuilderStats.vue";
import TournamentBuilderSkillPicker from "./TournamentBuilderSkillPicker.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

const totals = computed(() => builder.totals());
const position = (s: Slot): BuilderPosition | null => builder.positionById(s.positionId);
const printed = (p: BuilderPosition | null): string[] => p?.skills ?? [];
const captainOn = (s: Slot): boolean => s.captain === true && builder.slotCanCaptain(s);
const role = (s: Slot): string => (position(s)?.isStar ? "Star player: no added skills" : captainOn(s) ? "Team Captain" : "Roster player");

// ── Add Skill / Add Stat ──
const picker = ref<InstanceType<typeof TournamentBuilderSkillPicker> | null>(null);
const openSkill = (i: number, e: MouseEvent): void => void picker.value?.openSkill(i, e.currentTarget as HTMLElement);
const openStat = (i: number, e: MouseEvent): void => picker.value?.openStat(i, e.currentTarget as HTMLElement);

// ── reorder: pointer drag on the gripper (mouse, touch, pen) and Alt+Arrow on it ──
const live = ref("");
const drag = ref<{ id: number; from: number; to: number | null } | null>(null);
const rowsEl = ref<HTMLElement | null>(null);
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
  const hit = rowAt(e.clientX, e.clientY);
  if (!hit) { d.to = null; return; }
  const to = hit.after ? hit.index + (hit.index < d.from ? 1 : 0) : hit.index - (hit.index > d.from ? 1 : 0);
  d.to = Math.max(0, Math.min(state.slots.length - 1, to));
}
function onGripUp(e: PointerEvent, commit: boolean): void {
  const d = drag.value;
  if (!d || e.pointerId !== d.id) return;
  drag.value = null;
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
    <header class="hm-band"><h2 id="tb-roster-h">Roster</h2><span class="hm-cap">{{ state.slots.length }} / {{ core.MAX_PLAYERS }} players</span></header>
    <p v-if="!state.slots.length" class="hm-empty">Add a player from the hireable players.</p>
    <ol v-else ref="rowsEl" class="tb-rows">
      <li v-for="(s, i) in state.slots" :key="i" class="tb-row" :data-row="i"
        :class="{ dragging: drag?.from === i, 'drop-mark': drag && drag.to === i && drag.from !== i, captain: captainOn(s) }">
        <button type="button" class="tb-grip" :data-grip="i" title="Drag to reorder"
          :aria-label="`Reorder ${position(s)?.name ?? 'player'}, player ${i + 1}. Alt plus Up or Down arrow moves it.`"
          @pointerdown="onGripDown($event, i)" @pointermove="onGripMove" @pointerup="onGripUp($event, true)" @pointercancel="onGripUp($event, false)"
          @keydown="onGripKey($event, i)"><i aria-hidden="true"></i></button>
        <span class="tb-num">{{ i + 1 }}</span>
        <span class="sprite-frame tb-sprite small" aria-hidden="true"><span class="sprite-fallback">{{ builder.shortName(position(s)).slice(0, 2).toUpperCase() }}</span><img v-if="builder.spritePath(position(s)?.name ?? '')" class="sprite-image" :src="builder.spritePath(position(s)?.name ?? '')" alt="" loading="lazy" /></span>
        <span class="tb-who">
          <strong :title="position(s)?.name">{{ builder.shortName(position(s)) || "Unknown position" }}</strong>
          <small>{{ role(s) }}</small>
        </span>
        <button v-if="builder.slotCanCaptain(s)" type="button" class="tb-captain" :aria-pressed="captainOn(s) ? 'true' : 'false'"
          title="Team Captain" :aria-label="`Team Captain: ${position(s)?.name ?? 'player'}, player ${i + 1}`" @click="builder.toggleCaptain(i)">C</button>
        <span v-else-if="builder.captainAvailable()" class="tb-captain-slot" aria-hidden="true"></span>
        <TournamentBuilderStats :position="position(s)" :increases="builder.slotLocks(i).liveStats" class="tb-row-stats" />
        <span class="row-skills tb-row-skills">
          <span v-for="k in printed(position(s))" :key="`p-${k}`" :class="builder.skillClass(k)">{{ k }}</span>
          <template v-if="captainOn(s)"><span class="skill skill-trait tb-free" title="Team Captain: gains Pro for free">{{ core.TEAM_CAPTAIN }}</span><span class="skill skill-trait tb-free" title="Free with Team Captain">Pro</span></template>
          <span v-for="k in s.chosenSkills" :key="`a-${k}`" :class="[builder.skillClass(k), 'tb-added', `access-${builder.accessOf(s.positionId, k)}`]">
            {{ k }}<button type="button" class="tb-chip-x" :aria-label="`Remove ${k}`" @click="builder.removeSkill(i, k)">×</button>
          </span>
          <span v-for="k in builder.slotLocks(i).liveStats" :key="`s-${k}`" class="skill tb-stat-chip">
            +{{ k }}<button type="button" class="tb-chip-x" :aria-label="`Remove +${k}`" @click="builder.removeStat(i, k)">×</button>
          </span>
        </span>
        <span class="tb-cost">{{ core.gold(position(s)?.cost) }}</span>
        <button type="button" class="tb-fire" :aria-label="`Remove ${position(s)?.name ?? 'player'}`" @click="builder.removeSlot(i)">Fire</button>
        <span v-if="!position(s)?.isStar" class="tm-acts tb-row-actions">
          <button type="button" class="tm-act" data-kind="skill" :disabled="builder.slotLocks(i).skillLocked || !builder.slotLocks(i).canMoreSkills"
            :title="builder.slotLocks(i).skillLocked ? 'A player with a stat increase can\'t also have an added skill.' : !builder.slotLocks(i).canMoreSkills ? 'This player can\'t take another skill.' : undefined"
            :aria-label="`Add a skill to #${i + 1} ${builder.shortName(position(s))}`" aria-haspopup="dialog" @click="openSkill(i, $event)">Add Skill</button>
          <button v-if="builder.slotLocks(i).statOffered" type="button" class="tm-act" data-kind="characteristic" :disabled="builder.slotLocks(i).statLocked || builder.slotLocks(i).statFull"
            :title="builder.slotLocks(i).statLocked ? 'A player with an added skill can\'t also take a stat increase.' : builder.slotLocks(i).statFull ? `Max ${builder.slotLocks(i).maxStats} stat increase${builder.slotLocks(i).maxStats === 1 ? '' : 's'} per player.` : undefined"
            :aria-label="`Add a stat to #${i + 1} ${builder.shortName(position(s))}`" aria-haspopup="dialog" @click="openStat(i, $event)">Add Stat</button>
        </span>
      </li>
    </ol>
    <p class="tn-sr" role="status" aria-live="polite">{{ live }}</p>
    <p class="tb-counts">Primary skills <b>{{ totals.primary }}</b> · Secondary skills <b>{{ totals.secondary }}</b></p>
    <p class="tv-key tb-key" aria-label="Skill key">
      <span class="skill skill-general">General</span><span class="skill skill-agility">Agility</span><span class="skill skill-strength">Strength</span>
      <span class="skill skill-passing">Passing</span><span class="skill skill-mutation">Mutation</span><span class="skill skill-trait">Trait</span>
      <span class="skill skill-general tb-added access-primary">Primary</span><span class="skill skill-general tb-added access-secondary">Secondary</span>
    </p>
  </section>
  <TournamentBuilderSkillPicker ref="picker" />
</template>
