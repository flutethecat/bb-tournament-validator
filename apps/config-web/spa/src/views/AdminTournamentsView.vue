<script setup lang="ts">
// Site admin: tournaments (/app/admin/tournaments). Every tournament in every state, its owner and organisers, with
// Set owner / Add organiser / Remove per row and a link to its Manage tab. Admin sessions only (the server refuses
// anyone else anyway).
import { computed, inject, onMounted, reactive, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import { ADMIN_TOURNAMENTS_KEY, createAdminTournaments } from "../tournaments/admin";
import { startDate } from "../tournaments/detail";
import { FORMAT_LABEL, STATUS_LABEL, STATUS_TONE } from "../tournaments/list";
import "../shared/misc-pages.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const admin = inject(ADMIN_TOURNAMENTS_KEY, null) ?? createAdminTournaments({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = admin;
const isAdmin = computed(() => session.signedIn() && session.state.info?.admin === true);
const query = ref(state.q);
const canWrite = computed(() => writesAllowed(session));
const ownerInput = reactive<Record<string, string>>({});
const orgInput = reactive<Record<string, string>>({});

onMounted(() => { if (isAdmin.value && !state.loaded) void admin.load(); });

async function setOwner(id: string) {
  const coach = (ownerInput[id] ?? "").trim();
  if (coach && await admin.setOwner(id, coach)) ownerInput[id] = "";
}
async function addOrganizer(id: string) {
  const coach = (orgInput[id] ?? "").trim();
  if (coach && await admin.addOrganizer(id, coach)) orgInput[id] = "";
}
</script>

<template>
  <div class="hm-page sf-fit">
    <section class="hm-panel" aria-labelledby="ad-h">
      <header class="hm-band"><h2 id="ad-h">All tournaments</h2><span v-if="isAdmin && state.loaded" class="hm-cap">Page {{ state.page }}</span></header>
      <form v-if="isAdmin" class="ad-search" role="search" @submit.prevent="admin.search(query)">
        <label class="sf-sr" for="tn-admin-q">Search tournaments</label>
        <input id="tn-admin-q" v-model="query" type="search" placeholder="Search by name" />
        <button class="sf-btn" type="submit">Search</button>
      </form>
      <p v-if="!isAdmin" class="hm-empty" role="status">Admins only. Sign in with an admin account to manage tournament owners and organisers.</p>
    </section>
    <template v-if="isAdmin">
      <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
      <p v-else-if="!state.loaded" class="muted" role="status">Loading tournaments...</p>
      <section v-else-if="!state.items.length" class="hm-panel"><p class="hm-empty">No tournaments.</p></section>
      <ul v-else class="ad-list sf-shrink sf-scroll sf-col">
        <li v-for="t in state.items" :key="t.id" class="ad-card">
          <div class="ad-head">
            <h3 class="ad-name">
              <RouterLink :to="{ name: 'tournament-manage', params: { id: t.id } }">{{ t.name }}</RouterLink>
            </h3>
            <span class="sf-chip" :data-tone="STATUS_TONE[t.status] ?? 'muted'">{{ STATUS_LABEL[t.status] ?? t.status }}</span>
          </div>
          <p class="muted ad-meta">
            {{ FORMAT_LABEL[t.format] ?? t.format }} · {{ t.rulesetPackName || t.packageName || "No ruleset" }}
            {{ t.startsAt ? ` · starts ${startDate(t.startsAt)}` : "" }} · {{ t.entrantCount ?? 0 }} entrants
          </p>
          <dl class="ad-facts">
            <dt>Owner</dt>
            <dd><strong>{{ t.ownerCoachId || "None (admins only)" }}</strong></dd>
            <template v-if="t.organizerCoachIds?.length">
              <dt>Organisers</dt>
              <dd>
                <ul class="ad-orgs" :aria-label="`Organisers of ${t.name}`">
                  <li v-for="c in t.organizerCoachIds" :key="c">
                    <span>{{ c }}</span>
                    <button v-if="canWrite" class="sf-btn small" type="button" :disabled="Boolean(state.busy)" :aria-label="`Remove organiser ${c}`" @click="admin.removeOrganizer(t.id, c)">Remove</button>
                  </li>
                </ul>
              </dd>
            </template>
          </dl>
          <div v-if="canWrite" class="ad-forms">
            <form class="ad-form" @submit.prevent="setOwner(t.id)">
              <label class="sf-k" :for="`own-${t.id}`">Owner</label>
              <input :id="`own-${t.id}`" v-model="ownerInput[t.id]" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" />
              <button class="sf-btn" type="submit" :disabled="!(ownerInput[t.id] ?? '').trim() || Boolean(state.busy)">Set owner</button>
            </form>
            <form class="ad-form" @submit.prevent="addOrganizer(t.id)">
              <label class="sf-k" :for="`org-${t.id}`">Organiser</label>
              <input :id="`org-${t.id}`" v-model="orgInput[t.id]" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" />
              <button class="sf-btn" type="submit" :disabled="!(orgInput[t.id] ?? '').trim() || Boolean(state.busy)">Add organiser</button>
            </form>
          </div>
          <p v-if="state.rowError[t.id]" class="sf-error" role="alert">{{ state.rowError[t.id] }}</p>
          <p v-else-if="state.rowNotice[t.id]" class="ad-notice" role="status">{{ state.rowNotice[t.id] }}</p>
        </li>
      </ul>
      <div v-if="state.page > 1 || state.hasMore" class="ad-pager">
        <button class="sf-btn" type="button" :disabled="state.page <= 1" @click="admin.goto(state.page - 1)">Previous</button>
        <span class="hm-cap">Page {{ state.page }}</span>
        <button class="sf-btn" type="button" :disabled="!state.hasMore" @click="admin.goto(state.page + 1)">Next</button>
      </div>
    </template>
  </div>
</template>
