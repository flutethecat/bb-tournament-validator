<script setup lang="ts">
// The Rumble on the Ladder tab (ladder titles lane): the latest Rumble's bracket (rounds as columns, seeds, scores, byes and
// "better seed" fallbacks), open-entry Enter / Withdraw for the viewer's team, and the organisers' Set up a Rumble dialog (date,
// field: top 8 or open entry, days per round) and Call off. The draw and the rounds are the server's (the tournament engine's
// knockout pairing); this only shows them.
import { computed, reactive, ref } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import BeltIcon from "./BeltIcon.vue";
import { rumbleRoundName, rumbleRounds, timeLeft, type RumbleView } from "../leagues/ladder";

const props = defineProps<{ rumbles: RumbleView[]; manage: boolean; canWrite: boolean; myTeam: string; busy: string; error: string; now: number; points: number; beltOn: boolean }>();
const emit = defineEmits<{ call: [key: string, path: string, body: Record<string, unknown>, done?: () => void]; propose: [ref: string] }>();

const current = computed(() => props.rumbles.find((r) => r.state === "entry" || r.state === "running") ?? props.rumbles[0]);
const total = computed(() => rumbleRounds(current.value?.seeds.length || current.value?.entries.length || 8));
const entered = computed(() => Boolean(current.value?.entries.some((e) => e.teamId === props.myTeam)));
const seedOf = (id: string | undefined) => current.value?.seeds.find((s) => s.teamId === id)?.seed;
const day = (iso: string) => iso.slice(0, 10);
const STATE: Record<RumbleView["state"], string> = { entry: "Coming up", running: "Under way", finished: "Finished", cancelled: "Called off" };
const TONE: Record<RumbleView["state"], string> = { entry: "soon", running: "ok", finished: "muted", cancelled: "muted" };

const setup = ref(false);
const tomorrow = () => new Date(props.now + 86_400_000).toISOString().slice(0, 10);
const form = reactive({ name: "", date: "", time: "19:00", field: "top8" as "top8" | "open", roundDays: 3 });
function openSetup(): void { form.name = ""; form.date = tomorrow(); form.time = "19:00"; form.field = "top8"; form.roundDays = 3; setup.value = true; }
function submit(): void {
  emit("call", "rumble", "rumbles", { ...(form.name.trim() ? { name: form.name.trim() } : {}), date: new Date(`${form.date}T${form.time || "00:00"}:00Z`).toISOString(), field: form.field, roundDays: Number(form.roundDays) }, () => { setup.value = false; });
}
</script>

<template>
  <section class="hm-panel ld-rumble" aria-labelledby="ld-rumble-h">
    <header class="hm-band">
      <h2 id="ld-rumble-h">Rumble</h2>
      <span v-if="current" class="hm-cap">{{ current.name }} · {{ STATE[current.state] }}</span>
    </header>
    <div class="ld-ttl-body">
      <template v-if="current">
        <p class="ld-meta">
          <span class="sf-chip" :data-tone="TONE[current.state]">{{ STATE[current.state] }}</span>
          <span class="muted">{{ day(current.date) }} · {{ current.field === "top8" ? "the top 8" : "open entry" }} · {{ current.roundDays }} days a round</span>
        </p>
        <p class="ld-help">The winner gets {{ beltOn ? "a guaranteed title shot and " : "" }}{{ current.points }} points. An unplayed or drawn game goes to the better seed.</p>
        <p v-if="current.note" class="sf-notice">{{ current.note }}</p>
        <p v-if="current.winner" class="ld-rumble-winner"><BeltIcon :size="26" /> <strong>{{ current.winner.team }}</strong> <span class="muted">won {{ current.name }}</span></p>
        <!-- Open entry -->
        <template v-if="current.state === 'entry' && current.field === 'open'">
          <p class="ld-help">{{ current.entries.length }} entered{{ current.entries.length ? `: ${current.entries.map((e) => e.team).join(", ")}` : "" }}. Entry closes {{ timeLeft(current.date, now) }}.</p>
          <p v-if="myTeam" class="ld-actions">
            <button v-if="!entered" type="button" class="sf-btn small primary" data-rumble="enter" :disabled="!canWrite || Boolean(busy)" @click="emit('call', 'enter', `rumbles/${current.id}/enter`, { teamId: myTeam })">Enter my team</button>
            <button v-else type="button" class="sf-btn small" data-rumble="withdraw" :disabled="!canWrite || Boolean(busy)" @click="emit('call', 'withdraw', `rumbles/${current.id}/withdraw`, { teamId: myTeam })">Withdraw</button>
          </p>
        </template>
        <p v-else-if="current.state === 'entry'" class="ld-help">The top 8 of the ranking on {{ day(current.date) }} play.</p>
        <!-- Bracket -->
        <div v-if="current.rounds.length" class="ld-bracket" role="list" :aria-label="`${current.name} bracket`">
          <div v-for="(r, i) in current.rounds" :key="r.number" class="ld-bracket-round" role="listitem">
            <p class="sf-k">{{ rumbleRoundName(i, total) }} <span class="muted">· by {{ day(r.deadline) }}</span></p>
            <ul class="ld-bracket-list">
              <li v-for="m in r.matches" :key="m.slot" class="ld-bracket-match" :data-how="m.how">
                <span class="ld-bm-side" :data-win="m.winnerTeamId === m.home.teamId ? 'true' : undefined"><small class="ld-seed">{{ seedOf(m.home.teamId) }}</small>{{ m.home.team }}<b v-if="m.score">{{ m.score[0] }}</b></span>
                <span v-if="m.away" class="ld-bm-side" :data-win="m.winnerTeamId === m.away.teamId ? 'true' : undefined"><small class="ld-seed">{{ seedOf(m.away.teamId) }}</small>{{ m.away.team }}<b v-if="m.score">{{ m.score[1] }}</b></span>
                <span v-else class="ld-bm-side muted">Bye</span>
                <small v-if="m.how === 'fallback'" class="muted">Better seed through</small>
                <small v-else-if="m.how === 'walkover'" class="muted">Walkover: a team left the ladder</small>
                <button v-if="m.scheduleRef" type="button" class="sf-btn small" :disabled="!canWrite" @click="emit('propose', m.scheduleRef)">Propose a time</button>
              </li>
            </ul>
          </div>
        </div>
      </template>
      <p v-else class="ld-help">No Rumble yet. Organisers can set one up: a quick knockout for the top 8 or anyone who enters.</p>
      <p v-if="manage" class="ld-actions">
        <button v-if="!current || current.state === 'finished' || current.state === 'cancelled'" type="button" class="sf-btn small" data-rumble="setup" :disabled="Boolean(busy)" @click="openSetup">Set up a Rumble</button>
        <button v-else type="button" class="sf-btn small danger" data-rumble="cancel" :disabled="Boolean(busy)" @click="emit('call', 'rumble-cancel', `rumbles/${current.id}/cancel`, {})">Call off</button>
      </p>
    </div>

    <LeagueDialog v-if="setup" id="ld-rumble-setup-h" title="Set up a Rumble" cap="Quick knockout" tag="form" :busy="busy === 'rumble'" @close="setup = false" @submit="submit">
      <div class="ld-rumble-form">
        <label class="sf-field"><span class="sf-k">Name (optional)</span><input v-model="form.name" class="sf-input" type="text" maxlength="60" placeholder="The Rumble" data-autofocus /></label>
        <div class="ld-rumble-two">
          <label class="sf-field"><span class="sf-k">Date</span><input v-model="form.date" class="sf-input" type="date" required /></label>
          <label class="sf-field"><span class="sf-k">Time (UTC)</span><input v-model="form.time" class="sf-input" type="time" /></label>
        </div>
        <fieldset class="sf-field ld-rumble-field">
          <legend class="sf-k">Field</legend>
          <label class="sf-check"><input v-model="form.field" type="radio" value="top8" name="rumble-field" /> The top 8 of the ranking on the day</label>
          <label class="sf-check"><input v-model="form.field" type="radio" value="open" name="rumble-field" /> Open entry: coaches enter before the date</label>
        </fieldset>
        <label class="sf-field"><span class="sf-k">Days to play each round</span><input v-model.number="form.roundDays" class="sf-input" type="number" min="1" max="14" /></label>
        <p class="ld-help">The draw is seeded by the ranking. The winner gets {{ beltOn ? "a guaranteed title shot (the champion can't decline) and " : "" }}{{ points }} points. Gold, SPP and progression count as in any game.</p>
        <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      </div>
      <template #foot>
        <button type="button" class="sf-btn" :disabled="busy === 'rumble'" @click="setup = false">Cancel</button>
        <span class="tr-foot-gap" />
        <button type="submit" class="sf-btn primary" :disabled="busy === 'rumble' || !form.date">{{ busy === "rumble" ? "Saving..." : "Set up the Rumble" }}</button>
      </template>
    </LeagueDialog>
  </section>
</template>
