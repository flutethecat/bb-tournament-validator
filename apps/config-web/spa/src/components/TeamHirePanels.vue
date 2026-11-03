<script setup lang="ts">
// The team page's left accordion (team page v2, owner 11-02 addition): Hireable players and Sideline staff, the same
// panels and order as the Roster Builder's (TournamentBuilderAccordion: Hireable players open by default, one open at a
// time, a bar opens in place). Positions come from the server's edit context (the roster's dataset: cost, limit, how many
// are hired, stats and printed skills). A coach pays from the treasury (before the first game also sells staff back and
// sets rerolls and dedicated fans; after it only adds players and staff, never rerolls); an organiser in edit mode hires
// for free and sets staff numbers directly in the strip above. The server validates every step again.
import { computed, ref } from "vue";
import type { StaffKey, TeamPageView } from "../teams/summary";
import { kValue } from "../teams/summary";
import { heightEnter, heightLeave } from "../teams/accordionMotion";
import "../teams/builder.css";

const props = defineProps<{ view: TeamPageView; mode: "coach" | "organiser"; busy?: boolean }>();
const emit = defineEmits<{ hire: [position: string]; staff: [key: StaffKey, delta: 1 | -1] }>();
const open = ref<"hire" | "staff">("hire");
const treasury = computed(() => props.view.team.treasury ?? 0);
const full = computed(() => props.view.team.players.length >= props.view.hire.maxPlayers);
const coach = computed(() => props.mode === "coach");
const pregame = computed(() => props.view.phase === "pregame");
function hireReason(p: TeamPageView["hire"]["positions"][number]): string {
  if (full.value) return `At most ${props.view.hire.maxPlayers} players.`;
  if (p.count >= p.max) return `At most ${p.max}.`;
  if (coach.value && p.cost > treasury.value) return `Costs ${kValue(p.cost)}; the treasury holds ${kValue(treasury.value)}.`;
  return "";
}
function staffLocked(key: StaffKey): string {
  if (!coach.value || pregame.value) return "";
  if (key === "rerolls") return "Locked once the team has played";
  if (key === "fans") return "Changes through game results";
  return "";
}
const staffRows = computed(() => props.view.hire.staff.filter((s) => s.max > 0 || s.key !== "apothecary"));
const canDown = (s: TeamPageView["hire"]["staff"][number]): boolean => coach.value && pregame.value && s.count > s.min && !staffLocked(s.key);
const canUp = (s: TeamPageView["hire"]["staff"][number]): boolean => coach.value && s.count < s.max && !staffLocked(s.key) && s.price <= treasury.value;
const stat = (v: number | null, plus = false): string => (v === null ? "-" : `${v}${plus ? "+" : ""}`);
function toggle(p: "hire" | "staff"): void { if (p !== "hire" || open.value !== "hire") open.value = open.value === p ? "hire" : p; }
</script>

<template>
  <div class="tb-col tb-col-left ts-hire" data-hire-panels>
    <section class="hm-panel tb-panel tb-acc" :class="{ open: open === 'hire' }" data-panel="hire" aria-labelledby="ts-hire-h">
      <header class="hm-band tb-acc-band">
        <h2 id="ts-hire-h">
          <button id="ts-acc-hire" type="button" class="tb-acc-btn" :aria-expanded="open === 'hire' ? 'true' : 'false'" aria-controls="ts-acc-body-hire" @click="toggle('hire')">
            <span class="tb-acc-title">Hireable players</span><span class="hm-cap">{{ view.team.players.length }} / {{ view.hire.maxPlayers }}</span><i class="tb-acc-chev" aria-hidden="true"></i>
          </button>
        </h2>
      </header>
      <Transition :css="false" @enter="heightEnter" @leave="heightLeave">
        <div v-if="open === 'hire'" id="ts-acc-body-hire" class="tb-acc-body" role="region" aria-labelledby="ts-acc-hire">
          <p v-if="coach" class="hm-small ts-treasury">Treasury <b>{{ kValue(treasury) }}</b></p>
          <p v-if="!view.hire.positions.length" class="hm-empty hm-small">This roster's positions could not be loaded.</p>
          <ul class="ts-positions">
            <li v-for="p in view.hire.positions" :key="p.name" class="ts-position" :data-off="hireReason(p) ? 'true' : undefined">
              <span class="ts-pos-head"><strong>{{ p.name }}</strong><span class="tb-cost">{{ kValue(p.cost) }}</span><small class="tb-hired">{{ p.count }}/{{ p.max }}</small></span>
              <span class="ts-pos-stats">MA {{ p.ma }} · ST {{ p.st }} · AG {{ stat(p.ag, true) }} · PA {{ stat(p.pa, true) }} · AV {{ stat(p.av, true) }}</span>
              <small class="ts-pos-skills">{{ p.skills.join(", ") || "No printed skills" }}</small>
              <button type="button" class="sf-btn small" :disabled="busy || Boolean(hireReason(p))" :title="hireReason(p) || undefined" :aria-label="`Hire ${p.name}, ${kValue(p.cost)}${coach ? '' : ' (edit mode: free)'}`" @click="emit('hire', p.name)">Hire</button>
              <small v-if="hireReason(p)" class="ts-pos-why">{{ hireReason(p) }}</small>
            </li>
          </ul>
        </div>
      </Transition>
    </section>
    <section class="hm-panel tb-panel tb-acc" :class="{ open: open === 'staff' }" data-panel="staff" aria-labelledby="ts-staff-h">
      <header class="hm-band tb-acc-band">
        <h2 id="ts-staff-h">
          <button id="ts-acc-staff" type="button" class="tb-acc-btn" :aria-expanded="open === 'staff' ? 'true' : 'false'" aria-controls="ts-acc-body-staff" @click="toggle('staff')">
            <span class="tb-acc-title">Sideline staff</span><i class="tb-acc-chev" aria-hidden="true"></i>
          </button>
        </h2>
      </header>
      <Transition :css="false" @enter="heightEnter" @leave="heightLeave">
        <div v-if="open === 'staff'" id="ts-acc-body-staff" class="tb-acc-body" role="region" aria-labelledby="ts-acc-staff">
          <p v-if="!coach" class="hm-small hm-empty">Edit mode: set staff numbers in the team strip above.</p>
          <ul class="tb-steppers">
            <li v-for="s in staffRows" :key="s.key" class="tb-step-row ts-step-row" :data-staff="s.key">
              <span class="tb-step-icon" aria-hidden="true"></span>
              <span class="tb-who"><strong>{{ s.label }}</strong><small>{{ staffLocked(s.key) || `${s.min}–${s.max} · ${kValue(s.price)} each${s.key === 'fans' ? ', 1 free' : ''}` }}</small></span>
              <span class="tb-stepper">
                <button type="button" :disabled="busy || !canDown(s)" :aria-label="`Remove ${s.label}`" @click="emit('staff', s.key, -1)">−</button>
                <b aria-live="polite">{{ s.count }}</b>
                <button type="button" :disabled="busy || !canUp(s)" :aria-label="`Add ${s.label}`" @click="emit('staff', s.key, 1)">+</button>
              </span>
            </li>
          </ul>
        </div>
      </Transition>
    </section>
  </div>
</template>
