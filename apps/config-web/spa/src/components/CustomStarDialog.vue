<script setup lang="ts">
// Tournament Creator, "Create a star" (creation wizards v2, owner 11-02): a Roster Builder-style row for an organiser-made
// Star Player. The row carries the sprite (picked from the site's own sprite set), the name, a freely editable cost, the
// MA/ST/AG/PA/AV tiles with + / − (no caps for the organiser), and the skills. The "+" opens the advancement picker (skill
// blades by category, then the chips); under it sit two extra options, Custom trait and Custom rule (a name and a
// description each). They print on the row under the "Special rules" subheader, exactly as coaches see them in every Roster
// Builder step and on the PDF. Coaches hire the star as it is and can never change it.
import { computed, inject, onMounted, ref } from "vue";
import { API_KEY } from "../app";
import LeagueDialog from "./LeagueDialog.vue";
import CustomStarSpecialRules from "./CustomStarSpecialRules.vue";
import {
  CUSTOM_STAR, RULE_KIND_LABEL, STAR_STATS, blankCustomStar, customStarError, skillGroups, spriteOptions, statValue, stepStat,
  type CustomStarDoc, type CustomStarRuleDoc, type SkillGroup, type SpriteOption, type StarStat,
} from "../tournaments/customStars";
import "../leagues/leagues.css";
import "../teams/builder.css";

const props = defineProps<{ star: CustomStarDoc | null; others: CustomStarDoc[]; datasetStars: string[]; readOnly?: boolean }>();
const emit = defineEmits<{ close: []; save: [star: CustomStarDoc] }>();
const api = inject(API_KEY)!;

const draft = ref<CustomStarDoc>(structuredClone(props.star ? { ...props.star, specialRules: props.star.specialRules ?? [] } : blankCustomStar()));
const costK = computed({
  get: () => Math.round(draft.value.cost / 1000),
  set: (v: number) => { draft.value = { ...draft.value, cost: Math.max(0, Math.min(CUSTOM_STAR.costMax, Math.round(Number(v) || 0) * 1000)) }; },
});
const error = ref("");
const tried = ref(false);
const problem = computed(() => customStarError(draft.value, props.others, props.datasetStars));

// ── catalogues: the skill blades (/api/skills?traits=1) and the sprite set (/sprites/manifest.json) ──
const groups = ref<SkillGroup[]>([]);
const sprites = ref<SpriteOption[]>([]);
const loadError = ref("");
onMounted(async () => {
  const [skills, manifest] = await Promise.allSettled([api<unknown>("/api/skills?traits=1"), api<unknown>("/sprites/manifest.json")]);
  if (skills.status === "fulfilled") groups.value = skillGroups(skills.value);
  else loadError.value = "Couldn't load the skill list. Try again in a moment.";
  if (manifest.status === "fulfilled") sprites.value = spriteOptions(manifest.value);
  if (!spriteRace.value) spriteRace.value = sprites.value.find((s) => s.path === draft.value.sprite)?.race ?? "stars";
});

// ── stats ──
const step = (stat: StarStat, dir: 1 | -1): void => { draft.value = stepStat(draft.value, stat, dir); };
const upLabel = (stat: StarStat): string => (stat === "AG" || stat === "PA" ? `Improve ${stat}` : `Increase ${stat}`);
const downLabel = (stat: StarStat): string => (stat === "AG" || stat === "PA" ? `Worsen ${stat}` : `Lower ${stat}`);

// ── the advancement picker (the "+") ──
const pickerOpen = ref(false);
const category = ref("");
const activeGroup = computed(() => groups.value.find((g) => g.category === category.value) ?? groups.value[0] ?? null);
const has = (skill: string): boolean => draft.value.skills.some((k) => k.replace(/\s*\(.*\)$/, "") === skill);
function addSkill(skill: string): void {
  if (has(skill) || draft.value.skills.length >= CUSTOM_STAR.skills) return;
  draft.value = { ...draft.value, skills: [...draft.value.skills, skill] };
}
const removeSkill = (skill: string): void => { draft.value = { ...draft.value, skills: draft.value.skills.filter((k) => k !== skill) }; };

// ── custom trait / custom rule (under the "+") ──
const ruleForm = ref<CustomStarRuleDoc | null>(null);
const ruleError = ref("");
function openRule(kind: CustomStarRuleDoc["kind"]): void { ruleForm.value = { kind, name: "", description: "" }; ruleError.value = ""; }
function addRule(): void {
  const r = ruleForm.value;
  if (!r) return;
  if (!r.name.trim() || !r.description.trim()) { ruleError.value = "Enter a name and a description."; return; }
  if ((draft.value.specialRules ?? []).length >= CUSTOM_STAR.specialRules) { ruleError.value = `A star has at most ${CUSTOM_STAR.specialRules} special rules.`; return; }
  draft.value = { ...draft.value, specialRules: [...(draft.value.specialRules ?? []), { kind: r.kind, name: r.name.trim(), description: r.description.trim() }] };
  ruleForm.value = null;
  pickerOpen.value = false;
}
const removeRule = (i: number): void => { draft.value = { ...draft.value, specialRules: (draft.value.specialRules ?? []).filter((_, j) => j !== i) }; };

// ── the sprite picker ──
const spriteOpen = ref(false);
const spriteRace = ref("");
const races = computed(() => [...new Set(sprites.value.map((s) => s.race))].sort((a, b) => (a === "stars" ? -1 : b === "stars" ? 1 : a.localeCompare(b))));
const raceSprites = computed(() => sprites.value.filter((s) => s.race === spriteRace.value));
function pickSprite(path: string): void { draft.value = { ...draft.value, sprite: path }; spriteOpen.value = false; }
function clearSprite(): void { const { sprite: _s, ...rest } = draft.value; draft.value = rest; spriteOpen.value = false; }
const initials = computed(() => (draft.value.name.trim() || "Star").slice(0, 2).toUpperCase());

function save(): void {
  tried.value = true;
  if (problem.value) { error.value = problem.value; return; }
  emit("save", structuredClone({ ...draft.value, name: draft.value.name.trim() }));
}
</script>

<template>
  <LeagueDialog id="cs-dialog-h" :title="star ? 'Edit star' : 'Create a star'" cap="Custom star" wide tag="form" @close="emit('close')" @submit="save">
    <p class="cs-lede">Coaches hire this star like any other and can never change it. Stars never take added skills.</p>
    <p v-if="loadError" class="sf-error" role="alert">{{ loadError }}</p>

    <!-- the Roster Builder row: sprite · name · cost, the stat strip with the "+", the skills, then Special rules -->
    <div class="tb-row cs-row" data-custom-star-row>
      <button type="button" class="sprite-frame tb-sprite tb-row-sprite cs-sprite-btn" :aria-expanded="spriteOpen ? 'true' : 'false'" aria-controls="cs-sprites"
        :aria-label="draft.sprite ? 'Change the sprite' : 'Pick a sprite'" :disabled="readOnly" @click="spriteOpen = !spriteOpen">
        <span class="sprite-fallback">{{ initials }}</span><img v-if="draft.sprite" class="sprite-image" :src="draft.sprite" alt="" />
      </button>
      <span class="tb-who cs-who">
        <label class="sf-field"><span class="sf-k">Name</span>
          <input v-model="draft.name" data-autofocus type="text" :maxlength="CUSTOM_STAR.nameChars" autocomplete="off" required :disabled="readOnly" :aria-invalid="tried && problem.startsWith('Give') ? 'true' : undefined" />
        </label>
      </span>
      <label class="sf-field cs-cost"><span class="sf-k">Cost (k gold)</span>
        <input v-model.number="costK" type="number" min="0" :max="CUSTOM_STAR.costMax / 1000" step="5" inputmode="numeric" :disabled="readOnly" />
      </label>
      <span class="tb-row-line2 cs-line2">
        <span class="tb-adv-bar cs-stats" role="group" aria-label="Characteristics">
          <span v-for="stat in STAR_STATS" :key="stat" class="tb-adv-col">
            <button type="button" class="tb-adv-step" data-dir="up" :data-step="`up-${stat}`" :aria-label="upLabel(stat)" :disabled="readOnly" @click="step(stat, 1)"><span aria-hidden="true">+</span></button>
            <span class="tb-stat"><b>{{ statValue(draft, stat) }}</b><small>{{ stat }}</small></span>
            <button type="button" class="tb-adv-step" data-dir="down" :data-step="`down-${stat}`" :aria-label="downLabel(stat)" :disabled="readOnly" @click="step(stat, -1)"><span aria-hidden="true">−</span></button>
          </span>
        </span>
        <span class="tb-row-actions">
          <button type="button" class="tb-advance" aria-haspopup="true" :aria-expanded="pickerOpen ? 'true' : 'false'" aria-controls="cs-picker" aria-label="Add a skill, a custom trait or a custom rule"
            title="Add a skill, a custom trait or a custom rule" :disabled="readOnly" @click="pickerOpen = !pickerOpen; ruleForm = null"><span aria-hidden="true">+</span></button>
        </span>
      </span>
      <span class="row-skills tb-row-skills cs-skills">
        <span v-if="!draft.skills.length" class="muted">No skills yet.</span>
        <span v-for="k in draft.skills" :key="k" class="skill skill-general tb-bought">{{ k }}<button type="button" class="tb-chip-x" :aria-label="`Remove ${k}`" :disabled="readOnly" @click="removeSkill(k)"><span aria-hidden="true">×</span></button></span>
        <CustomStarSpecialRules :rules="draft.specialRules ?? []" :removable="!readOnly" @remove="removeRule" />
      </span>
    </div>

    <!-- the advancement picker: blades by category, the chips, and the two extra options under the "+" -->
    <section v-if="pickerOpen" id="cs-picker" class="cs-picker" aria-label="Add to the star">
      <div class="cs-extra" role="group" aria-label="Special rules">
        <button type="button" class="sf-btn small" data-add-rule="trait" @click="openRule('trait')">+ {{ RULE_KIND_LABEL.trait }}</button>
        <button type="button" class="sf-btn small" data-add-rule="rule" @click="openRule('rule')">+ {{ RULE_KIND_LABEL.rule }}</button>
      </div>
      <div v-if="ruleForm" class="cs-rule-form" :data-kind="ruleForm.kind">
        <label class="sf-field"><span class="sf-k">{{ RULE_KIND_LABEL[ruleForm.kind] }} name</span>
          <input v-model="ruleForm.name" type="text" :maxlength="CUSTOM_STAR.ruleNameChars" autocomplete="off" />
        </label>
        <label class="sf-field"><span class="sf-k">Description</span>
          <textarea v-model="ruleForm.description" rows="3" :maxlength="CUSTOM_STAR.ruleDescriptionChars"></textarea>
        </label>
        <p v-if="ruleError" class="sf-error" role="alert">{{ ruleError }}</p>
        <div class="sf-btn-row">
          <button type="button" class="sf-btn small" @click="ruleForm = null">Cancel</button>
          <button type="button" class="sf-btn small primary" data-rule-add @click="addRule">Add {{ RULE_KIND_LABEL[ruleForm.kind].toLowerCase() }}</button>
        </div>
      </div>
      <template v-else>
        <div class="tb-blades">
          <span class="tb-k">Skills</span>
          <button v-for="g in groups" :key="g.category" type="button" class="tb-blade" :aria-pressed="(activeGroup?.category === g.category) ? 'true' : 'false'" @click="category = g.category">
            {{ g.category }} <small>{{ g.skills.length }}</small>
          </button>
        </div>
        <div v-if="activeGroup" class="tb-chips cs-chips">
          <button v-for="k in activeGroup.skills" :key="k.name" type="button" class="tb-chip" :class="{ added: has(k.name) }" :disabled="has(k.name)" @click="addSkill(k.name)">
            <span>{{ k.name }}</span><small v-if="has(k.name)">Printed</small>
          </button>
        </div>
      </template>
    </section>

    <section v-if="spriteOpen" id="cs-sprites" class="cs-sprites" aria-label="Sprites">
      <label class="sf-field cs-race"><span class="sf-k">Sprites from</span>
        <select v-model="spriteRace"><option v-for="r in races" :key="r" :value="r">{{ r === "stars" ? "Star players" : r }}</option></select>
      </label>
      <div class="cs-sprite-grid" role="listbox" aria-label="Sprite">
        <button v-for="s in raceSprites" :key="s.path" type="button" role="option" class="sprite-frame tb-sprite cs-sprite" :aria-selected="draft.sprite === s.path ? 'true' : 'false'" :title="s.role" @click="pickSprite(s.path)">
          <img class="sprite-image" :src="s.path" :alt="s.role" loading="lazy" />
        </button>
      </div>
      <button v-if="draft.sprite" type="button" class="sf-btn small" @click="clearSprite">No sprite</button>
    </section>

    <p v-if="error && problem" class="sf-error" role="alert">{{ problem }}</p>
    <template #foot>
      <button type="button" class="sf-btn" @click="emit('close')">Cancel</button>
      <button type="submit" class="sf-btn primary" data-save-star :disabled="readOnly">Save star</button>
    </template>
  </LeagueDialog>
</template>

<style scoped>
.cs-lede { margin: 0 0 10px; color: var(--ui-muted); font: 14px/1.4 var(--font-body); }
.cs-row { grid-template-columns: 64px minmax(0, 1fr) 120px; grid-template-areas: "sprite who cost" "line2 line2 line2" "skills skills skills"; gap: 6px 10px; padding: 8px; }
.cs-row > .cs-sprite-btn { grid-area: sprite; width: 56px; height: 56px; cursor: pointer; }
.cs-row > .cs-who { grid-area: who; }
.cs-row > .cs-cost { grid-area: cost; }
.cs-row > .cs-line2 { grid-area: line2; }
.cs-row > .cs-skills { grid-area: skills; display: flex; flex-wrap: wrap; gap: 4px; }
.cs-stats { display: grid; grid-template-columns: repeat(5, minmax(44px, 1fr)); gap: 4px; max-width: 320px; }
.cs-picker, .cs-sprites { margin-top: 10px; padding: 10px; border: 2px solid var(--sf-panel-line); background: var(--ui-surface-2); border-radius: 2px; }
.cs-extra { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.cs-rule-form { display: grid; gap: 8px; }
.cs-rule-form textarea { font: 15px/1.4 var(--font-body); }
.cs-chips { max-height: 220px; overflow: auto; }
.cs-sprite-grid { display: flex; flex-wrap: wrap; gap: 6px; max-height: 200px; overflow: auto; margin: 8px 0; }
.cs-sprite { width: 52px; height: 52px; cursor: pointer; }
.cs-sprite[aria-selected="true"] { outline: 2px solid var(--sf-seat-home); outline-offset: 1px; }
.cs-sprite .sprite-image, .cs-sprite-btn .sprite-image { image-rendering: pixelated; }
@media (max-width: 600px) {
  .cs-row { grid-template-columns: 56px minmax(0, 1fr); grid-template-areas: "sprite who" "cost cost" "line2 line2" "skills skills"; }
}
</style>
