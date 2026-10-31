<script setup lang="ts">
// Tournament Builder, the Add Skill / Add Stat picker opened from a roster row (the Roster pane). It offers only what the
// shared core's gates allow (legal Primary / Secondary lists from the server, tier stack caps, stat locks); stars never take
// either. The roster calls openSkill / openStat with the row's button; closing returns focus to it.
import { computed, inject, nextTick, onUnmounted, ref, watch } from "vue";
import { FOCUSABLE } from "../home/shell";
import { dialogKey } from "../teams/manage";
import { TOURNAMENT_BUILDER_KEY, categoryClass, type PickerSkill } from "../teams/builder";
import { core } from "../teams/builderCore";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

const picker = ref<{ kind: "skill" | "stat"; index: number; error: string; loading: boolean } | null>(null);
const category = ref("");
const opener = ref<HTMLElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
async function openSkill(index: number, from: HTMLElement | null): Promise<void> {
  opener.value = from;
  picker.value = { kind: "skill", index, error: "", loading: true };
  category.value = "";
  const error = await builder.openSkills(index);
  if (picker.value?.index === index) picker.value = { ...picker.value, error, loading: false };
}
function openStat(index: number, from: HTMLElement | null): void {
  opener.value = from;
  picker.value = { kind: "stat", index, error: "", loading: false };
}
defineExpose({ openSkill, openStat });
async function close(): Promise<void> {
  const index = picker.value?.index;
  picker.value = null;
  await nextTick();
  const back = opener.value && document.contains(opener.value) && !(opener.value as HTMLButtonElement).disabled ? opener.value
    : document.querySelector<HTMLElement>(`.tb-rows [data-row="${index}"] .tb-row-actions button:not(:disabled)`);
  back?.focus({ preventScroll: true });
}
const slot = computed(() => (picker.value ? state.slots[picker.value.index] ?? null : null));
const position = computed(() => (slot.value ? builder.positionById(slot.value.positionId) : null));
const sections = computed(() => (picker.value?.kind === "skill" && !picker.value.loading ? builder.pickerSections(picker.value.index) : null));
const categories = computed(() => (sections.value ?? []).flatMap((s) => s.groups.map((g) => g.category)));
watch(categories, (list) => { if (list.length && !list.includes(category.value)) category.value = list[0]!; }, { immediate: true });
const activeSection = computed(() => (sections.value ?? []).find((s) => s.groups.some((g) => g.category === category.value)) ?? null);
const activeGroup = computed(() => activeSection.value?.groups.find((g) => g.category === category.value) ?? null);
function chip(skill: PickerSkill) {
  const s = slot.value!;
  const innate = skill.innate === true || (position.value?.skills ?? []).some((k) => k.replace(/\s*\(.*\)\s*$/, "").replace(/\*+$/, "") === skill.skill);
  const added = s.chosenSkills.includes(skill.skill);
  const reason = innate || added ? "" : builder.skillBlock(s, skill.skill);
  return { innate, added, reason, price: innate ? "" : builder.skillPrice(activeSection.value?.access ?? "primary", skill.elite) };
}
function pick(skill: string): void {
  if (!picker.value) return;
  const index = picker.value.index;
  const refused = builder.addSkill(index, skill);
  if (refused) { picker.value = { ...picker.value, error: refused }; return; }
  const s = state.slots[index];
  if (s && !builder.moreSkills(s)) void close();
}
function pickStat(stat: string): void {
  if (!picker.value) return;
  const refused = builder.addStat(picker.value.index, stat);
  if (refused) picker.value = { ...picker.value, error: refused };
  else void close();
}
const heading = computed(() => {
  if (!picker.value || !slot.value) return "";
  return `${picker.value.kind === "skill" ? "Add skill" : "Add stat"}: #${picker.value.index + 1} ${builder.shortName(position.value)}`;
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
