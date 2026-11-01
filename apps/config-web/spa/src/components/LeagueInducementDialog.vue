<script setup lang="ts">
// Add / edit one custom inducement type (League settings, Inducements): name, category, price (k, 5k steps), cap
// (0-16), an icon from our own set (a radio group: one tab stop, arrows move the choice) and the effect text coaches
// read. The dialog edits a copy and hands it back; the tab's Save stores the table.
import { computed, nextTick, reactive, ref } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import {
  INDUCEMENT_CAP_MAX, INDUCEMENT_CATEGORIES, INDUCEMENT_CATEGORY_LABEL, INDUCEMENT_EFFECT_MAX, INDUCEMENT_ICONS, INDUCEMENT_NAME_MAX, type CustomDraft,
} from "../leagues/inducements";
import { customProblem } from "../../../src/leagues/inducementRules";

const props = defineProps<{ value: CustomDraft; isNew: boolean; otherNames: string[] }>();
const emit = defineEmits<{ close: []; save: [value: CustomDraft] }>();

const draft = reactive<CustomDraft>({ ...props.value });
const priceK = ref<number>(props.value.price / 1000);
const tried = ref(false);
const iconKeys = Object.keys(INDUCEMENT_ICONS);
const effectLength = computed(() => [...draft.effectText.trim()].length);
const problem = computed(() => {
  const c = { ...draft, price: Number.isFinite(priceK.value) ? Math.round(priceK.value * 1000) : NaN };
  const p = customProblem(c);
  if (p) return p;
  const n = draft.name.trim().toLowerCase();
  return props.otherNames.some((o) => o.trim().toLowerCase() === n) ? `There is already an inducement called ${draft.name.trim()}.` : "";
});

const grid = ref<HTMLElement | null>(null);
function onIconKey(e: KeyboardEvent): void {
  const i = iconKeys.indexOf(draft.icon);
  const last = iconKeys.length - 1;
  const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i >= last ? 0 : i + 1) : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i <= 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
  if (to < 0) return;
  e.preventDefault();
  draft.icon = iconKeys[to]!;
  void nextTick(() => grid.value?.querySelectorAll<HTMLElement>("[role=radio]")[to]?.focus());
}

function submit(): void {
  tried.value = true;
  if (problem.value) return;
  emit("save", { ...draft, name: draft.name.trim(), effectText: draft.effectText.trim(), price: Math.round(priceK.value * 1000) });
}
</script>

<template>
  <LeagueDialog id="ind-dlg-h" :title="isNew ? 'Add inducement type' : 'Edit inducement type'" cap="custom" tag="form" wide @close="emit('close')" @submit="submit">
    <div class="ind-form">
      <div class="ind-form-row">
        <label class="sf-field ind-grow"><span class="sf-k">Name</span>
          <input v-model="draft.name" type="text" :maxlength="INDUCEMENT_NAME_MAX" autocomplete="off" placeholder="Lucky Keg" data-autofocus />
        </label>
        <label class="sf-field"><span class="sf-k">Category</span>
          <select v-model="draft.category">
            <option v-for="c in INDUCEMENT_CATEGORIES" :key="c" :value="c">{{ INDUCEMENT_CATEGORY_LABEL[c] }}</option>
          </select>
        </label>
      </div>
      <div class="ind-form-row">
        <label class="sf-field"><span class="sf-k">Price (k)</span>
          <input v-model.number="priceK" type="number" min="0" max="2000" step="5" inputmode="numeric" />
        </label>
        <label class="sf-field"><span class="sf-k">Cap (0-{{ INDUCEMENT_CAP_MAX }})</span>
          <input v-model.number="draft.cap" type="number" min="0" :max="INDUCEMENT_CAP_MAX" step="1" inputmode="numeric" />
        </label>
        <p class="ind-help ind-grow">Prices go in steps of 5k. A cap of 0 keeps the type in the table but stops it being bought.</p>
      </div>
      <fieldset class="ind-icon-field">
        <legend class="sf-k">Icon</legend>
        <div ref="grid" class="ind-icons" role="radiogroup" aria-label="Icon" @keydown="onIconKey">
          <button
            v-for="k in iconKeys" :key="k" type="button" role="radio" class="ind-icon-opt" :aria-checked="draft.icon === k ? 'true' : 'false'"
            :tabindex="draft.icon === k ? 0 : -1" :aria-label="INDUCEMENT_ICONS[k]!.label" :title="INDUCEMENT_ICONS[k]!.label" @click="draft.icon = k"
          ><img :src="INDUCEMENT_ICONS[k]!.src" alt="" width="32" height="32" /></button>
        </div>
      </fieldset>
      <label class="sf-field"><span class="sf-k">Effect</span>
        <textarea v-model="draft.effectText" rows="3" :maxlength="INDUCEMENT_EFFECT_MAX + 20" placeholder="What it does in the game, in a sentence or two." />
      </label>
      <p class="ind-help" :data-over="effectLength > INDUCEMENT_EFFECT_MAX ? 'true' : undefined">{{ effectLength }} / {{ INDUCEMENT_EFFECT_MAX }} characters. Plain text; coaches read it on the league page and in the recorder.</p>
      <p v-if="tried && problem" class="sf-error" role="alert">{{ problem }}</p>
    </div>
    <template #foot>
      <button type="button" class="sf-btn" @click="emit('close')">Cancel</button>
      <button type="submit" class="sf-btn primary">{{ isNew ? "Add to table" : "Update" }}</button>
    </template>
  </LeagueDialog>
</template>
