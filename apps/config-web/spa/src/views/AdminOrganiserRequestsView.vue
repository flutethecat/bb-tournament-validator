<script setup lang="ts">
// Site admin: organiser requests (/app/admin/organiser-requests; registration spec 2026-11-02 §3). Pending requests with
// Approve / Decline and an optional reason the coach sees; Decided lists the answered ones with who decided and when.
// Approve sets the coach's site level to organiser on the server. Admin sessions only (the server refuses anyone else).
import { computed, inject, onMounted } from "vue";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import {
  createOrganiserQueue, REASON_MAX, RUN_LABEL, safeHref, shortDate, STATUS_LABEL, STATUS_TONE, type QueueView,
} from "../account/organiserRequest";
import "../shared/misc-pages.css";
import "../account/organiser-request.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const queue = createOrganiserQueue({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = queue;
const isAdmin = computed(() => session.admin());
const canWrite = computed(() => writesAllowed(session));
const views: ReadonlyArray<{ id: QueueView; label: string }> = [{ id: "pending", label: "Waiting" }, { id: "closed", label: "Decided" }];

onMounted(() => { if (isAdmin.value) void queue.load("pending"); });
</script>

<template>
  <div class="hm-page or-page or-fit or-fit-queue">
    <section class="hm-panel" aria-labelledby="oq-h">
      <header class="hm-band" data-tone="admin"><h2 id="oq-h">Organiser requests</h2><span v-if="isAdmin && state.loaded" class="hm-cap">{{ state.pending }} waiting</span></header>
      <p v-if="!isAdmin" class="hm-empty" role="status">Admins only. Sign in with an admin account to review organiser requests.</p>
      <div v-else class="or-toolbar">
        <p class="hm-empty">Approving makes the coach a site organiser: they can create leagues and tournaments.</p>
        <div class="sf-tabs small" role="group" aria-label="Show">
          <button v-for="v in views" :key="v.id" class="sf-tab" type="button" :aria-pressed="state.view === v.id ? 'true' : 'false'" @click="queue.load(v.id)">{{ v.label }}</button>
        </div>
      </div>
    </section>
    <template v-if="isAdmin">
      <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
      <p v-else-if="!state.loaded" class="muted" role="status">Loading requests...</p>
      <template v-else>
        <p v-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>
        <section v-if="!state.requests.length" class="hm-panel"><p class="hm-empty">{{ state.view === "pending" ? "No requests waiting." : "No decided requests yet." }}</p></section>
        <ul v-else class="or-queue">
          <li v-for="r in state.requests" :key="r.id" class="or-card" :data-status="r.status">
            <div class="or-card-head">
              <h3>{{ r.coach }}</h3>
              <span class="sf-chip" :data-tone="STATUS_TONE[r.status]">{{ STATUS_LABEL[r.status] }}</span>
            </div>
            <p class="or-card-meta">
              Sent {{ shortDate(r.createdAt) }}<template v-if="r.status !== 'pending' && r.closedAt"> · {{ r.status === "withdrawn" ? "withdrawn" : `${r.status} by ${r.decidedBy ?? "an admin"}` }} {{ shortDate(r.closedAt) }}</template>
            </p>
            <dl class="or-facts">
              <dt>Run</dt><dd>{{ RUN_LABEL[r.run] }}</dd>
              <template v-if="r.competition"><dt>Competition</dt><dd>{{ r.competition }}</dd></template>
              <template v-if="r.region"><dt>Region</dt><dd>{{ r.region }}</dd></template>
              <dt>Note</dt><dd><p class="or-note">{{ r.note || "None" }}</p></dd>
              <template v-if="r.links.length">
                <dt>Links</dt>
                <dd>
                  <ul class="or-linklist">
                    <li v-for="l in r.links" :key="l"><a v-if="safeHref(l)" :href="safeHref(l)" target="_blank" rel="noopener noreferrer nofollow">{{ l }}</a><span v-else>{{ l }}</span></li>
                  </ul>
                </dd>
              </template>
              <template v-if="r.reason"><dt>Reason</dt><dd><p class="or-note">{{ r.reason }}</p></dd></template>
            </dl>
            <form v-if="r.status === 'pending' && canWrite" class="or-decide" @submit.prevent>
              <label class="or-field sf-field">
                <span class="sf-k">Reason (optional, the coach sees it)</span>
                <input v-model="state.reason[r.id]" type="text" :maxlength="REASON_MAX" autocomplete="off" />
              </label>
              <div class="sf-btn-row">
                <button class="sf-btn danger" type="button" :disabled="Boolean(state.busy)" :aria-label="`Decline ${r.coach}`" @click="queue.decide(r, 'decline')">Decline</button>
                <button class="sf-btn primary" type="button" :disabled="Boolean(state.busy)" :aria-label="`Approve ${r.coach}`" @click="queue.decide(r, 'approve')">Approve</button>
              </div>
            </form>
            <p v-if="state.rowError[r.id]" class="sf-error" role="alert">{{ state.rowError[r.id] }}</p>
          </li>
        </ul>
      </template>
    </template>
  </div>
</template>
