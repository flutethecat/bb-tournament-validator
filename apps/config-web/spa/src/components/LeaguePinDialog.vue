<script setup lang="ts">
// Pin to the Hall of Fame (organisers + admins): a season champion or an award (named by `target`), or a free-text
// record ("Most TDs in a season"), each with an optional note.
import { computed, inject, reactive, ref } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import { AWARD_NOTE_MAX, LEAGUE_HONOURS_KEY, RECORD_TEXT_MAX, type PinInput } from "../leagues/honours";
import "../leagues/honours.css";

const props = defineProps<{ kind: "champion" | "award" | "record"; seasonId?: string; awardId?: string; target?: string }>();
const emit = defineEmits<{ close: [] }>();
const honours = inject(LEAGUE_HONOURS_KEY)!;
const { state } = honours;
const draft = reactive({ text: "", note: "" });
const tried = ref(false);
const busy = computed(() => state.busy === "pin");
const error = computed(() => (tried.value && !busy.value ? state.writeError : ""));
const title = computed(() => (props.kind === "record" ? "Add a record" : "Pin to the Hall of Fame"));

async function submit(): Promise<void> {
  tried.value = true;
  if (busy.value || (props.kind === "record" && !draft.text.trim())) return;
  const note = draft.note.trim();
  const input: PinInput = props.kind === "record" ? { kind: "record", text: draft.text.trim(), note }
    : props.kind === "champion" ? { kind: "champion", seasonId: props.seasonId ?? "", note } : { kind: "award", awardId: props.awardId ?? "", note };
  if (await honours.pin(input)) emit("close");
}
</script>

<template>
  <LeagueDialog id="hof-pin-h" :title="title" tag="form" :busy="busy" @close="emit('close')" @submit="submit">
    <div class="aw-form">
      <p v-if="target" class="aw-who">{{ target }}</p>
      <label v-if="kind === 'record'" class="sf-field"><span class="sf-k">Record</span><input v-model="draft.text" type="text" :maxlength="RECORD_TEXT_MAX" autocomplete="off" placeholder="Most TDs in a season: 31 (Season 4)" data-autofocus /></label>
      <label class="sf-field"><span class="sf-k">Note (optional)</span><textarea v-model="draft.note" rows="3" :maxlength="AWARD_NOTE_MAX" :data-autofocus="kind === 'record' ? undefined : true" /></label>
      <p v-if="tried && kind === 'record' && !draft.text.trim()" class="sf-error" role="alert">Enter the record.</p>
      <p v-else-if="error" class="sf-error" role="alert">{{ error }}</p>
    </div>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <button type="submit" class="sf-btn primary" :disabled="busy">{{ busy ? "Saving..." : kind === "record" ? "Add record" : "Pin" }}</button>
    </template>
  </LeagueDialog>
</template>
