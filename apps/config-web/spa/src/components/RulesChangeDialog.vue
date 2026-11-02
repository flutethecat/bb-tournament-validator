<script setup lang="ts">
// The required change message (creation wizards v2, owner grill 2026-11-02 Q2): changing the ruleset or house rules of a
// competition with registered coaches asks the organiser to explain it (10-500 characters). Every registered coach gets
// the message plus the site's list of what changed (shown here exactly as it will be sent), it goes into the competition
// news, and rosters are re-checked at once. After round 1 / season start a second step asks "Are you sure?" (the server
// refuses the change without it).
import { computed, ref } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import { CHANGE_MESSAGE_MAX, CHANGE_MESSAGE_MIN } from "../../../src/competition/rulesChange";
import "../leagues/leagues.css";

const props = defineProps<{ kind: "league" | "tournament"; changes: string[]; coaches: number; afterStart: boolean; busy?: boolean; error?: string }>();
const emit = defineEmits<{ close: []; confirm: [message: string, confirmAfterStart: boolean] }>();

const message = ref("");
const step = ref<"message" | "sure">("message");
const length = computed(() => [...message.value.trim()].length);
const ok = computed(() => length.value >= CHANGE_MESSAGE_MIN && length.value <= CHANGE_MESSAGE_MAX);
const tried = ref(false);
const playLabel = computed(() => (props.kind === "tournament" ? "Round 1 has started" : "The season has started"));

function next(): void {
  tried.value = true;
  if (!ok.value) return;
  if (props.afterStart && step.value === "message") { step.value = "sure"; return; }
  emit("confirm", message.value.trim(), props.afterStart);
}
</script>

<template>
  <LeagueDialog
    id="rc-dialog-h" :title="step === 'sure' ? 'Are you sure?' : 'Explain the rules change'" :cap="coaches ? `${coaches} registered ${coaches === 1 ? 'coach' : 'coaches'}` : ''"
    :busy="busy" tag="form" :role="step === 'sure' ? 'alertdialog' : 'dialog'" describedby="rc-dialog-lede" @close="emit('close')" @submit="next"
  >
    <template v-if="step === 'message'">
      <p id="rc-dialog-lede" class="rc-lede">Every registered coach gets your message and this list in their inbox and as a Discord DM. It also goes into the news, and rosters are checked again straight away.</p>
      <section class="rc-changes" aria-labelledby="rc-changes-h">
        <h3 id="rc-changes-h" class="sf-k">What changes</h3>
        <ul><li v-for="c in changes" :key="c">{{ c }}</li></ul>
      </section>
      <label class="sf-field rc-field">
        <span class="sf-k">Message to coaches</span>
        <textarea v-model="message" data-autofocus rows="4" :maxlength="CHANGE_MESSAGE_MAX + 50" required :aria-invalid="tried && !ok ? 'true' : undefined" aria-describedby="rc-count"></textarea>
        <small id="rc-count" class="rc-count" :data-bad="tried && !ok ? 'true' : undefined">{{ length }} / {{ CHANGE_MESSAGE_MAX }} (at least {{ CHANGE_MESSAGE_MIN }})</small>
      </label>
      <p v-if="tried && !ok" class="sf-error" role="alert">Write {{ CHANGE_MESSAGE_MIN }} to {{ CHANGE_MESSAGE_MAX }} characters.</p>
    </template>
    <template v-else>
      <p id="rc-dialog-lede" class="rc-lede"><strong>{{ playLabel }}.</strong> Changing the rules now affects games in progress. The change is logged in the news for everyone to see.</p>
      <ul class="rc-changes-list"><li v-for="c in changes" :key="c">{{ c }}</li></ul>
    </template>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" @click="step === 'sure' ? (step = 'message') : emit('close')">{{ step === "sure" ? "Back" : "Cancel" }}</button>
      <button type="submit" class="sf-btn" :class="step === 'sure' ? 'danger' : 'primary'" data-rules-change-send :disabled="busy">
        {{ step === "sure" ? "Yes, change the rules" : afterStart ? "Continue" : "Save and notify coaches" }}
      </button>
    </template>
  </LeagueDialog>
</template>

<style>
.rc-lede { margin: 0 0 12px; font: 15px/1.45 var(--font-body); color: var(--ui-text); }
.rc-changes { margin: 0 0 12px; padding: 8px 12px; background: var(--ui-surface-2); border: 2px solid var(--sf-panel-line); border-radius: 2px; }
.rc-changes ul, .rc-changes-list { margin: 4px 0 0; padding-left: 18px; font: 14px/1.45 var(--font-body); }
.rc-field { display: grid; gap: 4px; }
.rc-field textarea { width: 100%; box-sizing: border-box; font: 15px/1.4 var(--font-body); }
.rc-count { color: var(--ui-muted); font: 13px/1.3 var(--font-body); }
.rc-count[data-bad="true"] { color: var(--ui-danger); }
</style>
