<script setup lang="ts">
// Create Tournament dialog (owner 10-30): Name, Ruleset, Type, then the rule fields Edit Tournament shares (Max players,
// Rounds for Swiss, First tiebreaker). Create = POST /api/tournaments; the new draft opens on its Manage tab. The
// server's refusals (400 / 409) show inline, word for word.
import { computed, inject, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import TournamentRulesFields from "./TournamentRulesFields.vue";
import { createdLocation, FORMAT_OPTIONS, TOURNAMENT_CREATOR_KEY } from "../tournaments/create";

const creator = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = creator;
const router = useRouter();
const nameInput = ref<HTMLInputElement | null>(null);
const noPackages = computed(() => state.packagesStatus === "ready" && !state.packages.length);

async function create(): Promise<void> {
  const id = await creator.submit();
  if (id) await router.push(createdLocation(id));
}
const close = (): void => creator.close();
const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
onMounted(() => {
  window.addEventListener("keydown", onKey);
  void nextTick(() => nameInput.value?.focus({ preventScroll: true }));
});
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="tn-modal-backdrop" @click.self="close">
    <div class="tn-modal tn-panel tc-modal" role="dialog" aria-modal="true" aria-labelledby="tc-modal-h">
      <h3 id="tc-modal-h" class="tn-band">
        Create Tournament
        <button type="button" class="tn-modal-x" aria-label="Close" :disabled="state.busy" @click="close">×</button>
      </h3>
      <div class="tn-panel-body">
        <form class="tn-form-grid" novalidate @submit.prevent="create">
          <label class="tn-field tn-field-wide"><span class="tn-fact-k">Name</span><input ref="nameInput" v-model="state.form.name" type="text" maxlength="100" autocomplete="off" required /></label>
          <label class="tn-field tn-field-wide">
            <span class="tn-fact-k">Ruleset</span>
            <select v-model="state.form.packageName" required :disabled="!state.packages.length">
              <option v-if="!state.packages.length" value="">{{ state.packagesStatus === "loading" || state.packagesStatus === "idle" ? "Loading rulesets..." : "No saved rulesets" }}</option>
              <option v-for="p in state.packages" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
          <label class="tn-field">
            <span class="tn-fact-k">Type</span>
            <select v-model="state.form.format"><option v-for="f in FORMAT_OPTIONS" :key="f.id" :value="f.id">{{ f.label }}</option></select>
          </label>
          <TournamentRulesFields
            v-model:max-players="state.form.maxPlayers" v-model:round-count="state.form.roundCount" v-model:primary-tiebreaker="state.form.primaryTiebreaker"
            :swiss="state.form.format === 'swiss'" rounds-optional
          />
          <p class="muted tc-full">The tournament starts as a draft. Dates, registration and the page are set on its Manage tab.</p>
          <p v-if="state.packagesStatus === 'error'" class="lobby-error tc-full" role="alert">
            Can't load the rulesets. <button class="lobby-btn small" type="button" @click="creator.loadPackages()">Try again</button>
          </p>
          <p v-else-if="noPackages" class="lobby-error tc-full" role="alert">No saved rulesets yet: save one in the Tournament Creator first.</p>
          <p v-if="state.error" class="lobby-error tc-full" role="alert">{{ state.error }}</p>
          <div class="tn-actions tn-form-actions">
            <button class="lobby-btn primary" type="submit" :disabled="state.busy || !state.packages.length">{{ state.busy ? "Creating..." : "Create draft" }}</button>
            <button class="lobby-btn" type="button" :disabled="state.busy" @click="close">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
