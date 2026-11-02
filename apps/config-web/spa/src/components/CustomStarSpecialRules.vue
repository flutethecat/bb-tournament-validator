<script setup lang="ts">
// A custom star's custom traits and rules under the small "Special rules" subheader (creation wizards v2): the Creator's
// star row, the Roster Builder's Stars list, roster rows and Ruleset step, and the public ruleset summary all print it.
// It sits below the star's default skills and spans the row.
import { RULE_KIND_LABEL, SPECIAL_RULES_HEADING, SPECIAL_RULES_HINT, type CustomStarRuleDoc } from "../tournaments/customStars";

withDefaults(defineProps<{ rules: CustomStarRuleDoc[]; removable?: boolean; compact?: boolean }>(), { removable: false, compact: false });
const emit = defineEmits<{ remove: [index: number] }>();
</script>

<template>
  <span v-if="rules.length" class="cs-special" :class="{ compact }" data-special-rules>
    <span class="cs-special-h" :title="SPECIAL_RULES_HINT">{{ SPECIAL_RULES_HEADING }}</span>
    <span v-if="!compact" class="cs-special-hint">{{ SPECIAL_RULES_HINT }}</span>
    <span v-for="(r, i) in rules" :key="`${r.kind}-${r.name}-${i}`" class="cs-special-item" :data-kind="r.kind">
      <span class="cs-special-name"><b>{{ r.name }}</b> <small>{{ RULE_KIND_LABEL[r.kind] }}</small></span>
      <span class="cs-special-desc">{{ r.description }}</span>
      <button v-if="removable" type="button" class="tb-chip-x cs-special-x" :aria-label="`Remove ${r.name}`" @click="emit('remove', i)"><span aria-hidden="true">×</span></button>
    </span>
  </span>
</template>

<style>
.cs-special { flex: 1 0 100%; display: grid; gap: 3px; margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--sf-panel-line); min-width: 0; }
.cs-special-h { font: 700 10px/1.2 var(--sf-band-font); letter-spacing: .1em; text-transform: uppercase; color: var(--ui-muted); }
.cs-special-hint { font: 12px/1.3 var(--font-body); color: var(--ui-muted); }
.cs-special-item { position: relative; display: grid; gap: 1px; padding-right: 22px; font: 13px/1.35 var(--font-body); color: var(--ui-text); }
.cs-special-name small { font: 10px/1 var(--sf-band-font); letter-spacing: .06em; text-transform: uppercase; color: var(--ui-muted); }
.cs-special-desc { overflow-wrap: anywhere; }
.cs-special-x { position: absolute; top: 0; right: 0; }
.cs-special.compact .cs-special-item { font-size: 12px; }
/* the Creator's star rows print skills as chips (the Roster Builder's own chips are scoped to its page) */
.cs-skills .skill, .cr-cs-row .row-skills .skill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font: 13px/1.3 var(--font-body); background: var(--ui-surface); border: 1px solid var(--sf-panel-line); border-radius: 2px; }
.cs-skills .skill { position: relative; }
.cs-special-item { isolation: isolate; }
.tb-row-skills .cs-special .cs-special-h, .tb-row-skills .cs-special .cs-special-name small, .tb-row-skills .cs-special .cs-special-hint { color: var(--tb-skillbar-muted, var(--ui-muted)); }
</style>
