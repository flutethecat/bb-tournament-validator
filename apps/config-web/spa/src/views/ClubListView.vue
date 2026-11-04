<script setup lang="ts">
// Club directory (/app/clubs, the Clubs section): public. Search by name or home region; one card per club (crest, name,
// home region, member count, the start of its description). Signed-in coaches create a club (they become its admin).
import { computed, inject, onMounted, reactive, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import LeagueDialog from "../components/LeagueDialog.vue";
import { canCreateClub, clubLink, createClubDirectory, initialsOf } from "../clubs/clubs";
import { shown } from "../shared/profanity";
import "../clubs/clubs.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const router = useRouter();
const dir = createClubDirectory({ api: fetcher });
const { state } = dir;
const canCreate = computed(() => canCreateClub(session));
const creating = ref(false);
const form = reactive({ name: "", homeRegion: "", description: "" });
let timer: ReturnType<typeof setTimeout> | undefined;
function search(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void dir.load(), 250);
}
async function create(): Promise<void> {
  const id = await dir.create({ ...form });
  if (id) { creating.value = false; await router.push(clubLink(id)); }
}
onMounted(() => void dir.load());
</script>

<template>
  <div class="hm-page cl-page sf-fit">
    <div class="tl-toolbar cl-toolbar">
      <label class="sf-field cl-search">
        <span class="sf-sr">Search clubs</span>
        <input v-model="state.q" class="sf-input" type="search" placeholder="Search by name or region" data-club-search @input="search" />
      </label>
      <button v-if="canCreate" class="tl-create-btn" type="button" aria-haspopup="dialog" data-create-club @click="creating = true">Create club</button>
    </div>
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded" class="hm-empty" role="status">Loading clubs...</p>
    <section v-else-if="!state.items.length" class="hm-panel" aria-labelledby="cl-none-h">
      <header class="hm-band"><h2 id="cl-none-h">Clubs</h2><span class="hm-cap">0 CLUBS</span></header>
      <p class="hm-empty">{{ state.q.trim() ? "No club matches that search." : "No clubs yet." }}<template v-if="canCreate && !state.q.trim()"> Create the first one.</template></p>
    </section>
    <ul v-else class="cl-cards sf-shrink sf-scroll" aria-label="Clubs">
      <li v-for="c in state.items" :key="c.id">
        <article class="hm-panel cl-card" :aria-labelledby="`cl-${c.id}`">
          <header class="hm-band"><h2>Club</h2><span class="hm-cap">{{ c.memberCount }} {{ c.memberCount === 1 ? "MEMBER" : "MEMBERS" }}</span></header>
          <div class="cl-card-body">
            <img v-if="c.crestUrl" class="cl-crest" :src="c.crestUrl" alt="" loading="lazy" />
            <span v-else class="cl-crest cl-crest-blank" aria-hidden="true">{{ initialsOf(c.name) }}</span>
            <div class="cl-card-text">
              <h3 :id="`cl-${c.id}`" class="cl-name"><RouterLink :to="clubLink(c.id)">{{ shown(c.name) }}</RouterLink></h3>
              <p v-if="c.homeRegion" class="cl-region">{{ shown(c.homeRegion) }}</p>
              <p v-if="c.description" class="cl-desc">{{ shown(c.description) }}</p>
            </div>
          </div>
        </article>
      </li>
    </ul>

    <LeagueDialog v-if="creating" class="cl-dialog" id="cl-create-h" title="Create a club" tag="form" :busy="state.busy" @close="creating = false" @submit="create">
      <p class="hm-small cl-help">You become the club's admin. Coaches ask to join and you approve them.</p>
      <label class="sf-field"><span class="sf-k">Club name</span><input v-model="form.name" class="sf-input" maxlength="60" required data-autofocus /></label>
      <label class="sf-field"><span class="sf-k">Home region</span><input v-model="form.homeRegion" class="sf-input" maxlength="60" placeholder="e.g. North Coast" /></label>
      <label class="sf-field"><span class="sf-k">Description</span><textarea v-model="form.description" class="sf-input" rows="4" maxlength="2000" /></label>
      <p v-if="state.createError" class="sf-error" role="alert">{{ state.createError }}</p>
      <template #foot>
        <button type="button" class="sf-btn" @click="creating = false">Cancel</button>
        <button type="submit" class="sf-btn primary" :disabled="state.busy || form.name.trim().length < 3">Create club</button>
      </template>
    </LeagueDialog>
  </div>
</template>
