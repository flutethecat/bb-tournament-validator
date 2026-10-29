<script setup lang="ts">
// Account page (/app/account, owner 10-30), in the coach page's language: title + LED coach name, two columns (fluid /
// 380 px at >= 1280). Main: Identity (GET/PATCH /api/me/profile), Schedule (the availability editor, GET/PUT
// /api/me/scheduling; /account#schedule lands here), Calendar (deadlines and fixtures from the nav tree's
// GET /api/me/deadlines, availability shading, proposed times once that lane lands). Side: Session, Teams, test sign-in.
import { computed, inject, onMounted, onServerPrefetch, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import TestSignInCard from "../components/TestSignInCard.vue";
import HomeSchedule from "../components/HomeSchedule.vue";
import AccountIdentity from "../components/AccountIdentity.vue";
import AccountCalendar from "../components/AccountCalendar.vue";
import { createProfileEditor } from "../account/profile";
import { loadProposals, type ProposedTime } from "../account/calendar";
import { createScheduleEditor } from "../home/schedule";
import { browserTimeZone } from "../home/deadlines";
import { COACH_TREE_KEY } from "../home/tree";
import { useNow } from "../home/shell";

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const tree = inject(COACH_TREE_KEY, null);
const now = useNow();

const profile = createProfileEditor({ api: fetcher });
// One schedule editor for the Schedule panel and the calendar's availability shading (a saved week also refreshes the tree).
const schedule = createScheduleEditor({ api: fetcher, onSaved: () => tree?.invalidate() });
const proposals = ref<ProposedTime[]>([]);

const zone = computed(() => tree?.state.timezone || schedule.state.timezone || browserTimeZone());
const deadlines = computed(() => tree?.state.deadlines ?? []);
const discord = computed(() => profile.state.view?.discord);

const signingOut = ref(false);
const signOutError = ref("");

async function signOut(): Promise<void> {
  signingOut.value = true;
  signOutError.value = "";
  try {
    await session.signOut();
    // The server answered OK but the session is still live (should not happen): say so rather than look done.
    if (session.signedIn()) signOutError.value = "Sign out did not complete. Try again.";
  } catch (err) {
    signOutError.value = `Sign out failed: ${(err as Error).message}`;
  } finally {
    signingOut.value = false;
  }
}

onMounted(() => { void loadProposals().then((p) => { proposals.value = p; }); });
// Server rendering: the week loads before the Schedule panel and the calendar both render from it.
onServerPrefetch(() => (session.signedIn() ? schedule.load() : undefined));
</script>

<template>
  <div class="hm-page ac-page">
    <h1 class="hm-title">Account <span class="hm-led">{{ session.coach() }}</span></h1>
    <div class="hm-grid">
      <div class="hm-col hm-col-main">
        <section v-if="session.signedIn()" id="identity" class="hm-panel" aria-labelledby="ac-identity-h">
          <header class="hm-band"><h2 id="ac-identity-h">Identity</h2><span class="hm-cap">What coaches see</span></header>
          <AccountIdentity :editor="profile" :coach="session.coach()" />
        </section>

        <!-- Owner 10-30: the weekly availability editor moved here from the coach page. -->
        <section v-if="session.signedIn()" id="schedule" class="hm-panel" aria-labelledby="hm-schedule-h">
          <header class="hm-band"><h2 id="hm-schedule-h">Schedule</h2><span class="hm-cap">My availability</span></header>
          <HomeSchedule :editor="schedule" />
        </section>

        <section v-if="session.signedIn()" id="calendar" class="hm-panel" aria-labelledby="ac-calendar-h">
          <header class="hm-band"><h2 id="ac-calendar-h">Calendar</h2><RouterLink class="hm-cap" to="/home#deadlines">Deadlines</RouterLink></header>
          <AccountCalendar :deadlines="deadlines" :proposals="proposals" :blocks="schedule.state.blocks" :timezone="zone" :now="now" :loading="tree?.state.loading" />
        </section>
      </div>

      <div class="hm-col hm-col-side">
        <section id="session" class="hm-panel" aria-labelledby="ac-session-h">
          <header class="hm-band"><h2 id="ac-session-h">Session</h2><span class="hm-cap">{{ session.signedIn() ? "Signed in" : "Signed out" }}</span></header>
          <dl class="ac-facts">
            <dt>Coach name</dt>
            <dd>{{ session.coach() }}</dd>
            <dt>Discord</dt>
            <dd>{{ discord?.username || (discord?.linked === false ? "Not linked" : "Signed in with Discord") }}</dd>
          </dl>
          <p class="hm-actions">
            <button class="lobby-btn" type="button" :disabled="signingOut" @click="signOut">Sign out</button>
          </p>
          <p v-if="signOutError" class="lobby-error hm-small" role="alert">{{ signOutError }}</p>
        </section>

        <section id="teams" class="hm-panel" aria-labelledby="ac-teams-h">
          <header class="hm-band"><h2 id="ac-teams-h">Teams</h2></header>
          <p class="hm-links"><RouterLink to="/my-teams">My teams</RouterLink> · <RouterLink to="/my-teams#avatars">Team avatars</RouterLink></p>
        </section>

        <TestSignInCard />
      </div>
    </div>
  </div>
</template>
