<script setup lang="ts">
// Inducement picker for one team, in the Super FUMBBL client's "Buy inducements" style: the catalogue (icon, name,
// price, limit, steppers) on the left, the cart with the budget on the right. Prices, limits and the budget come from
// the server (pregame.inducementOptions / pregame.budget, by the BB2025 petty-cash rules); the server validates again.
import { computed, watch } from "vue";
import { createCartSync, picksKey } from "../tabletop/inducementCart";
import type { Side } from "../tabletop/recorder";

export interface InducementOption { id: string; name: string; price?: number; cost?: number; max?: number | null }
export interface InducementBudget { role: "favourite" | "underdog" | "equal"; pettyCash: number; treasury: number; topUpLimit: number; spent: number; submitted: boolean }

const props = defineProps<{
  side: Side;
  teamName: string;
  coach: string;
  options: InducementOption[];
  budget?: InducementBudget;
  icons?: Record<string, string>;
  busy: boolean;
  /** Who may submit for this team (either coach at the table, an organiser); others see the cart read-only. */
  canEdit: boolean;
  /** The higher-value team goes first: set to its name while it has not chosen. */
  waitingFor?: string;
  submitted: boolean;
  /** The team's last submission: the cart starts from it, so a resubmission edits rather than retypes. */
  initial?: Array<{ id: string; qty: number }>;
}>();
const emit = defineEmits<{ (e: "submit", side: Side, picks: Array<{ id: string; qty: number }>): void; (e: "skip", side: Side): void }>();

// The cart follows the server's submission for this team (either phone may submit), keeping an unsaved draft and
// flagging a newer submission instead of silently overwriting it (tabletop/inducementCart.ts).
const sync = createCartSync(props.initial);
watch(() => picksKey(props.initial), () => sync.server(props.initial));
const picks = computed(() => sync.state.picks);
const remoteChanged = computed(() => sync.state.remote !== null);
const priceOf = (o: InducementOption): number => o.price ?? o.cost ?? 0;
const k = (n: number): string => `${Math.round(n / 1000)}k`;
const bump = (o: InducementOption, d: number): void => {
  const cap = o.max ?? 9;
  sync.state.picks[o.id] = Math.max(0, Math.min(cap, (sync.state.picks[o.id] ?? 0) + d));
};
const cart = computed(() => props.options.filter((o) => (picks.value[o.id] ?? 0) > 0).map((o) => ({ ...o, qty: picks.value[o.id]!, line: priceOf(o) * picks.value[o.id]! })));
const total = computed(() => cart.value.reduce((n, l) => n + l.line, 0));
/** What can be spent: the favourite pays from its treasury; the underdog has petty cash plus a capped treasury top-up. */
const available = computed(() => {
  const b = props.budget;
  if (!b) return 0;
  return b.role === "underdog" ? b.pettyCash + b.topUpLimit : b.role === "favourite" ? b.topUpLimit : 0;
});
const left = computed(() => available.value - total.value);
const roleLine = computed(() => {
  const b = props.budget;
  if (!b) return "";
  if (b.role === "favourite") return "Higher team value: pays from the treasury and chooses first.";
  if (b.role === "underdog") return "Lower team value: petty cash from the gap, plus up to " + k(b.topUpLimit) + " from the treasury.";
  return "Team values are equal: neither team can buy inducements.";
});
const locked = computed(() => !props.canEdit || !!props.waitingFor);
const submit = (): void => emit("submit", props.side, cart.value.map((l) => ({ id: l.id, qty: l.qty })));
</script>

<template>
  <section class="tt-ipk" :data-side="side" :aria-label="`Inducements for ${teamName}`">
    <header class="tt-ipk-head">
      <span class="tt-ipk-title">Buy inducements</span>
      <span class="tt-ipk-team">{{ teamName }} <small>({{ coach }})</small></span>
      <span v-if="submitted" class="tt-ipk-done" role="status">&#10003; Chosen</span>
    </header>
    <p v-if="roleLine" class="tt-ipk-role muted">{{ roleLine }}</p>
    <p v-if="waitingFor" class="tt-ipk-wait" role="status">Waiting for {{ waitingFor }} (higher team value) to choose first<span class="tt-dots"><i>.</i><i>.</i><i>.</i></span></p>
    <div class="tt-ipk-grid">
      <div class="tt-ipk-list" role="list">
        <p v-if="!options.length" class="muted">No inducements offered.</p>
        <div v-for="o in options" :key="o.id" class="tt-ipk-row" role="listitem" :data-picked="(picks[o.id] ?? 0) > 0">
          <img v-if="icons?.[o.id]" class="tt-ipk-icon" :src="`/${icons[o.id]}`" alt="" />
          <span v-else class="tt-ipk-icon tt-ipk-ph" aria-hidden="true">&#9733;</span>
          <span class="tt-ipk-name">{{ o.name }}</span>
          <span class="tt-ipk-cost">{{ priceOf(o) ? k(priceOf(o)) : "-" }}</span>
          <span class="tt-ipk-stepper">
            <button type="button" class="tt-ipk-btn" :disabled="locked || (picks[o.id] ?? 0) <= 0" :aria-label="`Fewer ${o.name}`" @click="bump(o, -1)">&#8722;</button>
            <span class="tt-ipk-count">{{ picks[o.id] ?? 0 }}<small v-if="o.max">/{{ o.max }}</small></span>
            <button type="button" class="tt-ipk-btn" :disabled="locked || (o.max != null && (picks[o.id] ?? 0) >= o.max)" :aria-label="`More ${o.name}`" @click="bump(o, 1)">+</button>
          </span>
        </div>
      </div>
      <aside class="tt-ipk-cart" aria-label="Cart">
        <div class="tt-ipk-totals">
          <span v-if="budget?.role === 'underdog'">Petty cash <b>{{ k(budget.pettyCash) }}</b></span>
          <span v-if="budget">Treasury <b>{{ k(budget.treasury) }}</b><small v-if="budget.role === 'underdog'"> (up to {{ k(budget.topUpLimit) }})</small></span>
          <span>Spent <b>{{ k(total) }}</b></span>
          <span :data-low="left < 0">Left <b>{{ k(left) }}</b></span>
        </div>
        <ul class="tt-ipk-lines">
          <li v-for="l in cart" :key="l.id"><span>{{ l.qty }} x {{ l.name }}</span><b>{{ k(l.line) }}</b></li>
          <li v-if="!cart.length" class="muted">Nothing picked.</li>
        </ul>
        <p v-if="remoteChanged" class="tt-ipk-remote" role="alert">
          The picks for {{ teamName }} changed on the other phone.
          <button class="lobby-btn small tt-tap" type="button" @click="sync.reload()">Reload their picks</button>
        </p>
        <p v-if="left < 0" class="lobby-error" role="alert">Over budget by {{ k(-left) }}.</p>
        <div v-if="canEdit" class="tt-actions-row">
          <button class="lobby-btn primary tt-tap" type="button" :disabled="busy || locked || remoteChanged || left < 0 || !cart.length" @click="submit">{{ submitted ? "Resubmit" : "Confirm" }} {{ teamName }}</button>
          <button class="lobby-btn tt-tap" type="button" :disabled="busy || locked" @click="emit('skip', side)">No inducements</button>
        </div>
      </aside>
    </div>
  </section>
</template>
