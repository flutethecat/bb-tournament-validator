<script setup lang="ts">
// Coach page (/app/home, spec §4.7): two columns at >= 1280 (fluid / 380 px), one column on a phone. Left:
// Notifications (the shared store, NotificationsPanel), Deadlines (GET /api/me/deadlines, via the nav tree), Recent games (GET /api/recent-results). The availability editor lives on the Account page (owner 10-30).
// Right: Friends (GET /api/me/friends) and the Messages preview (GET /api/me/threads), My teams strip, Honours (league awards, GET /api/leagues?awards=mine), Account shortcut, What's new.
import { computed, inject, onBeforeUnmount, onMounted, onServerPrefetch, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import MiniCalendar from "../components/MiniCalendar.vue";
import NotificationsPanel from "../components/NotificationsPanel.vue";
import HomeHonours from "../components/HomeHonours.vue";
import HomeBadges from "../components/HomeBadges.vue";
import HomeFriends from "../components/HomeFriends.vue";
import HomeMessages from "../components/HomeMessages.vue";
import HomeGetStarted from "../components/HomeGetStarted.vue";
import RecentGames from "../components/RecentGames.vue";
import { SESSION_KEY, writesAllowed } from "../session";
import { NOTIFICATIONS_KEY } from "../home/notifications";
import { COACH_TREE_KEY } from "../home/tree";
import { calendarZone } from "../account/calendar";
import { browserTimeZone, CHIP_CLASS, chipFor, formatWhen, timeLeft } from "../home/deadlines";
import { loadBuildLog, logDate, useNow, type BuildLogEntry } from "../home/shell";
import { fmtK } from "../shared/format";
import { resolveCrest, type ArtManifests } from "../tabletop/art";
import { teamManagePath } from "../teams/manage";

interface MyTeam { ref: string; name: string; race?: string; tv?: number | null; registered?: Array<{ id: string; name: string }>; actions?: { count: number; items: string[] } }

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const tree = inject(COACH_TREE_KEY)!;
const notifications = inject(NOTIFICATIONS_KEY)!;
const canWrite = computed(() => writesAllowed(session));

// One shared clock (60 s tick) drives the chips and countdowns here and in the nav.
const now = useNow();
const zone = computed(() => tree.state.timezone || browserTimeZone());
const calZone = computed(() => calendarZone({ scheduleLoaded: false, scheduleZone: "", treeZone: tree.state.timezone, browserZone: browserTimeZone() }));
const deadlines = computed(() => tree.state.deadlines.map((d) => ({ ...d, chip: chipFor(d.at, now.value) })));
const CHIP_TEXT = { ok: "More than 3 days", soon: "Under 72 hours", urgent: "Under 24 hours", overdue: "Overdue" } as const;

const teams = ref<MyTeam[]>([]);
const art = ref<ArtManifests>({});
const teamsLoaded = ref(false);
const teamsError = ref("");
const log = ref<BuildLogEntry[]>([]);
const logError = ref("");

async function loadTeams(): Promise<void> {
  const coach = session.coach();
  if (!coach) return;
  try {
    const res = await fetcher<{ teams?: MyTeam[]; saves?: Array<{ id: string; name: string }> }>(`/api/tabletop/saves?coach=${encodeURIComponent(coach)}`);
    teams.value = res.teams ?? (res.saves ?? []).map((s) => ({ ref: `save:${s.id}`, name: s.name }));
    teamsError.value = "";
  } catch (e) { teamsError.value = (e as Error).message; }
  try { art.value = { crests: await fetcher<{ crests?: Record<string, string> }>("/crests/manifest.json") }; } catch { /* no crest */ }
  teamsLoaded.value = true;
}

async function loadLog(): Promise<void> {
  try { log.value = (await loadBuildLog(fetcher)).slice(0, 5); logError.value = ""; } catch (e) { logError.value = (e as Error).message; }
}

const competition = (t: MyTeam) => (t.registered?.length ? t.registered.map((r) => r.name).join(", ") : "Not registered");
const actionTitle = (t: MyTeam) => (t.actions?.items ?? []).join(" · ");
const actionCount = (t: MyTeam) => t.actions?.count ?? 0;
const crestFor = (t: MyTeam) => resolveCrest(art.value, t.race);

onMounted(() => {
  if (!teamsLoaded.value) void loadTeams();
  if (!log.value.length) void loadLog();
  void notifications.load();
  notifications.subscribe();
});
onBeforeUnmount(() => notifications.unsubscribe());
onServerPrefetch(() => Promise.all([loadTeams(), loadLog()]));
</script>

<template>
  <div class="hm-page sf-fit">
    <!-- New coaches (spec 11-02 §3): next steps, until hidden or all done -->
    <HomeGetStarted />
    <div class="hm-grid sf-fill sf-cols"><!-- fit to 1920x1080 (owner 11-02): each column scrolls -->
      <div class="hm-col hm-col-main">
        <section id="whats-new" class="hm-panel" aria-labelledby="hm-new-h">
          <header class="hm-band" data-tone="admin"><h2 id="hm-new-h">What's new</h2><RouterLink class="hm-cap" to="/whats-new">All updates</RouterLink></header>
          <p v-if="logError" class="lobby-error hm-small">{{ logError }}</p>
          <p v-else-if="!log.length" class="hm-empty">Nothing yet</p>
          <ul v-else class="hm-log hm-log-strip" aria-label="What's new">
            <li v-for="(e, i) in log" :key="`${e.date}-${i}`">
              <time :datetime="e.date" class="hm-log-date">{{ logDate(e.date) }}</time>
              <strong class="hm-log-title">{{ e.title }}</strong>
              <p class="hm-log-body">{{ e.body }}</p>
            </li>
          </ul>
        </section>

        <div id="notifications" class="hm-notifications">
          <NotificationsPanel :notifications="notifications" :writable="canWrite" />
        </div>

        <section id="deadlines" class="hm-panel" aria-labelledby="hm-deadlines-h">
          <header class="hm-band"><h2 id="hm-deadlines-h">Deadlines</h2><span class="hm-cap">{{ zone }}</span></header>
          <p v-if="!deadlines.length" class="hm-empty">{{ tree.state.loading ? "Loading…" : "No deadlines coming up." }}</p>
          <ul v-else class="hm-deadlines">
            <li v-for="d in deadlines" :key="d.id">
              <RouterLink class="hm-deadline" :to="d.link">
                <span class="hm-chip" :class="CHIP_CLASS[d.chip]" :aria-label="`${timeLeft(d.at, now)} (${CHIP_TEXT[d.chip]})`">{{ timeLeft(d.at, now) }}</span>
                <span class="hm-what"><strong>{{ d.title }}</strong><small>{{ d.detail }}</small></span>
                <time class="hm-when" :datetime="d.at">{{ formatWhen(d.at, zone) }}</time>
              </RouterLink>
            </li>
          </ul>
        </section>

        <RecentGames />
      </div>

      <div class="hm-col hm-col-side">
        <HomeFriends />

        <HomeMessages />

        <section id="mini-calendar" class="hm-panel" aria-labelledby="hm-minical-h">
          <header class="hm-band"><h2 id="hm-minical-h">Mini calendar</h2><RouterLink class="hm-cap" to="/account#calendar">Full calendar</RouterLink></header>
          <MiniCalendar :deadlines="deadlines" :timezone="calZone" :now="now" :loading="tree.state.loading" />
        </section>

        <section id="my-teams" class="hm-panel" aria-labelledby="hm-teams-h">
          <header class="hm-band"><h2 id="hm-teams-h">My teams</h2><RouterLink class="hm-cap" to="/my-teams">All teams</RouterLink></header>
          <p v-if="teamsError" class="lobby-error hm-small">{{ teamsError }}</p>
          <p v-else-if="teamsLoaded && !teams.length" class="hm-empty">No teams yet. <a href="/team-builder.html">Build one</a>.</p>
          <ul v-else class="hm-teams hm-teams-strip" aria-label="My teams">
            <li v-for="t in teams" :key="t.ref">
              <RouterLink class="hm-team" :to="teamManagePath(t.ref)" :title="`Manage ${t.name}`">
                <img v-if="crestFor(t)" class="hm-team-crest" :src="crestFor(t)" alt="" loading="lazy" />
                <span v-else class="hm-team-crest hm-team-blank" aria-hidden="true">{{ t.name.slice(0, 1) }}</span>
                <span class="hm-team-name">{{ t.name }}</span>
                <small v-if="t.race" class="hm-team-race">{{ t.race }}</small>
                <small class="hm-team-comp">{{ competition(t) }}</small>
                <small class="hm-team-tv">TV {{ typeof t.tv === "number" ? fmtK(t.tv) : "—" }}</small>
                <span v-if="actionCount(t) > 0" class="sf-count hm-team-badge" role="img" :aria-label="`${actionCount(t)} ${actionCount(t) === 1 ? 'action' : 'actions'} needed`" :title="actionTitle(t)">{{ actionCount(t) }}</span>
              </RouterLink>
            </li>
          </ul>
        </section>

        <HomeHonours />

        <HomeBadges />
      </div>
    </div>
  </div>
</template>
