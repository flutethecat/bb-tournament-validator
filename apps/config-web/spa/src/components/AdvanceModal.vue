<script setup lang="ts">
// Advancement modal on the team management page: drives POST /api/teams/<id>/advancement through the shared controller
// (teams/manage.ts). Add Skill: random Primary (pick a category, keep one of two rolled skills) or chosen Primary; Secondary
// shows the server's reason while it is unavailable. Add Characteristic: roll, then keep a stat or a Primary fallback.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { FOCUSABLE } from "../home/shell";
import { dialogKey, type TeamManage } from "../teams/manage";
import "../leagues/leagues.css";

const props = defineProps<{ manage: TeamManage }>();
const state = props.manage.state;
const flow = computed(() => state.flow!);
const player = computed(() => state.model?.team.players[flow.value.playerIndex]);
const progress = computed(() => player.value?.progress);
const who = computed(() => {
  const p = player.value;
  return p ? `#${p.number} ${p.name ? `${p.name} (${p.position})` : p.position}` : "";
});
const title = computed(() => (flow.value.kind === "characteristic" ? "Add Characteristic" : "Add Skill"));
const chosen = ref("");
const fallback = ref("");
const unique = (list: string[]) => [...new Set(list)];

// Focus (aria-modal): on open focus moves into the dialog; Tab / Shift+Tab wrap inside it (the page behind is inert, see
// TeamManageView); Escape closes unless a request is in flight. The view puts focus back on the opener after closing.
const dialog = ref<HTMLElement | null>(null);
const focusables = (): HTMLElement[] =>
  Array.from(dialog.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null || el === document.activeElement);
function onKey(e: KeyboardEvent): void {
  const action = dialogKey(e, focusables(), document.activeElement as HTMLElement | null, flow.value.busy);
  if (!action) return;
  // Shell shortcuts stop here (this listener runs first: window, capture) so App.vue never sees them; typing is kept.
  if (action.type === "stop") { e.stopPropagation(); return; }
  e.preventDefault();
  e.stopPropagation();
  if (action.type === "close") props.manage.close();
  else if (action.type === "focus") action.target.focus({ preventScroll: true });
}
onMounted(async () => {
  window.addEventListener("keydown", onKey, true);
  await nextTick();
  const first = dialog.value?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables().find((el) => !el.classList.contains("ls-dialog-x"));
  (first ?? dialog.value)?.focus({ preventScroll: true });
});
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
// A step change re-renders the body and a request disables its buttons: keep focus inside the dialog.
watch(() => [state.flow?.step, state.flow?.busy], () => { if (state.flow) keepFocus(); });
function keepFocus(): void {
  void nextTick(() => {
    if (dialog.value && !dialog.value.contains(document.activeElement)) (focusables().find((el) => !el.classList.contains("ls-dialog-x")) ?? dialog.value).focus({ preventScroll: true });
  });
}
</script>

<template>
  <div class="ls-dialog-backdrop" @click.self="!flow.busy && manage.close()">
    <div ref="dialog" class="ls-dialog tm-modal" role="dialog" @keydown.stop aria-modal="true" aria-labelledby="tm-adv-h" tabindex="-1" :data-step="flow.step">
      <header class="hm-band">
        <h2 id="tm-adv-h">{{ title }}</h2>
        <span v-if="progress" class="hm-cap">{{ progress.spp }} SPP</span>
        <button type="button" class="ls-dialog-x" aria-label="Close" :disabled="flow.busy" @click="manage.close()">×</button>
      </header>
      <div v-if="progress" class="ls-dialog-body">
        <p><strong>{{ who }}</strong> · {{ progress.spp }} SPP to spend · {{ progress.rank }}</p>

        <template v-if="flow.step === 'choose' && flow.kind === 'skill'">
          <div class="tm-options">
            <section class="ls-sub tm-adv-option" :data-off="!progress.methods.randomPrimary.available">
              <h3 class="ls-sub-h">Random Primary skill <span class="hm-cap">{{ progress.costs?.randomPrimary }} SPP</span></h3>
              <template v-if="progress.methods.randomPrimary.available">
                <p class="muted">Pick a category: two skills are rolled from it and you keep one. The SPP is spent when you roll.</p>
                <div class="tm-choices">
                  <button v-for="c in progress.primaryCategories" :key="c" type="button" class="ls-btn small" :disabled="flow.busy" @click="manage.rollRandomPrimary(c)">{{ c }}</button>
                </div>
              </template>
              <p v-else class="muted">{{ progress.methods.randomPrimary.reason }}</p>
            </section>
            <section class="ls-sub tm-adv-option" :data-off="!progress.methods.chosenPrimary.available">
              <h3 class="ls-sub-h">Chosen Primary skill <span class="hm-cap">{{ progress.costs?.chosenPrimary }} SPP</span></h3>
              <form v-if="progress.methods.chosenPrimary.available" class="tm-choices" @submit.prevent="chosen && manage.chooseSkill(chosen)">
                <label class="tn-sr" for="tm-chosen">Primary skill</label>
                <select id="tm-chosen" v-model="chosen" :disabled="flow.busy">
                  <option value="" disabled>Choose a skill</option>
                  <option v-for="s in progress.primarySkills" :key="s" :value="s">{{ s }}</option>
                </select>
                <button type="submit" class="ls-btn primary" :disabled="flow.busy || !chosen">Add skill</button>
              </form>
              <p v-else class="muted">{{ progress.methods.chosenPrimary.reason }}</p>
            </section>
            <section class="ls-sub tm-adv-option" data-off="true">
              <h3 class="ls-sub-h">Chosen Secondary skill <span class="hm-cap">{{ progress.costs?.chosenSecondary }} SPP</span></h3>
              <p class="muted">{{ progress.methods.chosenSecondary.reason || "Not available right now." }}</p>
            </section>
          </div>
        </template>

        <template v-else-if="flow.step === 'choose'">
          <p>Roll a D8 for a characteristic improvement ({{ progress.costs?.characteristic }} SPP). The SPP is spent when you roll; then you pick one of the results the roll allows, or a Primary skill instead.</p>
          <div class="ls-actions">
            <button type="button" class="ls-btn primary" :disabled="flow.busy" @click="manage.rollCharacteristic()">{{ flow.busy ? "Rolling..." : "Roll" }}</button>
          </div>
        </template>

        <template v-else-if="flow.step === 'pick' && flow.pending">
          <template v-if="flow.pending.method === 'randomPrimary'">
            <p>Keep one of the rolled skills:</p>
            <div class="tm-choices">
              <button v-for="s in unique(flow.pending.choices)" :key="s" type="button" class="ls-btn small" :disabled="flow.busy" @click="manage.commit({ type: 'skill', skill: s })">{{ s }}</button>
            </div>
          </template>
          <template v-else>
            <p>You rolled <strong>{{ flow.pending.roll }}</strong>.</p>
            <div v-if="flow.pending.choices.length" class="tm-choices" aria-label="Characteristics">
              <button v-for="c in flow.pending.choices" :key="c" type="button" class="ls-btn small" :disabled="flow.busy" @click="manage.commit({ type: 'characteristic', characteristic: c })">+{{ c }}</button>
            </div>
            <p v-else class="muted">No characteristic this roll allows can be improved for this player.</p>
            <form v-if="flow.pending.primaryFallbacks.length" class="tm-choices" @submit.prevent="fallback && manage.commit({ type: 'skill', skill: fallback })">
              <label class="tn-sr" for="tm-fallback">Primary skill instead</label>
              <select id="tm-fallback" v-model="fallback" :disabled="flow.busy">
                <option value="" disabled>Or a Primary skill instead</option>
                <option v-for="s in flow.pending.primaryFallbacks" :key="s" :value="s">{{ s }}</option>
              </select>
              <button type="submit" class="ls-btn" :disabled="flow.busy || !fallback">Take skill</button>
            </form>
          </template>
          <p class="muted">This roll is saved on the team: closing keeps it for later.</p>
        </template>

        <p v-else-if="flow.step === 'done'" class="tm-result" role="status">{{ flow.result }}</p>

        <p v-if="flow.error" class="ls-error" role="alert">{{ flow.error }}</p>
      </div>
      <footer v-if="progress" class="ls-dialog-foot">
        <button type="button" class="ls-btn" :disabled="flow.busy" @click="manage.close()">{{ flow.step === "done" ? "Done" : "Close" }}</button>
      </footer>
    </div>
  </div>
</template>
