<script setup lang="ts">
// Tournament Builder, Skills tab: the tier's limits (secondary / elite / stacks / stack types / characteristics / stars,
// from the package), the live counts, and per player Add Skill / Add Stat. The pickers offer only what the shared core's
// gates allow (legal Primary / Secondary lists from the server, tier stack caps, stat locks); stars never take either.
import { computed, inject, nextTick, onUnmounted, ref, watch } from "vue";
import { FOCUSABLE } from "../home/shell";
import { dialogKey } from "../teams/manage";
import { TOURNAMENT_BUILDER_KEY, categoryClass, type PickerSkill } from "../teams/builder";
import { core, type Slot } from "../teams/builderCore";
import TournamentBuilderStats from "./TournamentBuilderStats.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

const lines = computed(() => builder.rulesetLines());
const totals = computed(() => builder.totals());
const pending = computed(() => Boolean(state.preview && !state.preview.package && state.preview.rosterId === state.roster?.rosterId));
const position = (s: Slot) => builder.positionById(s.positionId);

// ── pickers ──
const picker = ref<{ kind: "skill" | "stat"; index: number; error: string; loading: boolean } | null>(null);
const category = ref("");
const opener = ref<HTMLElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
async function openSkill(index: number, e: MouseEvent): Promise<void> {
  opener.value = e.currentTarget as HTMLElement;
  picker.value = { kind: "skill", index, error: "", loading: true };
  category.value = "";
  const error = await builder.openSkills(index);
  if (picker.value?.index === index) picker.value = { ...picker.value, error, loading: false };
}
function openStat(index: number, e: MouseEvent): void {
  opener.value = e.currentTarget as HTMLElement;
  picker.value = { kind: "stat", index, error: "", loading: false };
}
async function close(): Promise<void> {
  const index = picker.value?.index;
  picker.value = null;
  await nextTick();
  const back = opener.value && document.contains(opener.value) && !(opener.value as HTMLButtonElement).disabled ? opener.value
    : document.querySelector<HTMLElement>(`.tb-skill-rows [data-player="${index}"] button:not(:disabled)`);
  back?.focus({ preventScroll: true });
}
const slot = computed(() => (picker.value ? state.slots[picker.value.index] ?? null : null));
const sections = computed(() => (picker.value?.kind === "skill" && !picker.value.loading ? builder.pickerSections(picker.value.index) : null));
const categories = computed(() => (sections.value ?? []).flatMap((s) => s.groups.map((g) => g.category)));
watch(categories, (list) => { if (list.length && !list.includes(category.value)) category.value = list[0]!; }, { immediate: true });
const activeSection = computed(() => (sections.value ?? []).find((s) => s.groups.some((g) => g.category === category.value)) ?? null);
const activeGroup = computed(() => activeSection.value?.groups.find((g) => g.category === category.value) ?? null);
function chip(skill: PickerSkill) {
  const s = slot.value!;
  const innate = skill.innate === true || position(s)!.skills.some((k) => k.replace(/\s*\(.*\)\s*$/, "").replace(/\*+$/, "") === skill.skill);
  const added = s.chosenSkills.includes(skill.skill);
  const reason = innate || added ? "" : core.skillPickBlock(builder.gateCtx(), s, skill.skill);
  return { innate, added, reason, price: innate ? "" : builder.skillPrice(activeSection.value?.access ?? "primary", skill.elite) };
}
function pick(skill: string): void {
  if (!picker.value) return;
  const index = picker.value.index;
  const refused = builder.addSkill(index, skill);
  if (refused) { picker.value = { ...picker.value, error: refused }; return; }
  const s = state.slots[index];
  if (s && !core.moreSkillsAllowed(builder.gateCtx(), s)) void close();
}
function pickStat(stat: string): void {
  if (!picker.value) return;
  const refused = builder.addStat(picker.value.index, stat);
  if (refused) picker.value = { ...picker.value, error: refused };
  else void close();
}
const heading = computed(() => {
  if (!picker.value || !slot.value) return "";
  return `${picker.value.kind === "skill" ? "Add skill" : "Add stat"}: #${picker.value.index + 1} ${builder.shortName(position(slot.value))}`;
});

// Focus (aria-modal): focus moves into the dialog; Tab wraps inside; Escape closes.
const focusables = (): HTMLElement[] => Array.from(dialog.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null || el === document.activeElement);
function onKey(e: KeyboardEvent): void {
  if (!picker.value) return;
  const action = dialogKey(e, focusables(), document.activeElement as HTMLElement | null, false);
  if (!action) return;
  if (action.type === "stop") { e.stopPropagation(); return; }
  e.preventDefault();
  e.stopPropagation();
  if (action.type === "close") void close();
  else if (action.type === "focus") action.target.focus({ preventScroll: true });
}
watch(picker, async (p, was) => {
  if (typeof window === "undefined") return;
  if (p && !was) {
    window.addEventListener("keydown", onKey, true);
    await nextTick();
    (dialog.value?.querySelector<HTMLElement>(".tn-modal-x") ?? dialog.value)?.focus({ preventScroll: true });
  } else if (!p && was) window.removeEventListener("keydown", onKey, true);
});
onUnmounted(() => { if (typeof window !== "undefined") window.removeEventListener("keydown", onKey, true); });
</script>

<template>
  <section class="hm-panel tb-panel" aria-labelledby="tb-limits-h">
    <header class="hm-band"><h2 id="tb-limits-h">Skill rules</h2><span class="hm-cap">{{ builder.tierLabel() || state.packageName }}</span></header>
    <ul v-if="lines.length" class="tb-lines">
      <li v-for="l in lines" :key="l">{{ l }}</li>
    </ul>
    <p v-if="state.packageRules?.dataNote" class="muted">{{ state.packageRules.dataNote }}</p>
    <p v-if="pending" class="tm-note">Ruleset validation pending server update.</p>
    <p class="tb-counts">Primary skills <b>{{ totals.primary }}</b> · Secondary skills <b>{{ totals.secondary }}</b></p>
    <p class="tv-key tb-key" aria-label="Skill key">
      <span class="skill skill-general">General</span><span class="skill skill-agility">Agility</span><span class="skill skill-strength">Strength</span>
      <span class="skill skill-passing">Passing</span><span class="skill skill-mutation">Mutation</span><span class="skill skill-trait">Trait</span>
      <span class="skill skill-general tb-added access-primary">Primary</span><span class="skill skill-general tb-added access-secondary">Secondary</span>
    </p>
  </section>

  <section class="hm-panel tb-panel" aria-labelledby="tb-skills-h">
    <header class="hm-band"><h2 id="tb-skills-h">Players</h2><span class="hm-cap">{{ state.slots.length }} players</span></header>
    <p v-if="!state.slots.length" class="hm-empty">Add players on the Roster tab first.</p>
    <ol v-else class="tb-rows tb-skill-rows">
      <li v-for="(s, i) in state.slots" :key="i" class="tb-row tb-skill-row" :data-player="i">
        <span class="tb-num">{{ i + 1 }}</span>
        <span class="tb-who">
          <strong :title="position(s)?.name">{{ builder.shortName(position(s)) }}</strong>
          <small v-if="position(s)?.isStar">Star player: no added skills</small>
        </span>
        <TournamentBuilderStats :position="position(s)" :increases="builder.slotLocks(i).liveStats" class="tb-row-stats" />
        <span class="row-skills tb-row-skills">
          <span v-for="k in position(s)?.skills ?? []" :key="`p-${k}`" :class="builder.skillClass(k)">{{ k }}</span>
          <span v-for="k in s.chosenSkills" :key="`a-${k}`" :class="[builder.skillClass(k), 'tb-added', `access-${builder.accessOf(s.positionId, k)}`]">
            {{ k }}<button type="button" class="tb-chip-x" :aria-label="`Remove ${k}`" @click="builder.removeSkill(i, k)">×</button>
          </span>
          <span v-for="k in builder.slotLocks(i).liveStats" :key="`s-${k}`" class="skill tb-stat-chip">
            +{{ k }}<button type="button" class="tb-chip-x" :aria-label="`Remove +${k}`" @click="builder.removeStat(i, k)">×</button>
          </span>
        </span>
        <span v-if="!position(s)?.isStar" class="tb-row-actions">
          <button type="button" class="tb-btn small" :disabled="builder.slotLocks(i).skillLocked || !builder.slotLocks(i).canMoreSkills"
            :title="builder.slotLocks(i).skillLocked ? 'A player with a stat increase can\'t also have an added skill.' : !builder.slotLocks(i).canMoreSkills ? 'This player can\'t take another skill.' : undefined"
            aria-haspopup="dialog" @click="openSkill(i, $event)">Add Skill</button>
          <button v-if="builder.slotLocks(i).statOffered" type="button" class="tb-btn small" :disabled="builder.slotLocks(i).statLocked || builder.slotLocks(i).statFull"
            :title="builder.slotLocks(i).statLocked ? 'A player with an added skill can\'t also take a stat increase.' : builder.slotLocks(i).statFull ? `Max ${builder.slotLocks(i).maxStats} stat increase${builder.slotLocks(i).maxStats === 1 ? '' : 's'} per player.` : undefined"
            aria-haspopup="dialog" @click="openStat(i, $event)">Add Stat</button>
        </span>
      </li>
    </ol>
  </section>

  <div v-if="picker && slot" class="tn-modal-backdrop" @click.self="close()">
    <div ref="dialog" class="tn-modal tn-panel tb-modal" role="dialog" aria-modal="true" aria-labelledby="tb-picker-h" tabindex="-1">
      <h3 id="tb-picker-h" class="tn-band">{{ heading }}<button type="button" class="tn-modal-x" aria-label="Close" @click="close()">×</button></h3>
      <div class="tn-panel-body">
        <p v-if="picker.error" class="lobby-error" role="alert">{{ picker.error }}</p>
        <template v-if="picker.kind === 'skill'">
          <p v-if="picker.loading" class="muted" role="status">Loading legal skills...</p>
          <p v-else-if="sections && !sections.length" class="muted">No selectable skills for this position.</p>
          <template v-else-if="sections">
            <div v-for="sec in sections" :key="sec.label" class="tb-blades">
              <span class="tb-k">{{ sec.label }}</span>
              <button v-for="g in sec.groups" :key="g.category" type="button" class="tb-blade" :class="categoryClass(g.category)"
                :aria-pressed="category === g.category ? 'true' : 'false'" @click="category = g.category">
                {{ g.category }} <small>{{ g.skills.filter((k) => !k.innate).length }}</small>
              </button>
            </div>
            <div v-if="activeGroup" class="tb-chips">
              <span v-for="k in activeGroup.skills" :key="k.skill" class="tb-chip-cell">
                <button type="button" class="tb-chip" :class="[categoryClass(k.category), { innate: chip(k).innate, added: chip(k).added }]"
                  :disabled="chip(k).innate || chip(k).added || Boolean(chip(k).reason)" :title="chip(k).reason || undefined" @click="pick(k.skill)">
                  <img v-if="builder.skillIcon(k.skill)" class="skill-icon" :src="builder.skillIcon(k.skill)" alt="" aria-hidden="true" />
                  <span>{{ k.skill }}</span>
                  <small v-if="k.elite" class="tb-elite">Elite</small>
                  <small v-if="chip(k).innate">Printed</small>
                  <small v-else-if="chip(k).added">Added</small>
                  <small v-else>{{ chip(k).price }}</small>
                </button>
                <button v-if="chip(k).added" type="button" class="tb-chip-x" :aria-label="`Remove ${k.skill}`" @click="builder.removeSkill(picker.index, k.skill)">×</button>
              </span>
            </div>
          </template>
        </template>
        <div v-else class="tb-chips">
          <button v-for="o in builder.statOptions(picker.index)" :key="o.stat" type="button" class="tb-chip tb-stat-option" :disabled="Boolean(o.reason)" :title="o.reason || undefined" @click="pickStat(o.stat)">
            <b>+{{ o.stat }}</b><span>{{ o.from }} → {{ o.to }}</span><small>{{ o.cost }}<template v-if="o.reason"> · {{ o.reason }}</template></small>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
