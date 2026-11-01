<script setup lang="ts">
// Account page (/app/account, owner 10-30), in the coach page's language: title + LED coach name, two columns (fluid /
// 380 px at >= 1280). Main: Identity (GET/PATCH /api/me/profile), Calendar (deadlines and fixtures from the nav tree's
// GET /api/me/deadlines, availability shading, proposed times once that lane lands) with a "Set schedule" button in its
// band: the availability editor (GET/PUT /api/me/scheduling) opens in a dialog, and /account#schedule opens it on load.
// Sharing (owner 10-31, src/components/AccountSharing.vue): what each league's / tournament's organisers can see.
// Side: Session, Email (league-email address and confirmation, src/components/AccountEmail.vue), Teams, Privacy (download
// my data / delete my account), test sign-in.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, onServerPrefetch, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import TestSignInCard from "../components/TestSignInCard.vue";
import ScheduleDialog from "../components/ScheduleDialog.vue";
import AccountIdentity from "../components/AccountIdentity.vue";
import AccountCalendar from "../components/AccountCalendar.vue";
import AccountContact from "../components/AccountContact.vue";
import AccountLeagueSharing from "../components/AccountLeagueSharing.vue";
import AccountSharing from "../components/AccountSharing.vue";
import { LEAGUE_SHARING_KEY } from "../account/leagueSharing";
import { createContactEditor } from "../account/contact";
import { ONBOARDING_KEY } from "../account/onboarding";
import AccountEmail from "../components/AccountEmail.vue";
import AccountPrivacy from "../components/AccountPrivacy.vue";
import { createPrivacyController, DELETED_NOTICE, setFlash } from "../account/privacy";
import { calendarZone } from "../account/calendar";
import { createAccountEditors } from "../account/editors";
import { createScheduleDialog, SCHEDULE_DIALOG_KEY, SCHEDULE_HASH } from "../account/scheduleDialog";
import { browserTimeZone } from "../home/deadlines";
import { COACH_TREE_KEY } from "../home/tree";
import { useNow } from "../home/shell";

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const tree = inject(COACH_TREE_KEY, null);
const now = useNow();

// Per-coach editors (src/account/editors.ts): a session switch recreates them, the keyed panels below remount and reload.
const editors = createAccountEditors({
  api: fetcher,
  currentCoach: () => (session.signedIn() ? session.coach() : ""),
  onScheduleSaved: () => tree?.invalidate(),
});
const { coach, profile, schedule, proposals } = editors;
onBeforeUnmount(() => editors.stop());
// Contact & consent (new-user flow fields, PATCH /api/me/contact): a fresh editor per coach, like the panels above, and
// again when the welcome modal completes (the one loaded behind it holds pre-onboarding consent).
const onboarding = inject(ONBOARDING_KEY, null);
const contactRound = ref(0);
const hasLeagueSharing = inject(LEAGUE_SHARING_KEY, null) !== null;
watch(() => onboarding?.open() === true, (open, was) => { if (was && !open) contactRound.value++; });
const contact = computed(() => { void coach.value; void contactRound.value; return createContactEditor({ api: fetcher }); });

const zone = computed(() => calendarZone({
  scheduleLoaded: schedule.value.state.loaded, scheduleZone: schedule.value.state.timezone, treeZone: tree?.state.timezone ?? "", browserZone: browserTimeZone(),
}));
const deadlines = computed(() => tree?.state.deadlines ?? []);
const discord = computed(() => profile.value.state.view?.discord);

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

const route = useRoute();
const router = useRouter();
// Privacy panel: after a delete the server has ended every session; re-read it and land on the home page with a notice.
const privacy = createPrivacyController({
  api: fetcher,
  coach: () => session.coach(),
  onDeleted: async () => {
    setFlash(DELETED_NOTICE);
    await session.load(true);
    await router.push("/home");
  },
});
const opener = ref<HTMLButtonElement | null>(null);
const scheduleDialog = inject(SCHEDULE_DIALOG_KEY, null) ?? createScheduleDialog({
  isDirty: () => schedule.value.state.dirty,
  focusOpener: () => { void nextTick(() => opener.value?.focus({ preventScroll: true })); },
}, route.hash === SCHEDULE_HASH && session.signedIn());
const dialogOpen = computed(() => scheduleDialog.open.value && session.signedIn());
// A different coach (Test sign-in, sign out) gets a fresh editor: the dialog must not stay open over it.
watch(coach, () => { scheduleDialog.close(); void loadWeek(); });
// Landing on #schedule (also from a link while this page is mounted) opens the dialog.
watch(() => route.hash, (h) => { if (h === SCHEDULE_HASH && session.signedIn()) scheduleDialog.show(); });

// The calendar shades from the week, which used to load with the Schedule panel: load it here (once per editor).
async function loadWeek(): Promise<void> {
  const ed = schedule.value;
  if (coach.value && !ed.state.loaded && !ed.state.loadFailed) await ed.load();
}

onMounted(() => { void editors.refreshProposals(); void loadWeek(); });
// Server rendering: the week loads before the Schedule panel and the calendar both render from it.
onServerPrefetch(() => (coach.value ? schedule.value.load() : undefined));
</script>

<template>
  <div class="ac-root">
  <div class="hm-page ac-page" :inert="dialogOpen ? true : undefined" :aria-hidden="dialogOpen ? 'true' : undefined">
    <p class="ac-privacy-link" data-testid="account-privacy"><RouterLink to="/privacy">How we use your data</RouterLink></p>
    <div class="hm-grid">
      <div class="hm-col hm-col-main">
        <section v-if="session.signedIn()" id="identity" :key="`identity-${coach}`" class="hm-panel" aria-labelledby="ac-identity-h">
          <header class="hm-band"><h2 id="ac-identity-h">Identity</h2><span class="hm-cap">What coaches see</span></header>
          <AccountIdentity :editor="profile" :coach="session.coach()" />
        </section>

        <section v-if="session.signedIn()" id="contact" :key="`contact-${coach}-${contactRound}`" class="hm-panel" aria-labelledby="ac-contact-h">
          <header class="hm-band"><h2 id="ac-contact-h">Contact &amp; consent</h2><span class="hm-cap">Only organisers you allow</span></header>
          <AccountContact :editor="contact" />
        </section>

        <section v-if="session.signedIn() && hasLeagueSharing" id="league-sharing" :key="`league-sharing-${coach}`" class="hm-panel" aria-labelledby="ac-share-h">
          <header class="hm-band"><h2 id="ac-share-h">League data sharing</h2><span class="hm-cap">Who sees your details</span></header>
          <AccountLeagueSharing :coach="session.coach()" />
        </section>

        <section v-if="session.signedIn()" id="calendar" :key="`calendar-${coach}`" class="hm-panel" aria-labelledby="ac-calendar-h">
          <header class="hm-band"><h2 id="ac-calendar-h">Calendar</h2><RouterLink class="hm-cap" to="/home#deadlines">Deadlines</RouterLink>
            <button ref="opener" class="lobby-btn ac-set-schedule" type="button" aria-haspopup="dialog" @click="scheduleDialog.show()">Set schedule</button>
          </header>
          <AccountCalendar :deadlines="deadlines" :proposals="proposals" :blocks="schedule.state.blocks" :timezone="zone" :now="now" :loading="tree?.state.loading" />
        </section>

        <section v-if="session.signedIn()" id="sharing" :key="`sharing-${coach}`" class="hm-panel" aria-labelledby="ac-sharing-h">
          <header class="hm-band"><h2 id="ac-sharing-h">Sharing</h2><span class="hm-cap">Per league and tournament</span></header>
          <AccountSharing />
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

        <section v-if="session.signedIn()" id="email" :key="`email-${coach}`" class="hm-panel" aria-labelledby="ac-email-h">
          <header class="hm-band"><h2 id="ac-email-h">Email</h2><span class="hm-cap">League emails</span></header>
          <AccountEmail />
        </section>

        <section id="teams" class="hm-panel" aria-labelledby="ac-teams-h">
          <header class="hm-band"><h2 id="ac-teams-h">Teams</h2></header>
          <p class="hm-links"><RouterLink to="/my-teams">My teams</RouterLink> · <RouterLink to="/my-teams#avatars">Team avatars</RouterLink></p>
        </section>

        <section v-if="session.signedIn()" id="privacy" :key="`privacy-${coach}`" class="hm-panel" aria-labelledby="ac-privacy-h">
          <header class="hm-band"><h2 id="ac-privacy-h">Privacy</h2><span class="hm-cap">Your data</span></header>
          <AccountPrivacy :controller="privacy" :coach="session.coach()" />
        </section>

        <TestSignInCard />
      </div>
    </div>
  </div>
  <ScheduleDialog v-if="dialogOpen" :key="`schedule-${coach}`" :editor="schedule" :dialog="scheduleDialog" />
  </div>
</template>
