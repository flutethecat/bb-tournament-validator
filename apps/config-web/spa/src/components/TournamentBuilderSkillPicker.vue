<script setup lang="ts">
// Tournament Builder, the Advance dialog opened from a roster row's "+" (owner 11-01; it replaced + Skill / + Stat). Where
// the ruleset allows stat increases, the player's stat bar sits top right with a "+" above and a "−" below each tile; the
// skill blades and chips stay below. It offers only what the shared core's gates allow (legal Primary / Secondary lists
// from the server, tier stack caps, stat locks, the BB2025 caps); stars never take either. The roster calls openSkill with
// the row's button; closing returns focus to it.
import { computed, inject, nextTick, onUnmounted, ref, watch } from "vue";
import { FOCUSABLE } from "../home/shell";
import { dialogKey } from "../teams/manage";
import { ELITE_ICON, TOURNAMENT_BUILDER_KEY, categoryClass, type PickerSkill } from "../teams/builder";
import { core } from "../teams/builderCore";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

const picker = ref<{ index: number; error: string; loading: boolean } | null>(null);
const statLive = ref("");
const category = ref("");
const opener = ref<HTMLElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
async function openSkill(index: number, from: HTMLElement | null): Promise<void> {
  opener.value = from;
  picker.value = { index, error: "", loading: true };
  statLive.value = "";
  category.value = "";
  const error = await builder.openSkills(index);
  if (picker.value?.index === index) picker.value = { ...picker.value, error, loading: false };
}
defineExpose({ openSkill });
async function close(): Promise<void> {
  const index = picker.value?.index;
  picker.value = null;
  await nextTick();
  const back = opener.value && document.contains(opener.value) && !(opener.value as HTMLButtonElement).disabled ? opener.value
    : document.querySelector<HTMLElement>(`.tb-rows [data-row="${index}"] .tb-advance:not(:disabled)`) ?? document.querySelector<HTMLElement>(`.tb-rows [data-row="${index}"] .tb-grip`);
  back?.focus({ preventScroll: true });
}
const slot = computed(() => (picker.value ? state.slots[picker.value.index] ?? null : null));
const position = computed(() => (slot.value ? builder.positionById(slot.value.positionId) : null));
const sections = computed(() => (picker.value && !picker.value.loading ? builder.pickerSections(picker.value.index) : null));
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
// ── the stat bar (only where the ruleset allows stat increases) ──
const statsOn = computed(() => (picker.value ? builder.advanceLock(picker.value.index).stats : false));
const steps = computed(() => (picker.value && statsOn.value ? builder.statSteps(picker.value.index) : []));
const skillLockNote = computed(() => (picker.value && statsOn.value && builder.slotLocks(picker.value.index).skillLocked ? "A player with a stat increase can't also have an added skill. Remove it to pick a skill." : ""));
/** AG / PA are roll targets: improving lowers the number (3+ → 2+). AV is "9+" but rises (9+ → 10+). */
const isTarget = (stat: string): boolean => stat === "AG" || stat === "PA";
const verb = (stat: string): string => (isTarget(stat) ? "Improve" : "Increase");
const upLabel = (o: { stat: string; to: string; cost: string; reason: string }): string =>
  o.reason ? `${verb(o.stat)} ${o.stat}: ${o.reason}` : `${verb(o.stat)} ${o.stat} to ${o.to}${o.cost ? `, ${o.cost}` : ""}`;
const downLabel = (o: { stat: string; has: boolean; removeReason: string }): string => (o.has ? `Remove ${o.stat} increase` : `Remove ${o.stat} increase: ${o.removeReason}`);
async function refocus(stat: string, prefer: "up" | "down"): Promise<void> {
  await nextTick();
  const pick = (dir: string) => dialog.value?.querySelector?.<HTMLElement>(`[data-step="${dir}-${stat}"]:not([aria-disabled="true"])`);
  (pick(prefer) ?? pick(prefer === "up" ? "down" : "up"))?.focus({ preventScroll: true });
}
function statUp(stat: string): void {
  if (!picker.value) return;
  const o = steps.value.find((x) => x.stat === stat);
  if (!o || o.reason) return;
  const refused = builder.addStat(picker.value.index, stat);
  if (refused) { picker.value = { ...picker.value, error: refused }; return; }
  picker.value = { ...picker.value, error: "" };
  statLive.value = `${stat} ${isTarget(stat) ? "improved" : "increased"} to ${o.to}.`;
  void refocus(stat, "up");
}
function statDown(stat: string): void {
  if (!picker.value) return;
  const o = steps.value.find((x) => x.stat === stat);
  if (!o?.has) return;
  builder.removeStat(picker.value.index, stat);
  picker.value = { ...picker.value, error: "" };
  statLive.value = `${stat} increase removed.`;
  void refocus(stat, "down");
}
const heading = computed(() => {
  if (!picker.value || !slot.value) return "";
  return `${statsOn.value ? "Advance" : "Add skill"}: #${picker.value.index + 1} ${builder.shortName(position.value)}`;
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
        <div class="tb-adv-top" :class="{ 'with-stats': statsOn && steps.length }">
          <div class="tb-adv-blades">
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
            </template>
          </div>
          <div v-if="statsOn && steps.length" class="tb-adv-stats" role="group" aria-labelledby="tb-adv-stats-k">
            <span id="tb-adv-stats-k" class="tb-k">Stat increases</span>
            <div class="tb-adv-bar">
              <span v-for="o in steps" :key="o.stat" class="tb-adv-col">
                <small class="tb-adv-cost" :class="{ off: Boolean(o.reason) }" aria-hidden="true">{{ o.cost }}</small>
                <button type="button" class="tb-adv-step" data-dir="up" :data-step="`up-${o.stat}`" :aria-disabled="o.reason ? 'true' : undefined"
                  :title="o.reason || `${verb(o.stat)} ${o.stat}: ${o.value} → ${o.to}${o.cost ? ` (${o.cost})` : ''}`"
                  :aria-label="upLabel(o)" @click="statUp(o.stat)"><span aria-hidden="true">+</span></button>
                <span class="tb-stat" :class="{ up: o.up }"><b>{{ o.value }}</b><small>{{ o.stat }}</small></span>
                <button type="button" class="tb-adv-step" data-dir="down" :data-step="`down-${o.stat}`" :aria-disabled="o.has ? undefined : 'true'"
                  :title="o.has ? `Remove the ${o.stat} increase` : o.removeReason" :aria-label="downLabel(o)" @click="statDown(o.stat)"><span aria-hidden="true">−</span></button>
              </span>
            </div>
            <p class="tn-sr" role="status" aria-live="polite">{{ statLive }}</p>
          </div>
        </div>
        <p v-if="skillLockNote" class="muted tb-adv-note">{{ skillLockNote }}</p>
        <div v-if="sections && activeGroup" class="tb-chips">
          <span v-for="k in activeGroup.skills" :key="k.skill" class="tb-chip-cell">
            <button type="button" class="tb-chip" :class="[categoryClass(k.category), { innate: chip(k).innate, added: chip(k).added }]"
              :disabled="chip(k).innate || chip(k).added || Boolean(chip(k).reason)" :title="chip(k).reason || undefined" @click="pick(k.skill)">
              <img v-if="builder.skillIcon(k.skill)" class="skill-icon" :src="builder.skillIcon(k.skill)" alt="" aria-hidden="true" />
              <span>{{ k.skill }}</span>
              <img v-if="k.elite" class="tb-elite" :src="ELITE_ICON" alt="Elite skill" title="Elite skill" width="16" height="16" />
              <small v-if="chip(k).innate">Printed</small>
              <small v-else-if="chip(k).added">Added</small>
              <small v-else>{{ chip(k).price }}</small>
            </button>
            <button v-if="chip(k).added" type="button" class="tb-chip-x" :aria-label="`Remove ${k.skill}`" @click="builder.removeSkill(picker.index, k.skill)">×</button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
