<script setup lang="ts">
// Site admin: tournaments (/app/admin/tournaments). Every tournament in every state, its owner and organisers, with
// Set owner / Add organiser / Remove per row and a link to its Manage tab. Admin sessions only (the server refuses
// anyone else anyway).
import { computed, inject, onMounted, reactive, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { ADMIN_TOURNAMENTS_KEY, createAdminTournaments } from "../tournaments/admin";
import { startDate } from "../tournaments/detail";
import { FORMAT_LABEL, STATUS_LABEL } from "../tournaments/list";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const admin = inject(ADMIN_TOURNAMENTS_KEY, null) ?? createAdminTournaments({ api: fetcher, onSignedOut: () => void session.load(true) });
const { state } = admin;
const isAdmin = computed(() => session.signedIn() && session.state.info?.admin === true);
const query = ref(state.q);
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
  <section class="lobby-card tn-page">
    <div class="tn-head">
      <h2>Tournaments admin</h2>
      <form v-if="isAdmin" class="tn-search" role="search" @submit.prevent="admin.search(query)">
        <label class="tn-sr" for="tn-admin-q">Search tournaments</label>
        <input id="tn-admin-q" v-model="query" type="search" placeholder="Search by name" />
        <button class="lobby-btn" type="submit">Search</button>
      </form>
    </div>
    <p v-if="!isAdmin" class="muted" role="status">Admins only. Sign in with an admin account to manage tournament owners and organisers.</p>
    <template v-else>
      <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
      <p v-else-if="!state.loaded" class="muted" role="status">Loading tournaments...</p>
      <p v-else-if="!state.items.length" class="muted">No tournaments.</p>
      <ul v-else class="tn-admin-list">
        <li v-for="t in state.items" :key="t.id" class="tn-panel">
          <h3 class="tn-band tn-admin-name">
            <RouterLink :to="{ name: 'tournament-detail', params: { id: t.id }, query: { tab: 'manage' } }">{{ t.name }}</RouterLink>
            <span class="tn-chip" :data-status="t.status">{{ STATUS_LABEL[t.status] ?? t.status }}</span>
          </h3>
          <div class="tn-panel-body">
            <p class="muted tn-card-meta">
              {{ FORMAT_LABEL[t.format] ?? t.format }} · {{ t.rulesetPackName || t.packageName || "No ruleset" }}
              {{ t.startsAt ? ` · starts ${startDate(t.startsAt)}` : "" }} · {{ t.entrantCount ?? 0 }} entrants
            </p>
            <p class="tn-role-line"><span class="tn-fact-k">Owner</span> <strong>{{ t.ownerCoachId || "None (admins only)" }}</strong></p>
            <ul v-if="t.organizerCoachIds?.length" class="tn-role-list" :aria-label="`Organisers of ${t.name}`">
              <li v-for="c in t.organizerCoachIds" :key="c">
                <span>{{ c }}</span>
                <button class="lobby-btn small" type="button" :disabled="Boolean(state.busy)" :aria-label="`Remove organiser ${c}`" @click="admin.removeOrganizer(t.id, c)">Remove</button>
              </li>
            </ul>
            <div class="tn-admin-forms">
              <form class="tn-inline-form" @submit.prevent="setOwner(t.id)">
                <label :for="`own-${t.id}`">Owner</label>
                <input :id="`own-${t.id}`" v-model="ownerInput[t.id]" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" />
                <button class="lobby-btn" type="submit" :disabled="!(ownerInput[t.id] ?? '').trim() || Boolean(state.busy)">Set owner</button>
              </form>
              <form class="tn-inline-form" @submit.prevent="addOrganizer(t.id)">
                <label :for="`org-${t.id}`">Organiser</label>
                <input :id="`org-${t.id}`" v-model="orgInput[t.id]" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" />
                <button class="lobby-btn" type="submit" :disabled="!(orgInput[t.id] ?? '').trim() || Boolean(state.busy)">Add organiser</button>
              </form>
            </div>
            <p v-if="state.rowError[t.id]" class="lobby-error" role="alert">{{ state.rowError[t.id] }}</p>
            <p v-else-if="state.rowNotice[t.id]" class="tn-notice" role="status">{{ state.rowNotice[t.id] }}</p>
          </div>
        </li>
      </ul>
      <div v-if="state.page > 1 || state.hasMore" class="tn-pager">
        <button class="lobby-btn" type="button" :disabled="state.page <= 1" @click="admin.goto(state.page - 1)">Previous</button>
        <span class="muted">Page {{ state.page }}</span>
        <button class="lobby-btn" type="button" :disabled="!state.hasMore" @click="admin.goto(state.page + 1)">Next</button>
      </div>
    </template>
  </section>
</template>
