<script setup lang="ts">
// The Templates list (competition templates): your own templates and those other organisers shared with you, for one
// kind. Yours: Share, Rename, Make a copy, Delete. Shared: Make a copy (your own editable copy). League settings shows the
// season kind, tournament Manage the tournament kind. The default slot holds the page's own "Save as template".
import { computed, onMounted, ref, watch } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import TemplateShareDialog from "./TemplateShareDialog.vue";
import { ownerLine, TEMPLATE_DESCRIPTION_MAX, TEMPLATE_NAME_MAX, type TemplatesController, type TemplateView } from "../shared/templates";
import "../leagues/leagues.css";
import "../shared/templates.css";

const props = withDefaults(defineProps<{ templates: TemplatesController; title?: string; headingId?: string }>(), { title: "Templates", headingId: "tp-list-h" });
const { state } = props.templates;
onMounted(() => { if (!state.loaded) void props.templates.load(); });
// Another account signed in (the controller was reset): load that account's templates.
watch(() => state.account, () => { if (!state.loaded) void props.templates.load(); });
const own = computed(() => state.list.filter((t) => t.mine));
const shared = computed(() => state.list.filter((t) => !t.mine));
const sharing = ref<TemplateView | null>(null);
const deleting = ref<TemplateView | null>(null);
const renaming = ref<TemplateView | null>(null);
const form = ref({ name: "", description: "" });
function startRename(t: TemplateView): void { form.value = { name: t.name, description: t.description }; renaming.value = t; }
async function rename(): Promise<void> {
  if (renaming.value && await props.templates.rename(renaming.value, form.value.name.trim(), form.value.description.trim())) renaming.value = null;
}
async function remove(): Promise<void> { if (deleting.value && await props.templates.remove(deleting.value)) deleting.value = null; }
const busy = computed(() => Boolean(state.busy));
</script>

<template>
  <section class="hm-panel tp-panel" :aria-labelledby="headingId" data-templates-panel>
    <header class="hm-band"><h2 :id="headingId">{{ title }}</h2><span class="hm-cap">{{ own.length }} yours · {{ shared.length }} shared</span></header>
    <slot />
    <p v-if="!state.loaded" class="tp-empty" role="status">Loading templates...</p>
    <template v-else>
      <ul v-if="state.list.length" class="tp-list">
        <li v-for="t in [...own, ...shared]" :key="t.id" class="tp-row" :data-mine="t.mine ? 'true' : 'false'" :data-template="t.id">
          <div class="tp-head">
            <h3 class="tp-name">{{ t.name }}</h3>
            <span class="sf-chip tp-owner" :data-tone="t.mine ? 'ok' : 'soon'">{{ ownerLine(t) }}</span>
          </div>
          <p v-if="t.description" class="tp-desc">{{ t.description }}</p>
          <dl v-if="t.summary.length" class="tp-facts"><div v-for="r in t.summary" :key="r.k"><dt>{{ r.k }}</dt><dd>{{ r.v }}</dd></div></dl>
          <p v-if="t.problem" class="sf-error">{{ t.problem }}</p>
          <p v-if="t.mine && t.sharedWith?.length" class="tp-shared">Shared with {{ t.sharedWith.map((s) => s.name).join(", ") }}</p>
          <div class="tp-actions">
            <template v-if="t.mine">
              <button class="sf-btn small" type="button" :disabled="busy" aria-haspopup="dialog" data-share @click="sharing = t">Share</button>
              <button class="sf-btn small" type="button" :disabled="busy" aria-haspopup="dialog" @click="startRename(t)">Rename</button>
            </template>
            <button class="sf-btn small" type="button" :disabled="busy" data-copy @click="templates.copy(t)">Make a copy</button>
            <button v-if="t.mine" class="sf-btn small danger" type="button" :disabled="busy" aria-haspopup="dialog" @click="deleting = t">Delete</button>
          </div>
        </li>
      </ul>
      <p v-else class="tp-empty">No templates yet.</p>
    </template>
    <p v-if="state.error && !sharing" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="state.notice && !sharing" class="hm-notice" role="status">{{ state.notice }}</p>

    <TemplateShareDialog v-if="sharing" :template="sharing" :templates="templates" @close="sharing = null" />
    <LeagueDialog v-if="renaming" class="tp-dialog" id="tp-rename-h" title="Rename template" tag="form" :busy="busy" @close="renaming = null" @submit="rename">
      <label class="sf-field"><span class="sf-k">Name</span><input v-model="form.name" class="sf-input" type="text" :maxlength="TEMPLATE_NAME_MAX" required data-autofocus /></label>
      <label class="sf-field"><span class="sf-k">Description (optional)</span><textarea v-model="form.description" class="sf-input" rows="2" :maxlength="TEMPLATE_DESCRIPTION_MAX"></textarea></label>
      <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
      <template #foot>
        <button class="sf-btn" type="button" @click="renaming = null">Cancel</button>
        <button class="sf-btn primary" type="submit" :disabled="busy || !form.name.trim()">Save</button>
      </template>
    </LeagueDialog>
    <LeagueDialog v-if="deleting" id="tp-delete-h" title="Delete template" :cap="deleting.name" role="alertdialog" :busy="busy" @close="deleting = null">
      <p>Delete this template? Seasons and tournaments made from it keep their settings<template v-if="deleting.sharedWith?.length">, and the organisers you shared it with lose access (their own copies stay)</template>.</p>
      <template #foot>
        <button class="sf-btn" type="button" data-autofocus @click="deleting = null">Cancel</button>
        <button class="sf-btn danger" type="button" :disabled="busy" @click="remove">Delete</button>
      </template>
    </LeagueDialog>
  </section>
</template>
