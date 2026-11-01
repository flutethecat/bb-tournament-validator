<script setup lang="ts">
// Organiser "Message coach" modal (Participants row menu): a 2000-character message that lands in the coach's
// notifications (and, once the Messages lane exists, their organiser thread).
import { computed, inject, onMounted, onUnmounted, ref } from "vue";
import { API_KEY } from "../app";
import { api } from "../shared/api";
import { MESSAGE_MAX_CHARS, sendCoachMessage } from "../home/notifications";
import "../home/notifications.css";

const props = defineProps<{ tournamentId: string; coachKey: string; teamName?: string }>();
const emit = defineEmits<{ close: [] }>();
const fetcher = inject(API_KEY, api);

const text = ref("");
const busy = ref(false);
const error = ref("");
const sent = ref(false);
const length = computed(() => [...text.value].length);
const over = computed(() => length.value > MESSAGE_MAX_CHARS);

async function send() {
  if (busy.value) return;
  busy.value = true;
  error.value = await sendCoachMessage(fetcher, props.tournamentId, props.coachKey, text.value);
  busy.value = false;
  if (!error.value) { sent.value = true; text.value = ""; }
}

const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") emit("close"); };
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="tn-modal-backdrop" @click.self="emit('close')">
    <div class="tn-modal tn-panel nf-msg-modal" role="dialog" aria-modal="true" aria-labelledby="nf-msg-h">
      <h3 id="nf-msg-h" class="tn-band">
        Message {{ coachKey }}
        <button type="button" class="tn-modal-x" aria-label="Close" @click="emit('close')">×</button>
      </h3>
      <form class="tn-panel-body nf-msg-form" @submit.prevent="send">
        <p v-if="teamName" class="muted">{{ teamName }}. The message shows in the coach's notifications.</p>
        <p v-else class="muted">The message shows in the coach's notifications.</p>
        <label class="tn-sr" for="nf-msg-text">Message</label>
        <textarea id="nf-msg-text" v-model="text" :maxlength="MESSAGE_MAX_CHARS" rows="6" placeholder="Write your message" :disabled="busy"></textarea>
        <span class="nf-count" :data-over="over ? 'true' : undefined">{{ length }} / {{ MESSAGE_MAX_CHARS }}</span>
        <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
        <p v-if="sent" class="nf-sent" role="status">Sent.</p>
        <div class="tn-actions">
          <button type="submit" class="sf-btn primary" :disabled="busy || !text.trim() || over">{{ busy ? "Sending..." : "Send" }}</button>
          <button type="button" class="sf-btn" @click="emit('close')">Close</button>
        </div>
      </form>
    </div>
  </div>
</template>
