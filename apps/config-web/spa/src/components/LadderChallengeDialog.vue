<script setup lang="ts">
// Ladder challenge dialogs (lane 8b). "issue": the challenger confirms (your team, theirs, what a win does, the answer and
// play-by windows). "answer": the challenged coach accepts or declines; with the decline rule on it says how many declines
// they have used in the window (the server counts; this is the coach's own recent history from the read). Accepting hands
// straight over to Propose a time (the tab opens it).
import { computed } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import type { LadderChallengeView, LadderRankRow, LadderSettings } from "../leagues/ladder";
import { RANKING_LABEL, timeLeft } from "../leagues/ladder";

const props = defineProps<{
  mode: "issue" | "answer";
  settings: LadderSettings;
  /** issue: the two ranking rows. */
  mine?: LadderRankRow;
  target?: LadderRankRow;
  /** answer: the challenge, and the defender's declines in the window so far. */
  challenge?: LadderChallengeView;
  declinesUsed?: number;
  busy?: boolean;
  error?: string;
  now: number;
}>();
const emit = defineEmits<{ close: []; send: []; accept: []; decline: [] }>();
const settingsCap = (s: LadderSettings): string => `${RANKING_LABEL[s.ranking]} ladder`;

const ord = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
const winLine = computed(() => {
  if (!props.mine || !props.target) return "";
  if (props.settings.ranking === "position") return `If you win, ${props.mine.team} takes ${ord(props.target.rank)} place and the teams between move down one.`;
  if (props.settings.ranking === "points") return `A win is worth ${props.settings.points.win} points, a draw ${props.settings.points.draw}.`;
  return "A win against a higher-rated team moves your rating up more.";
});
const declineLine = computed(() => {
  const r = props.settings.declineRule;
  if (!r.enabled) return "";
  const used = props.declinesUsed ?? 0;
  return used + 1 >= r.count
    ? `Declining this one would be your ${ord(used + 1)} decline in ${r.days} days: it counts as a loss.`
    : `You have declined ${used} of ${r.count} in the last ${r.days} days; the ${ord(r.count)} counts as a loss.`;
});
</script>

<template>
  <LeagueDialog
    v-if="mode === 'issue'" id="ld-issue-h" class="ld-dialog" :title="`Challenge ${target?.team ?? ''}`" :cap="settingsCap(settings)" tag="form" :busy="busy" @close="emit('close')" @submit="emit('send')"
  >
    <dl class="tr-sum ld-sum">
      <dt>Your team</dt><dd>{{ mine?.team }} <span class="muted">· {{ ord(mine?.rank ?? 0) }}</span></dd>
      <dt>Their team</dt><dd>{{ target?.team }} <span class="muted">· {{ target?.coach }} · {{ ord(target?.rank ?? 0) }}</span></dd>
      <dt>If you win</dt><dd>{{ winLine }}</dd>
      <dt>Timing</dt><dd>They have {{ settings.expiryHours }} hours to answer. Once accepted, you agree a time and play within {{ settings.playByDays }} days, or the game is discarded with no penalty.</dd>
    </dl>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <span class="tr-foot-gap" />
      <button type="submit" class="sf-btn primary" data-autofocus :disabled="busy">{{ busy ? "Sending..." : "Send challenge" }}</button>
    </template>
  </LeagueDialog>
  <LeagueDialog v-else id="ld-answer-h" class="ld-dialog" :title="`Challenge from ${challenge?.challenger.team ?? ''}`" :cap="timeLeft(challenge?.expiresAt, now)" :busy="busy" @close="emit('close')">
    <dl class="tr-sum ld-sum">
      <dt>From</dt><dd>{{ challenge?.challenger.team }} <span class="muted">· {{ challenge?.challenger.coach }} · {{ challenge?.challenger.race }}</span></dd>
      <dt>To</dt><dd>{{ challenge?.defender.team }}</dd>
      <dt>Answer by</dt><dd>{{ challenge?.expiresAt.slice(0, 16).replace("T", " ") }} UTC <span class="muted">· unanswered challenges expire{{ settings.declineRule.enabled ? " and count as a decline" : "" }}</span></dd>
      <dt>If you accept</dt><dd>You agree a time with {{ challenge?.challenger.coach }} straight away and play within {{ settings.playByDays }} days.</dd>
    </dl>
    <p v-if="declineLine" class="sf-notice ld-decline-note">{{ declineLine }}</p>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" data-action="decline" @click="emit('decline')">Decline</button>
      <span class="tr-foot-gap" />
      <button type="button" class="sf-btn primary" data-autofocus data-action="accept" :disabled="busy" @click="emit('accept')">{{ busy ? "Saving..." : "Accept and propose a time" }}</button>
    </template>
  </LeagueDialog>
</template>

