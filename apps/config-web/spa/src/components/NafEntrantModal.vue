<script setup lang="ts">
// Organiser "NAF details" modal (Participants row menu): a tournament organiser records the NAF name and number of a
// coach entered in their tournament (owner ruling 10-31). They go on the coach's profile (the same NAF details a coach
// links in Account), so the Participants row shows them after the save. The server answers only the NAF allow-list and
// refuses a coach who is not an active entrant of a tournament the caller runs.
import { inject, onMounted, onUnmounted, ref } from "vue";
import { API_KEY } from "../app";
import { api } from "../shared/api";

const props = defineProps<{ coachKey: string; teamName?: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const fetcher = inject(API_KEY, api);

const nafName = ref("");
const nafId = ref("");
const busy = ref(false);
const error = ref("");
const saved = ref("");

interface NafReply { coach?: { identities?: { nafName?: string; nafId?: string } } }

async function save() {
  if (busy.value) return;
  const body: Record<string, string> = { ffbCoachId: props.coachKey };
  if (nafName.value.trim()) body.nafName = nafName.value.trim();
  if (nafId.value.trim()) body.nafId = nafId.value.trim();
  if (Object.keys(body).length < 2) { error.value = "Enter a NAF name or number."; return; }
  busy.value = true; error.value = ""; saved.value = "";
  try {
    const reply = await fetcher<NafReply>("/api/admin/identities/naf", { method: "POST", body });
    const ids = reply.coach?.identities ?? {};
    saved.value = `Saved: ${ids.nafName || "no NAF name"}${ids.nafId ? ` #${ids.nafId}` : ""}.`;
    emit("saved");
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Can't save the NAF details.";
  } finally {
    busy.value = false;
  }
}

const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") emit("close"); };
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="tn-modal-backdrop" @click.self="emit('close')">
    <div class="tn-modal tn-panel" role="dialog" aria-modal="true" aria-labelledby="naf-ent-h">
      <h3 id="naf-ent-h" class="tn-band">
        NAF details for {{ coachKey }}
        <button type="button" class="tn-modal-x" aria-label="Close" @click="emit('close')">×</button>
      </h3>
      <form class="tn-panel-body" @submit.prevent="save">
        <p class="muted"><template v-if="teamName">{{ teamName }}. </template>Record the coach's NAF name and number on their profile. Fields left blank are not changed.</p>
        <label for="naf-ent-name">NAF name</label>
        <input id="naf-ent-name" v-model="nafName" type="text" maxlength="80" autocomplete="off" :disabled="busy" />
        <label for="naf-ent-id">NAF number</label>
        <input id="naf-ent-id" v-model="nafId" type="text" inputmode="numeric" maxlength="20" autocomplete="off" :disabled="busy" />
        <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
        <p v-if="saved" role="status">{{ saved }}</p>
        <div class="tn-actions">
          <button type="submit" class="lobby-btn primary" :disabled="busy">{{ busy ? "Saving..." : "Save" }}</button>
          <button type="button" class="lobby-btn" @click="emit('close')">Close</button>
        </div>
      </form>
    </div>
  </div>
</template>
