<script setup lang="ts">
// League management → Templates (owner: "Let's also have users able to configure templates for seasons under the league
// settings."): save any season of this league as a season template, and the Templates list (your own season templates,
// usable in every league you run, and those other organisers shared with you).
import { computed, inject, ref } from "vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import TemplateSaveDialog from "./TemplateSaveDialog.vue";
import TemplatesPanel from "./TemplatesPanel.vue";
import { LEAGUE_SETTINGS_KEY } from "../leagues/settings";
import { leagueTemplates } from "../leagues/templates";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const templates = leagueTemplates(inject(API_KEY)!, inject(SESSION_KEY)!);
// League seasons only (a ladder is a later template kind).
const seasons = computed(() => state.seasons.filter((s) => (s as { competition?: string }).competition !== "ladder"));
const seasonId = ref("");
const picked = computed(() => seasons.value.find((s) => s.id === seasonId.value) ?? seasons.value[0]);
const saving = ref(false);
async function save(input: { name: string; description: string; includePayLinks: boolean }): Promise<void> {
  if (!picked.value) return;
  const saved = await templates.save({ ...input, from: { leagueId: state.id, seasonId: picked.value.id } });
  if (saved) saving.value = false;
}
</script>

<template>
  <TemplatesPanel :templates="templates" title="Season templates" heading-id="ls-tpl-h">
    <div class="tp-tools" data-save-season-template>
      <label v-if="seasons.length > 1" class="sf-field">
        <span class="sf-k">Season to save</span>
        <select v-model="seasonId" class="sf-input">
          <option value="">{{ seasons[0]!.name }}</option>
          <option v-for="s in seasons.slice(1)" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <button class="sf-btn primary" type="button" :disabled="!picked || Boolean(templates.state.busy)" aria-haspopup="dialog" data-save-template @click="saving = true">
        Save {{ seasons.length > 1 ? "season" : picked?.name ?? "season" }} as template
      </button>
    </div>
    <p class="tp-help">Templates are yours, not the league's: use one in any league you run from Start a new season, From template.</p>
    <TemplateSaveDialog
      v-if="saving && picked" kind="season" :default-name="`${state.league?.name ?? ''} ${picked.name}`.trim()" pay-links
      :source="picked.name" :busy="templates.state.busy === 'save'" :error="templates.state.error" @close="saving = false" @save="save"
    />
  </TemplatesPanel>
</template>
