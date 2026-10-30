<script setup lang="ts">
// Tournament Builder, Roster tab: team name (required before adding players), league / special rule, the choose-one skill
// pack, the position cards (limits, position groups, the 16-player cap), the roster in builder order (drag the gripper or
// Alt+Up / Alt+Down to reorder; numbers follow the order and the save keeps it), the Team Captain toggle, and the Staff section
// (rerolls at the roster's price, the apothecary only where the roster allows one, one dedicated fan free).
import { computed, inject, nextTick, ref } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core, type BuilderPosition, type Slot } from "../teams/builderCore";
import TournamentBuilderStats from "./TournamentBuilderStats.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

const nameInput = ref<HTMLInputElement | null>(null);
const nameGate = ref(false);
let gateTimer: ReturnType<typeof setTimeout> | null = null;
function showNameGate(): void {
  nameGate.value = true;
  nameInput.value?.focus();
  if (gateTimer) clearTimeout(gateTimer);
  gateTimer = setTimeout(() => { nameGate.value = false; }, 3000);
}
function add(positionId: string): void {
  if (!builder.named()) { showNameGate(); return; }
  builder.addPosition(positionId);
}

const league = computed(() => builder.leaguePresentation());
const race = computed(() => builder.raceRules());
const cards = computed(() => builder.positionCards());
const apothecaryOff = computed(() => Boolean(state.roster && !state.roster.apothecaryAllowed));
const position = (s: Slot): BuilderPosition | null => builder.positionById(s.positionId);
const printed = (p: BuilderPosition | null): string[] => p?.skills ?? [];
const captainOn = (s: Slot): boolean => s.captain === true && builder.slotCanCaptain(s);
const liveStats = (s: Slot): string[] => s.chosenStatIncreases.filter((k) => builder.allowedStats().includes(k));

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
  <section class="hm-panel tb-panel" aria-labelledby="tb-team-h">
    <header class="hm-band"><h2 id="tb-team-h">Team</h2><span class="hm-cap">{{ state.roster?.raceName }}</span></header>
    <div class="tb-fields">
      <label class="tb-field">
        <span>Team name</span>
        <input ref="nameInput" type="text" maxlength="60" placeholder="Name your team" autocomplete="off" :value="state.teamName"
          @input="builder.setTeamName(($event.target as HTMLInputElement).value)" />
      </label>
      <label v-if="league.visible" class="tb-field">
        <span>League</span>
        <select :disabled="!league.interactive" :required="league.interactive" :value="builder.activeLeague() || (league.interactive ? '' : builder.leagueOptions()[0])"
          @change="builder.selectLeague(($event.target as HTMLSelectElement).value)">
          <option v-if="league.interactive" value="" disabled>Choose a league</option>
          <option v-for="l in builder.leagueOptions()" :key="l" :value="l">{{ l }}</option>
        </select>
        <small v-if="builder.selectedSpecialRule()" class="muted">Special rule: {{ builder.selectedSpecialRule() }}</small>
      </label>
    </div>
    <p v-if="nameGate" class="tb-toast" role="status">You must name your team.</p>
    <p v-if="state.leagueNotice" class="tm-note" role="status">{{ state.leagueNotice }}</p>
    <div v-if="race?.packs.length" class="tb-packs">
      <p class="tb-k">Skill pack</p>
      <div class="tb-pack-grid">
        <button v-for="p in race.packs" :key="p.label" type="button" class="tb-pack" :aria-pressed="state.skillPack === p.label ? 'true' : 'false'" @click="builder.setSkillPack(p.label)">
          <strong>{{ p.label }}</strong>
          <small>{{ core.packTermsText(p) }}{{ p.maxPerPlayer != null ? ` · ${p.maxPerPlayer} skill${p.maxPerPlayer === 1 ? "" : "s"}/player` : "" }}</small>
        </button>
      </div>
      <p v-if="!state.skillPack" class="tm-note">Pick your skill pack.</p>
    </div>
  </section>

  <section class="hm-panel tb-panel" aria-labelledby="tb-add-h">
    <header class="hm-band"><h2 id="tb-add-h">Add players</h2><span class="hm-cap">{{ state.slots.length }} / {{ core.MAX_PLAYERS }}</span></header>
    <div class="tb-positions">
      <button
        v-for="c in cards" :key="c.position.positionId" type="button" class="tb-position" :class="{ 'name-required': !builder.named() }"
        :disabled="c.exhausted" :aria-label="`Add ${c.position.name}`"
        :title="!builder.named() ? 'You must name your team.' : c.group ? `${c.group.label || 'Position group'} limit reached` : c.name !== c.position.name ? c.position.name : undefined"
        @click="add(c.position.positionId)"
      >
        <span class="sprite-frame tb-sprite" aria-hidden="true"><span class="sprite-fallback">{{ c.name.slice(0, 2).toUpperCase() }}</span><img v-if="builder.spritePath(c.position.name)" class="sprite-image" :src="builder.spritePath(c.position.name)" alt="" loading="lazy" /></span>
        <span class="tb-position-head">
          <strong>{{ c.name }}</strong>
          <small>{{ c.left }} of {{ c.position.max }} left<template v-if="c.role"> · {{ c.role }}</template></small>
        </span>
        <span class="tb-cost">{{ core.gold(c.position.cost) }}</span>
        <TournamentBuilderStats :position="c.position" />
        <span class="row-skills tb-printed">
          <span v-for="k in printed(c.position)" :key="k" :class="builder.skillClass(k)">{{ k }}</span>
          <span v-if="!printed(c.position).length" class="muted">No printed skills</span>
        </span>
      </button>
    </div>
  </section>

  <section class="hm-panel tb-panel" aria-labelledby="tb-roster-h">
    <header class="hm-band"><h2 id="tb-roster-h">Roster</h2><span class="hm-cap">{{ state.slots.length }} / {{ core.MAX_PLAYERS }} players</span></header>
    <p v-if="!state.slots.length" class="hm-empty">Add a player from a position card above.</p>
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
          <small>{{ position(s)?.isStar ? "Star player" : captainOn(s) ? "Team Captain" : "Roster player" }}</small>
        </span>
        <button v-if="builder.slotCanCaptain(s)" type="button" class="tb-captain" :aria-pressed="captainOn(s) ? 'true' : 'false'"
          title="Team Captain" :aria-label="`Team Captain: ${position(s)?.name ?? 'player'}, player ${i + 1}`" @click="builder.toggleCaptain(i)">C</button>
        <span v-else-if="builder.captainAvailable()" class="tb-captain-slot" aria-hidden="true"></span>
        <TournamentBuilderStats :position="position(s)" :increases="liveStats(s)" class="tb-row-stats" />
        <span class="row-skills tb-row-skills">
          <span v-for="k in printed(position(s))" :key="`p-${k}`" :class="builder.skillClass(k)">{{ k }}</span>
          <template v-if="captainOn(s)"><span class="skill skill-trait tb-free" title="Team Captain: gains Pro for free">{{ core.TEAM_CAPTAIN }}</span><span class="skill skill-trait tb-free" title="Free with Team Captain">Pro</span></template>
          <span v-for="k in s.chosenSkills" :key="`a-${k}`" :class="[builder.skillClass(k), 'tb-added', `access-${builder.accessOf(s.positionId, k)}`]">{{ k }}</span>
          <span v-for="k in liveStats(s)" :key="`s-${k}`" class="skill tb-stat-chip">+{{ k }}</span>
        </span>
        <span class="tb-cost">{{ core.gold(position(s)?.cost) }}</span>
        <button type="button" class="tb-fire" :aria-label="`Remove ${position(s)?.name ?? 'player'}`" @click="builder.removeSlot(i)">Fire</button>
      </li>
    </ol>
    <p class="tn-sr" role="status" aria-live="polite">{{ live }}</p>
  </section>

  <section class="hm-panel tb-panel" aria-labelledby="tb-staff-h">
    <header class="hm-band"><h2 id="tb-staff-h">Staff</h2><span class="hm-cap">{{ core.gold(builder.totals().sidelineCost) }}</span></header>
    <ul class="tb-steppers">
      <li v-for="r in builder.staffRows()" :key="r.key" class="tb-step-row" :class="{ off: r.key === 'apothecary' && apothecaryOff }">
        <span class="tb-step-icon" aria-hidden="true"><img v-if="builder.staffIcon(r.key)" class="crest-image" :src="builder.staffIcon(r.key)" alt="" loading="lazy" /></span>
        <span class="tb-who"><strong>{{ r.label }}</strong><small>{{ r.key === 'apothecary' && apothecaryOff ? "Not available to this roster" : `${r.min}–${r.max} · ${core.gold(r.cost)} each${r.free ? `, ${r.free} free` : ""}` }}</small></span>
        <span class="tb-stepper">
          <button type="button" :disabled="(r.key === 'apothecary' && apothecaryOff) || state.staff[r.key] <= r.min" :aria-label="`Remove ${r.label}`" @click="builder.stepStaff(r.key, -1)">−</button>
          <b aria-live="polite">{{ state.staff[r.key] }}</b>
          <button type="button" :disabled="(r.key === 'apothecary' && apothecaryOff) || state.staff[r.key] >= r.max" :aria-label="`Add ${r.label}`" @click="builder.stepStaff(r.key, 1)">+</button>
        </span>
        <small class="tb-step-cost">{{ core.gold(Math.max(0, state.staff[r.key] - r.free) * r.cost) }}</small>
      </li>
    </ul>
  </section>
</template>
