<script setup lang="ts">
// Fixture lobby, an inducements panel (spec §8 LEFT/RIGHT BOTTOM, §9, §9.1): the menu panel with expandable category
// rows (icon tile, name, cap caption, count, caret; expanded rows carry a -/n/+ stepper), the budget caption, and the
// footer (Auto-Buy for the underdog, Save / Lock). The opponent's panel is read-only: their options until their picks
// are revealed (both locked, or the overdog's final list once START held). Budgets, reveal and holds come from the server.
// Tournaments: inducements bought in the Builder sit on top, pre-filled and non-removable (paid from the roster's gold).
import { computed, inject, ref, watch } from "vue";
import { draftTotal, FIXTURE_LOBBY_KEY, kGold, otherSide, type LobbyMenuCategory, type LobbySide, type LobbyView } from "../leagues/lobby";

// `embedded`: inside the fixture summary's Inducements pane (its band and side tabs above): no panel or band of its own.
const props = defineProps<{ view: LobbyView; side: LobbySide; embedded?: boolean }>();
const lobby = inject(FIXTURE_LOBBY_KEY)!;
const s = computed(() => props.view.sides[props.side]);
const ind = computed(() => s.value.inducements);
const own = computed(() => props.view.viewer.role === props.side);
const live = computed(() => props.view.open && !props.view.started && props.view.inducements.step);
const editable = computed(() => own.value && live.value && ind.value.hasStep && !ind.value.locked);
const held = computed(() => props.view.hold && props.view.hold.underdog === props.side ? props.view.hold : null);
const isUnderdog = computed(() => props.view.inducements.underdog === props.side);
const draft = computed(() => lobby.state.draft);
const spent = computed(() => (editable.value ? draftTotal(ind.value.menu, draft.value) : (ind.value.total ?? 0)));
const left = computed(() => ind.value.budget.limit - spent.value);
const busy = computed(() => lobby.state.busy !== "");
const title = computed(() => (own.value ? "Your inducements" : `${s.value.coach || "Opponent"}'s inducements`));

const caption = computed(() => {
  if (!props.view.inducements.step) return "No inducement step";
  const b = ind.value.budget;
  if (!own.value) {
    if (!ind.value.hasStep) return b.role === "overdog" ? "No treasury spending" : "Nothing to buy";
    if (ind.value.locked) return ind.value.visible ? `Locked · ${ind.value.picks?.length ?? 0} picked` : "Locked · hidden until both lock";
    return "Not locked · browsing their options";
  }
  if (!ind.value.hasStep) return b.role === "overdog" ? "No treasury spending here" : "Nothing to buy";
  if (b.role === "overdog") return `Treasury ${kGold(b.treasury)} · ${kGold(Math.max(0, left.value))} left`;
  return `Petty cash ${kGold(b.pettyCash)} · ${kGold(Math.max(0, left.value))} left`;
});

const open = ref<Set<string>>(new Set());
const toggle = (id: string): void => {
  const next = new Set(open.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  open.value = next;
};
// the underdog kicked back by a hold sees the menu open
watch(held, (h) => { if (h && own.value) open.value = new Set(ind.value.menu.filter((c) => c.items.length).map((c) => c.id)); }, { immediate: true });

const prefilled = computed(() => ind.value.prefilled ?? []);
const countOf = (c: LobbyMenuCategory): number => c.items.reduce((n, i) => n + (i.prefilled ?? 0) + (editable.value ? (draft.value[i.id] ?? 0) : (ind.value.picks?.find((p) => p.id === i.id)?.qty ?? 0)), 0);
const countCaption = (c: LobbyMenuCategory): string => {
  if (!c.items.length) return c.off.length ? c.off[0]!.reason : "None";
  if (editable.value || (ind.value.visible && ind.value.picks)) return c.cap ? `${countOf(c)} of ${c.cap}` : `${countOf(c)} picked`;
  return `${c.items.length} options`;
};
const capCaption = (c: LobbyMenuCategory): string => (c.cap ? `0-${c.cap}` : c.items.length ? `0-${Math.max(...c.items.map((i) => i.max))}` : "");
const step = (id: string, by: number, max: number): void => { lobby.setCount(id, Math.min(max, Math.max(0, (draft.value[id] ?? 0) + by))); };
const starsFull = (c: LobbyMenuCategory): boolean => Boolean(c.cap && countOf(c) >= c.cap);
const lockReason = computed(() => {
  if (left.value < 0) return "Over budget: remove something to lock.";
  if (isUnderdog.value && !held.value && !ind.value.autoBuy) return "Turn on Auto-Buy to lock now, or pick when START is pressed.";
  return "";
});
const overdogNote = computed(() => {
  const over = props.view.inducements.overdog;
  if (!over || over !== props.side || own.value || !props.view.inducements.step) return "";
  const b = ind.value.budget;
  return b.topUpLimit ? `Overdog · treasury ${kGold(b.treasury)}. If they spend, ${props.view.viewer.role === otherSide(props.side) ? "your" : "the underdog's"} petty cash grows by the same amount.` : "Overdog · this ruleset allows no treasury spending.";
});
</script>

<template>
  <component :is="embedded ? 'div' : 'section'" :class="embedded ? 'fs-ind-body' : 'hm-panel fl-panel'" :aria-labelledby="embedded ? undefined : `fl-ind-${side}`" :data-side="side" data-panel="inducements">
    <header v-if="!embedded" class="hm-band" :data-seat="side">
      <h2 :id="`fl-ind-${side}`">{{ title }}</h2>
      <span class="hm-cap" :class="{ 'fl-cap-amber': own && ind.hasStep }">{{ caption }}</span>
    </header>
    <p v-else class="fs-ind-cap" :class="{ 'fl-amber': own && ind.hasStep }" data-ind-caption>{{ caption }}</p>
    <p v-if="held && own" class="fl-banner" role="status" data-hold><strong>Your pick</strong>{{ held.banner }} Adjust your list and lock it: START re-arms.</p>
    <p v-else-if="held && !own && view.viewer.role !== 'spectator'" class="fl-banner" role="status" data-hold><strong>Waiting</strong>Waiting for {{ s.coach }} to lock inducements.</p>
    <div v-if="prefilled.length" class="fl-prefilled" data-prefilled>
      <p class="fl-prefilled-head">Bought in the Builder</p>
      <ul class="fl-items" aria-label="Bought in the Builder">
        <li v-for="p in prefilled" :key="p.id" class="fl-item" data-prefilled-row>
          <span class="fl-item-name">{{ p.name }}<small>Already paid · can't be removed</small></span>
          <span class="fl-stepper" :aria-label="`${p.name}: ${p.qty} bought in the Builder`"><output>×{{ p.qty }}</output></span>
          <span class="sf-chip" data-tone="info">Builder</span>
        </li>
      </ul>
    </div>
    <p v-if="!view.inducements.step" class="fl-note">{{ view.inducements.reason }}</p>
    <template v-else>
      <ul v-if="ind.visible && ind.picks && !editable && ind.picks.length" class="fl-picked" aria-label="Picked inducements">
        <li v-for="p in ind.picks" :key="p.id"><span>{{ p.qty > 1 ? `${p.qty} × ` : "" }}{{ p.name }}</span><span class="fl-price">{{ kGold(p.cost) }}</span></li>
      </ul>
      <p v-else-if="ind.visible && ind.locked && !editable" class="fl-note">Nothing picked.</p>
      <div class="fl-menu">
        <div v-for="c in ind.menu" :key="c.id" class="fl-cat" :data-cat="c.id">
          <button
            type="button" class="fl-cat-head" :aria-expanded="open.has(c.id) ? 'true' : 'false'" :aria-disabled="c.items.length ? undefined : 'true'"
            :aria-controls="`fl-cat-${side}-${c.id}`" @click="c.items.length && toggle(c.id)"
          >
            <span class="fl-tile" aria-hidden="true"><img v-if="c.items[0]?.icon" :src="c.items[0]!.icon" alt="" width="22" height="22" /></span>
            <span class="fl-cat-name">{{ c.label }}<small>{{ capCaption(c) }}</small></span>
            <span class="fl-cat-count">{{ countCaption(c) }}</span>
            <span class="fl-caret" aria-hidden="true">{{ c.items.length ? (open.has(c.id) ? "▾" : "▸") : "" }}</span>
          </button>
          <ul v-if="open.has(c.id)" :id="`fl-cat-${side}-${c.id}`" class="fl-items">
            <li v-for="i in c.items" :key="i.id" class="fl-item">
              <span class="fl-item-name">{{ i.name }}<small v-if="i.prefilled">{{ i.prefilled }} from the Builder</small><small v-if="i.effect">{{ i.effect }}</small></span>
              <span v-if="editable" class="fl-stepper" role="group" :aria-label="`${i.name}: count`">
                <button type="button" :disabled="!(draft[i.id] ?? 0)" :aria-label="`One fewer ${i.name}`" @click="step(i.id, -1, i.max)">−</button>
                <output>{{ draft[i.id] ?? 0 }}</output>
                <button type="button" :disabled="(draft[i.id] ?? 0) >= i.max || (c.id === 'star' && starsFull(c) && !(draft[i.id] ?? 0))" :aria-label="`One more ${i.name}`" @click="step(i.id, 1, i.max)">+</button>
              </span>
              <span v-else class="fl-cat-count">0-{{ i.max }}</span>
              <span class="fl-price">{{ kGold(i.price) }}</span>
            </li>
            <li v-for="o in c.off" :key="o.id" class="fl-item" data-off>
              <span class="fl-item-name">{{ o.name }}</span><span class="fl-cat-count">{{ o.reason }}</span><span class="fl-price">-</span>
            </li>
          </ul>
        </div>
      </div>
      <div v-if="own && live && ind.hasStep" class="fl-ind-foot">
        <div v-if="isUnderdog && !held" class="fl-autobuy">
          <label><input type="checkbox" :checked="ind.autoBuy === true" :disabled="busy || ind.locked" @change="lobby.autoBuy(side, ($event.target as HTMLInputElement).checked)" />Auto-Buy</label>
          <small>Buy this list at the start if the overdog spends nothing.</small>
        </div>
        <template v-if="!ind.locked">
          <p v-if="lockReason" class="fl-note">{{ lockReason }}</p>
          <div class="sf-btn-row">
            <button type="button" class="sf-btn small" :disabled="busy || !lobby.state.dirty" @click="lobby.savePicks(side)">Save list</button>
            <button type="button" class="sf-btn small primary" :disabled="busy || Boolean(lockReason)" @click="lobby.lock(side)">Lock inducements</button>
          </div>
        </template>
        <p v-else class="fl-note">Locked{{ ind.autoBuy && !held ? " for Auto-Buy" : "" }}. Ask an organiser if you need to change it.</p>
      </div>
      <div v-if="view.viewer.organiser && !own && ind.locked && live" class="sf-btn-row fl-ind-foot">
        <button type="button" class="sf-btn small" :disabled="busy" @click="lobby.unlock(side)">Unlock (organiser)</button>
      </div>
      <p v-if="own && live && ind.hasStep && ind.budget.role === 'underdog' && ind.budget.topUpLimit" class="fl-note">Your treasury can add up to {{ kGold(ind.budget.topUpLimit) }} on top of petty cash.</p>
      <p v-if="overdogNote" class="fl-note fl-amber">{{ overdogNote }}</p>
    </template>
  </component>
</template>
