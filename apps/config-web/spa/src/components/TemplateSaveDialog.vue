<script setup lang="ts">
// "Save as template" (competition templates): a name, an optional description and, when the source has payment links,
// whether to keep them (they stay yours: organisers you share with never see them, and using them is asked each time).
// The caller does the save and passes `busy` / `error` back.
import { ref } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import { TEMPLATE_DESCRIPTION_MAX, TEMPLATE_KIND_LABEL, TEMPLATE_NAME_MAX, type TemplateKind } from "../shared/templates";
import "../leagues/leagues.css";
import "../shared/templates.css";

const props = withDefaults(defineProps<{ kind: TemplateKind; defaultName?: string; payLinks?: boolean; busy?: boolean; error?: string; source?: string }>(), {
  defaultName: "", payLinks: false, busy: false, error: "", source: "",
});
const emit = defineEmits<{ close: []; save: [input: { name: string; description: string; includePayLinks: boolean }] }>();
const name = ref(props.defaultName.slice(0, TEMPLATE_NAME_MAX));
const description = ref("");
const includePay = ref(true);
const submit = (): void => {
  if (name.value.trim()) emit("save", { name: name.value.trim(), description: description.value.trim(), includePayLinks: props.payLinks && includePay.value });
};
</script>

<template>
  <LeagueDialog class="tp-dialog" id="tp-save-h" title="Save as template" :cap="`${TEMPLATE_KIND_LABEL[kind]} template`" tag="form" :busy="busy" describedby="tp-save-note" @close="emit('close')" @submit="submit">
    <p id="tp-save-note" class="tp-help">
      <template v-if="kind === 'season'">Keeps the phases, divisions, registration settings, regions and the rules with house rules. Use it for a new season in any league you run.</template>
      <template v-else>Keeps the ruleset, house rules, format, tiebreakers, points, pairing, registration settings, check-in times (relative to the start) and the Discord event choices.</template>
      Never webhook URLs, coaches or entries.<template v-if="source"> From {{ source }}.</template>
    </p>
    <label class="sf-field"><span class="sf-k">Name</span><input v-model="name" class="sf-input" type="text" :maxlength="TEMPLATE_NAME_MAX" required data-autofocus data-template-name /></label>
    <label class="sf-field"><span class="sf-k">Description (optional)</span><textarea v-model="description" class="sf-input" rows="2" :maxlength="TEMPLATE_DESCRIPTION_MAX" placeholder="What it is for"></textarea></label>
    <label v-if="payLinks" class="sf-check"><input v-model="includePay" type="checkbox" data-include-pay /> Keep my payment links (only you see them; asked each time you use the template)</label>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    <template #foot>
      <button class="sf-btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
      <button class="sf-btn primary" type="submit" :disabled="busy || !name.trim()" data-template-save>{{ busy ? "Saving..." : "Save template" }}</button>
    </template>
  </LeagueDialog>
</template>
