<script setup lang="ts">
// League page, Overview (organisers and site admins, newest season only): "Message members". The message goes to every
// recipient's notifications, and by email (sent by the site) to members who opted in with a confirmed address. The
// organiser never sees an address, and counts only for large all-members messages (src/mail/leagueMessages.ts).
import { computed, inject, onMounted, reactive, ref } from "vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { ApiError } from "../shared/api";
import { day } from "../leagues/league";
import {
  LEAGUE_BODY_MAX, LEAGUE_SUBJECT_MAX, loadLeagueMessages, logCounts, messageCoaches, messageTeams, newRequestId, sendLeagueMessage, sentSummary,
  type LeagueMessageLog, type MessageScope,
} from "../leagues/messages";
import type { SeasonRecord } from "../leagues/types";

const props = defineProps<{ leagueId: string; season: SeasonRecord }>();
const api = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const me = computed(() => session.coach());

const teams = computed(() => messageTeams(props.season, me.value));
const coaches = computed(() => messageCoaches(props.season, me.value));
const draft = reactive<{ scope: MessageScope; teamId: string; coach: string; subject: string; body: string }>({ scope: "all", teamId: "", coach: "", subject: "", body: "" });
let requestId = newRequestId();
const busy = ref(false);
const error = ref("");
const notice = ref("");
const emailEnabled = ref<boolean | null>(null);
const recent = ref<LeagueMessageLog[]>([]);

const bodyLength = computed(() => [...draft.body].length);
const ready = computed(() => draft.subject.trim() && draft.body.trim() && [...draft.subject].length <= LEAGUE_SUBJECT_MAX && bodyLength.value <= LEAGUE_BODY_MAX
  && (draft.scope !== "team" || draft.teamId) && (draft.scope !== "coach" || draft.coach));

async function refresh(): Promise<void> {
  try {
    const view = await loadLeagueMessages(api, props.leagueId);
    emailEnabled.value = view.emailEnabled;
    recent.value = view.recent;
  } catch { /* the composer still works */ }
}

async function send(): Promise<void> {
  if (!ready.value || busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const r = await sendLeagueMessage(api, props.leagueId, {
      scope: draft.scope, ...(draft.scope === "team" ? { teamId: draft.teamId } : {}), ...(draft.scope === "coach" ? { coach: draft.coach } : {}),
      subject: draft.subject.trim(), body: draft.body.trim(), requestId,
    });
    notice.value = sentSummary(r);
    Object.assign(draft, { subject: "", body: "" });
    requestId = newRequestId();
    void refresh();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : "Could not send the message.";
  } finally {
    busy.value = false;
  }
}

const scopeLabel = (s: MessageScope): string => (s === "all" ? "All members" : s === "team" ? "One team" : "One coach");
onMounted(refresh);
</script>

<template>
  <section class="hm-panel lg-message" aria-labelledby="lg-message-h">
    <header class="hm-band"><h2 id="lg-message-h">Message members</h2><span class="hm-cap">{{ season.name }}</span></header>
    <form class="ls-form lg-news-form" @submit.prevent="send">
      <fieldset class="ls-field lg-message-scope">
        <span>To</span>
        <div class="ls-actions" role="radiogroup" aria-label="Recipients">
          <label v-for="s in (['all', 'team', 'coach'] as const)" :key="s" class="ls-check"><input v-model="draft.scope" type="radio" name="lg-message-scope" :value="s" /> {{ scopeLabel(s) }}</label>
        </div>
      </fieldset>
      <label v-if="draft.scope === 'team'" class="ls-field"><span>Team</span>
        <select v-model="draft.teamId"><option value="" disabled>Pick a team</option><option v-for="t in teams" :key="t.id" :value="t.id">{{ t.label }}</option></select>
      </label>
      <label v-if="draft.scope === 'coach'" class="ls-field"><span>Coach</span>
        <select v-model="draft.coach"><option value="" disabled>Pick a coach</option><option v-for="c in coaches" :key="c" :value="c">{{ c }}</option></select>
      </label>
      <label class="ls-field"><span>Subject</span><input v-model="draft.subject" type="text" :maxlength="LEAGUE_SUBJECT_MAX" autocomplete="off" /></label>
      <label class="ls-field"><span>Message</span><textarea v-model="draft.body" rows="6" :maxlength="LEAGUE_BODY_MAX" /></label>
      <div class="ls-actions">
        <button class="lobby-btn primary" type="submit" :disabled="!ready || busy">{{ busy ? "Sending..." : "Send message" }}</button>
        <span class="hm-small hm-empty">{{ bodyLength }} / {{ LEAGUE_BODY_MAX }}</span>
      </div>
      <p class="hm-small hm-empty">
        Plain text. Every recipient sees it in their notifications.
        <template v-if="emailEnabled !== false">Members who opted in to league emails with a confirmed address also get it by email from Super FUMBBL; you never see their address.</template>
        <template v-else>Email is not set up on this site yet.</template>
      </p>
    </form>
    <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="hm-notice" role="status">{{ notice }}</p>
    <details v-if="recent.length" class="lg-message-recent">
      <summary>Recent messages</summary>
      <ul>
        <li v-for="r in recent" :key="r.id" class="hm-small">{{ day(r.at) }} · {{ r.sender }} · {{ scopeLabel(r.scope) }} · {{ logCounts(r) }}</li>
      </ul>
    </details>
  </section>
</template>
