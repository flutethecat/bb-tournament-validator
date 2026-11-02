<script setup lang="ts">
// Become an organiser (/app/organiser/request; registration spec 2026-11-02 §3, Q1): a signed-in coach asks the site
// admins for organiser level, sees the request while it waits (and can withdraw it), and sees the answer. Site organisers
// and admins create leagues and tournaments; everyone else asks here. Server: src/organiserRequests.ts.
import { computed, inject, nextTick, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import {
  COMPETITION_MAX, createOrganiserRequest, LINKS_MAX, NOTE_MAX, REGION_MAX, RUN_LABEL, RUN_OPTIONS, safeHref, shortDate, STATUS_LABEL, STATUS_TONE,
  type OrganiserRunKind,
} from "../account/organiserRequest";
import "../shared/misc-pages.css";
import "../account/organiser-request.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const page = createOrganiserRequest({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = page;
const canWrite = computed(() => writesAllowed(session));
const isOrganiser = computed(() => state.organizer || session.state.info?.organizer === true);
const pending = computed(() => state.request?.status === "pending" ? state.request : null);
const declined = computed(() => state.request?.status === "declined" ? state.request : null);
const noteOver = computed(() => state.form.note.length > NOTE_MAX);
const kinds = ref<HTMLElement | null>(null);

onMounted(() => { if (session.signedIn()) void page.load(); });

async function send(): Promise<void> {
  if (await page.submit()) void session.load(true);
}
async function withdraw(): Promise<void> {
  await page.withdraw();
}
function pick(id: OrganiserRunKind): void { state.form.run = id; }
function onKindKey(e: KeyboardEvent): void {
  const i = RUN_OPTIONS.findIndex((o) => o.id === state.form.run);
  const last = RUN_OPTIONS.length - 1;
  const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i >= last ? 0 : i + 1)
    : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i <= 0 ? last : i - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
  if (to < 0) return;
  e.preventDefault();
  pick(RUN_OPTIONS[to]!.id);
  void nextTick(() => kinds.value?.querySelectorAll<HTMLElement>("[role=radio]")[to]?.focus());
}
</script>

<template>
  <div class="hm-page or-page or-fit">
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded" class="muted" role="status">Loading...</p>
    <div v-else class="or-grid">
      <div class="hm-col">
        <!-- Already an organiser -->
        <section v-if="isOrganiser" class="hm-panel" aria-labelledby="or-done-h" data-testid="organiser-done">
          <header class="hm-band"><h2 id="or-done-h">You're an organiser</h2><span class="sf-chip" data-tone="ok">Organiser</span></header>
          <p class="or-lead">You can create leagues and tournaments.</p>
          <p v-if="state.request?.status === 'approved' && state.request.reason" class="or-note"><span class="sf-k">Admin note</span><br />{{ state.request.reason }}</p>
          <div class="sf-btn-row or-actions">
            <RouterLink class="sf-btn primary" to="/tournaments">Tournaments</RouterLink>
            <RouterLink class="sf-btn" to="/leagues">Leagues</RouterLink>
          </div>
        </section>

        <!-- A request is waiting -->
        <section v-else-if="pending" class="hm-panel or-pane" aria-labelledby="or-wait-h" data-testid="organiser-pending">
          <header class="hm-band"><h2 id="or-wait-h">Your request</h2><span class="sf-chip" :data-tone="STATUS_TONE.pending">{{ STATUS_LABEL.pending }}</span></header>
          <div class="or-pane-body">
          <p class="or-lead">Sent {{ shortDate(pending.createdAt) }}. An admin will approve or decline it, and you'll get a notification either way.</p>
          <dl class="or-facts">
            <dt>Run</dt><dd>{{ RUN_LABEL[pending.run] }}</dd>
            <template v-if="pending.competition"><dt>Competition</dt><dd>{{ pending.competition }}</dd></template>
            <template v-if="pending.region"><dt>Region</dt><dd>{{ pending.region }}</dd></template>
            <dt>Note</dt><dd><p class="or-note">{{ pending.note }}</p></dd>
            <template v-if="pending.links.length">
              <dt>Links</dt>
              <dd>
                <ul class="or-linklist">
                  <li v-for="l in pending.links" :key="l"><a v-if="safeHref(l)" :href="safeHref(l)" target="_blank" rel="noopener noreferrer nofollow">{{ l }}</a><span v-else>{{ l }}</span></li>
                </ul>
              </dd>
            </template>
          </dl>
          </div>
          <div v-if="canWrite" class="sf-btn-row or-actions">
            <button class="sf-btn" type="button" :disabled="state.busy" @click="withdraw">Withdraw request</button>
          </div>
          <p v-if="state.formError" class="sf-error" role="alert">{{ state.formError }}</p>
          <p v-else-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>
        </section>

        <!-- The form -->
        <section v-else class="hm-panel or-pane" aria-labelledby="or-form-h" data-testid="organiser-form">
          <header class="hm-band"><h2 id="or-form-h">Become an organiser</h2><span class="hm-cap">Request</span></header>
          <form class="or-form-pane" novalidate @submit.prevent="send">
          <div class="or-pane-body or-form">
          <p class="or-lead">Organisers create and run leagues and tournaments on the site. Tell the admins what you'd like to run.</p>
          <p v-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>
          <div v-if="declined" class="or-note" role="status" data-testid="organiser-declined">
            <span class="sf-chip" :data-tone="STATUS_TONE.declined">{{ STATUS_LABEL.declined }}</span>
            Your request from {{ shortDate(declined.createdAt) }} was declined.{{ declined.reason ? ` Reason: ${declined.reason}` : "" }} You can send a new one.
          </div>
            <fieldset>
              <legend class="sf-k">What do you want to run?</legend>
              <div ref="kinds" class="or-kinds" role="radiogroup" aria-label="What do you want to run?" @keydown="onKindKey">
                <button
                  v-for="(o, i) in RUN_OPTIONS" :key="o.id" type="button" role="radio" class="or-kind"
                  :aria-checked="state.form.run === o.id ? 'true' : 'false'"
                  :tabindex="state.form.run === o.id || (!state.form.run && i === 0) ? 0 : -1"
                  @click="pick(o.id)"
                >
                  <img :src="o.icon" alt="" width="40" height="40" />
                  <strong>{{ o.label }}</strong>
                  <small>{{ o.line }}</small>
                </button>
              </div>
            </fieldset>
            <div class="or-two">
              <label class="or-field sf-field">
                <span class="sf-k">Competition name (optional)</span>
                <input v-model="state.form.competition" type="text" :maxlength="COMPETITION_MAX" autocomplete="off" placeholder="Northern Lights League" />
              </label>
              <label class="or-field sf-field">
                <span class="sf-k">Region (optional)</span>
                <input v-model="state.form.region" type="text" :maxlength="REGION_MAX" autocomplete="off" placeholder="Online, Europe" />
              </label>
            </div>
            <label class="or-field sf-field">
              <span class="sf-k">Note to the admins</span>
              <textarea v-model="state.form.note" rows="5" aria-describedby="or-note-help or-note-count" placeholder="Who will play, how often, and anything else that helps." />
              <span id="or-note-count" class="or-count" :data-over="noteOver ? 'true' : 'false'" aria-live="polite">{{ state.form.note.length }} / {{ NOTE_MAX }}</span>
              <p id="or-note-help" class="or-help">Only the site admins read this.</p>
            </label>
            <fieldset class="or-links">
              <legend class="sf-k">Links (optional, up to {{ LINKS_MAX }})</legend>
              <input
                v-for="(_, i) in state.form.links" :key="i" v-model="state.form.links[i]" class="sf-input" type="url" inputmode="url" autocomplete="off"
                :aria-label="`Link ${i + 1}`" placeholder="https://"
              />
              <p class="or-help">A Discord server, a club page, or an earlier competition.</p>
            </fieldset>
          </div>
            <p v-if="state.formError" class="sf-error or-foot-error" role="alert">{{ state.formError }}</p>
            <div class="sf-btn-row or-foot">
              <button class="sf-btn primary" type="submit" :disabled="state.busy || !canWrite || noteOver">Send request</button>
              <span v-if="!canWrite" class="or-help">Test sign-in sessions can't send requests.</span>
            </div>
          </form>
        </section>
      </div>

      <aside class="hm-col">
        <section class="hm-panel" aria-labelledby="or-how-h">
          <header class="hm-band" data-tone="info"><h2 id="or-how-h">How it works</h2></header>
          <ol class="or-steps">
            <li>Send one request. You can withdraw it while it waits.</li>
            <li>A site admin approves or declines it. You get a notification, and a Discord message unless you turned those off.</li>
            <li>Once approved, create leagues and tournaments from their lists.</li>
          </ol>
          <p class="or-help">Helping run someone else's competition? Its owner can add you as a co-organiser; you don't need to ask here.</p>
        </section>
      </aside>
    </div>
  </div>
</template>
