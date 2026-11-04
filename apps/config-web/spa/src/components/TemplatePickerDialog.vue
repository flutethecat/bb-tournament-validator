<script setup lang="ts">
// "Start from template": pick one of your templates or one shared with you. When the template is yours and keeps
// payment links, using them is asked here (off by default).
import { computed, onMounted, ref } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import { ownerLine, type TemplatesController, type TemplateView } from "../shared/templates";
import "../leagues/leagues.css";
import "../shared/templates.css";

const props = withDefaults(defineProps<{ templates: TemplatesController; title?: string; action?: string }>(), { title: "Start from template", action: "Use template" });
const emit = defineEmits<{ close: []; pick: [t: TemplateView, usePayLinks: boolean] }>();
const { state } = props.templates;
onMounted(() => { if (!state.loaded) void props.templates.load(); });
const usable = computed(() => state.list.filter((t) => t.content));
const picked = ref("");
const chosen = computed(() => usable.value.find((t) => t.id === picked.value));
const usePay = ref(false);
const submit = (): void => { if (chosen.value) emit("pick", chosen.value, Boolean(chosen.value.mine && chosen.value.hasPayLinks && usePay.value)); };
</script>

<template>
  <LeagueDialog class="tp-dialog" id="tp-pick-h" :title="title" :cap="`${usable.length} templates`" tag="form" wide @close="emit('close')" @submit="submit">
    <p v-if="!state.loaded" class="tp-empty" role="status">Loading templates...</p>
    <p v-else-if="!usable.length" class="tp-empty">No templates yet. Save one with "Save as template" on the Review step or in Manage.</p>
    <ul v-else class="tp-list" aria-label="Templates">
      <li v-for="t in usable" :key="t.id">
        <button type="button" class="tp-row" :data-mine="t.mine ? 'true' : 'false'" :aria-pressed="picked === t.id ? 'true' : 'false'" :data-pick="t.id" @click="picked = t.id">
          <span class="tp-head"><span class="tp-name">{{ t.name }}</span><span class="sf-chip tp-owner" :data-tone="t.mine ? 'ok' : 'soon'">{{ ownerLine(t) }}</span></span>
          <span v-if="t.description" class="tp-desc">{{ t.description }}</span>
          <dl v-if="t.summary.length" class="tp-facts"><div v-for="r in t.summary" :key="r.k"><dt>{{ r.k }}</dt><dd>{{ r.v }}</dd></div></dl>
        </button>
      </li>
    </ul>
    <label v-if="chosen?.mine && chosen.hasPayLinks" class="sf-check"><input v-model="usePay" type="checkbox" data-use-pay /> Use the template's payment links</label>
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <template #foot>
      <button class="sf-btn" type="button" @click="emit('close')">Cancel</button>
      <button class="sf-btn primary" type="submit" :disabled="!chosen" data-use-template>{{ action }}</button>
    </template>
  </LeagueDialog>
</template>
