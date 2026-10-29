<script setup lang="ts">
// Advancement modal on the team management page: drives POST /api/teams/<id>/advancement through the shared controller
// (teams/manage.ts). Add Skill: random Primary (pick a category, keep one of two rolled skills) or chosen Primary; Secondary
// shows the server's reason while it is unavailable. Add Characteristic: roll, then keep a stat or a Primary fallback.
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { TeamManage } from "../teams/manage";

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

const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !flow.value.busy) props.manage.close(); };
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="tn-modal-backdrop" @click.self="!flow.busy && manage.close()">
    <div class="tn-modal tn-panel tm-modal" role="dialog" aria-modal="true" aria-labelledby="tm-adv-h">
      <h3 id="tm-adv-h" class="tn-band">
        {{ title }}
        <button type="button" class="tn-modal-x" aria-label="Close" :disabled="flow.busy" @click="manage.close()">×</button>
      </h3>
      <div v-if="progress" class="tn-panel-body">
        <p><strong>{{ who }}</strong> · {{ progress.spp }} SPP to spend · {{ progress.rank }}</p>

        <template v-if="flow.step === 'choose' && flow.kind === 'skill'">
          <div class="tm-options">
            <section class="tm-option" :data-off="!progress.methods.randomPrimary.available">
              <h4>Random Primary skill · {{ progress.costs?.randomPrimary }} SPP</h4>
              <template v-if="progress.methods.randomPrimary.available">
                <p class="muted">Pick a category: two skills are rolled from it and you keep one. The SPP is spent when you roll.</p>
                <div class="tm-choices">
                  <button v-for="c in progress.primaryCategories" :key="c" type="button" class="tm-choice" :disabled="flow.busy" @click="manage.rollRandomPrimary(c)">{{ c }}</button>
                </div>
              </template>
              <p v-else class="muted">{{ progress.methods.randomPrimary.reason }}</p>
            </section>
            <section class="tm-option" :data-off="!progress.methods.chosenPrimary.available">
              <h4>Chosen Primary skill · {{ progress.costs?.chosenPrimary }} SPP</h4>
              <form v-if="progress.methods.chosenPrimary.available" class="tm-choices" @submit.prevent="chosen && manage.chooseSkill(chosen)">
                <label class="tn-sr" for="tm-chosen">Primary skill</label>
                <select id="tm-chosen" v-model="chosen" :disabled="flow.busy">
                  <option value="" disabled>Choose a skill</option>
                  <option v-for="s in progress.primarySkills" :key="s" :value="s">{{ s }}</option>
                </select>
                <button type="submit" class="lobby-btn primary" :disabled="flow.busy || !chosen">Add skill</button>
              </form>
              <p v-else class="muted">{{ progress.methods.chosenPrimary.reason }}</p>
            </section>
            <section class="tm-option" data-off="true">
              <h4>Chosen Secondary skill · {{ progress.costs?.chosenSecondary }} SPP</h4>
              <p class="muted">{{ progress.methods.chosenSecondary.reason || "Not available right now." }}</p>
            </section>
          </div>
        </template>

        <template v-else-if="flow.step === 'choose'">
          <p>Roll a D8 for a characteristic improvement ({{ progress.costs?.characteristic }} SPP). The SPP is spent when you roll; then you pick one of the results the roll allows, or a Primary skill instead.</p>
          <div class="tn-actions">
            <button type="button" class="lobby-btn primary" :disabled="flow.busy" @click="manage.rollCharacteristic()">{{ flow.busy ? "Rolling..." : "Roll" }}</button>
          </div>
        </template>

        <template v-else-if="flow.step === 'pick' && flow.pending">
          <template v-if="flow.pending.method === 'randomPrimary'">
            <p>Keep one of the rolled skills:</p>
            <div class="tm-choices">
              <button v-for="s in unique(flow.pending.choices)" :key="s" type="button" class="tm-choice" :disabled="flow.busy" @click="manage.commit({ type: 'skill', skill: s })">{{ s }}</button>
            </div>
          </template>
          <template v-else>
            <p>You rolled <strong>{{ flow.pending.roll }}</strong>.</p>
            <div v-if="flow.pending.choices.length" class="tm-choices" aria-label="Characteristics">
              <button v-for="c in flow.pending.choices" :key="c" type="button" class="tm-choice" :disabled="flow.busy" @click="manage.commit({ type: 'characteristic', characteristic: c })">+{{ c }}</button>
            </div>
            <p v-else class="muted">No characteristic this roll allows can be improved for this player.</p>
            <form v-if="flow.pending.primaryFallbacks.length" class="tm-choices" @submit.prevent="fallback && manage.commit({ type: 'skill', skill: fallback })">
              <label class="tn-sr" for="tm-fallback">Primary skill instead</label>
              <select id="tm-fallback" v-model="fallback" :disabled="flow.busy">
                <option value="" disabled>Or a Primary skill instead</option>
                <option v-for="s in flow.pending.primaryFallbacks" :key="s" :value="s">{{ s }}</option>
              </select>
              <button type="submit" class="lobby-btn" :disabled="flow.busy || !fallback">Take skill</button>
            </form>
          </template>
          <p class="muted">This roll is saved on the team: closing keeps it for later.</p>
        </template>

        <p v-else-if="flow.step === 'done'" class="tm-result" role="status">{{ flow.result }}</p>

        <p v-if="flow.error" class="lobby-error" role="alert">{{ flow.error }}</p>
        <div class="tn-actions">
          <button type="button" class="lobby-btn" :disabled="flow.busy" @click="manage.close()">{{ flow.step === "done" ? "Done" : "Close" }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
