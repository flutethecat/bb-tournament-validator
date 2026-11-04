<script setup lang="ts">
// Site search (owner 11-04, round 2 item 7): the search bar at the top right of the header, next to the account control.
// Typing shows quick results grouped by Leagues, Tournaments, Clubs, Coaches and Teams, plus "See all results" (the
// Search page). Keyboard: "/" focuses it, Up / Down move through the results, Enter opens one (or the Search page when
// none is highlighted), Escape closes. Below 900 px wide it is an icon that opens a full-width search sheet.
// The results are the server's (GET /api/search): drafts reach only their organisers, coaches show a name and avatar.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { typingTarget } from "../home/shell";
import { SESSION_KEY } from "../session";
import {
  createQuickResults, filledGroups, flatItems, initialsOf, isSlashShortcut, moveActive, optionId, QUERY_MAX, QUICK_DELAY_MS, safeImage, searchPageLink,
  TYPE_LABEL, type SearchItem,
} from "../search/search";
import "../search/search.css";

const api = inject(API_KEY)!;
const session = inject(SESSION_KEY, null);
/** Who the results were fetched for: results (which can hold drafts) never outlive a sign-out or a change of coach. */
const viewer = computed(() => session?.coach() ?? "");
const route = useRoute();
const router = useRouter();

const q = ref("");
// Quick results keyed by viewer (search/search.ts): an answer for another coach, or one still in flight when the coach
// signs out or changes, is never shown.
const quick = createQuickResults({ api, viewer: () => viewer.value });
const res = computed(() => quick.results());
const loading = computed(() => quick.state.loading);
const error = computed(() => quick.state.error);
const open = ref(false);
const sheet = ref(false);
const active = ref(-1);
const root = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const iconBtn = ref<HTMLButtonElement | null>(null);

const groups = computed(() => filledGroups(res.value));
const items = computed(() => flatItems(res.value));
const activeItem = computed(() => (active.value >= 0 ? items.value[active.value] : undefined));
const listId = "ss-list";
const showPanel = computed(() => open.value && q.value.trim() !== "");
const indexOf = (item: SearchItem) => items.value.indexOf(item);

let timer: ReturnType<typeof setTimeout> | undefined;
async function run(text: string): Promise<void> {
  if (await quick.run(text)) active.value = -1;
}
watch(q, (v) => {
  if (timer) clearTimeout(timer);
  open.value = true;
  timer = setTimeout(() => void run(v), QUICK_DELAY_MS);
});

function close(): void { open.value = false; active.value = -1; }
function closeSheet(focusIcon = true): void {
  close();
  if (!sheet.value) return;
  sheet.value = false;
  if (focusIcon) void nextTick(() => iconBtn.value?.focus({ preventScroll: true }));
}
function go(item: SearchItem): void {
  closeSheet(false);
  input.value?.blur();
  void router.push(item.url);
}
function seeAll(): void {
  const text = q.value.trim();
  closeSheet(false);
  input.value?.blur();
  void router.push(searchPageLink(text));
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!items.value.length) return;
    e.preventDefault();
    open.value = true;
    active.value = moveActive(active.value, e.key === "ArrowDown" ? 1 : -1, items.value.length);
    void nextTick(() => document.getElementById(activeItem.value ? optionId("ss", activeItem.value) : "")?.scrollIntoView?.({ block: "nearest" }));
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (activeItem.value) go(activeItem.value);
    else if (q.value.trim()) seeAll();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (showPanel.value) close();
    else if (sheet.value) closeSheet();
    else input.value?.blur();
  }
}

let narrowQuery: MediaQueryList | undefined;
async function openSheet(): Promise<void> {
  sheet.value = true;
  open.value = true;
  await nextTick();
  input.value?.focus({ preventScroll: true });
}
function onGlobalKey(e: KeyboardEvent): void {
  if (!isSlashShortcut(e, typingTarget(e.target))) return;
  e.preventDefault();
  if (narrowQuery?.matches) void openSheet();
  else { input.value?.focus({ preventScroll: true }); input.value?.select(); open.value = true; }
}
function onPointer(e: PointerEvent): void {
  if (sheet.value) return;
  if (root.value && e.target instanceof Node && !root.value.contains(e.target)) close();
}
onMounted(() => {
  narrowQuery = window.matchMedia?.("(max-width: 899.98px)");
  window.addEventListener("keydown", onGlobalKey);
  document.addEventListener("pointerdown", onPointer);
});
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  window.removeEventListener("keydown", onGlobalKey);
  document.removeEventListener("pointerdown", onPointer);
});
watch(() => route.fullPath, () => closeSheet(false));
// Sign-out or another coach: drop the results and the query, and ignore any answer still in flight.
watch(viewer, () => {
  if (timer) clearTimeout(timer);
  quick.reset();
  q.value = "";
  close();
});
// The sheet is a modal on phones: Tab stays inside it.
function onSheetTab(e: KeyboardEvent): void {
  if (!sheet.value || e.key !== "Tab" || !root.value) return;
  const els = Array.from(root.value.querySelectorAll<HTMLElement>(".ss-bar input, .ss-bar button, .ss-bar a[href]")).filter((el) => el.offsetParent !== null);
  if (!els.length) return;
  const first = els[0]!;
  const last = els[els.length - 1]!;
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
</script>

<template>
  <div ref="root" class="ss" :data-sheet="sheet ? 'true' : 'false'" @keydown="onSheetTab">
    <button ref="iconBtn" class="ss-icon" type="button" aria-label="Search the site (/)" :aria-expanded="sheet ? 'true' : 'false'" aria-controls="ss-bar" @click="openSheet">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4" /><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" /></svg>
    </button>
    <div id="ss-bar" class="ss-bar" :role="sheet ? 'dialog' : 'search'" :aria-modal="sheet ? 'true' : undefined" :aria-label="sheet ? 'Search the site' : undefined">
      <div class="ss-field">
        <svg class="ss-glass" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4" /><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" /></svg>
        <input
          ref="input" v-model="q" class="ss-input" type="search" name="q" :maxlength="QUERY_MAX" autocomplete="off" spellcheck="false"
          placeholder="Search leagues, coaches, teams..." aria-label="Search the site" role="combobox" aria-autocomplete="list"
          :aria-expanded="showPanel ? 'true' : 'false'" :aria-controls="listId"
          :aria-activedescendant="activeItem ? optionId('ss', activeItem) : undefined"
          @focus="open = true" @keydown="onKeydown"
        />
        <kbd class="ss-kbd" aria-hidden="true">/</kbd>
        <button v-if="sheet" class="sf-btn small ss-close" type="button" @click="closeSheet()">Close</button>
      </div>
      <div v-show="showPanel" class="ss-panel" @pointerdown.prevent>
        <p class="ss-status" role="status" aria-live="polite">
          <template v-if="error">{{ error }}</template>
          <template v-else-if="loading && !res">Searching...</template>
          <template v-else-if="res && !items.length">No results for '{{ q.trim() }}'.</template>
          <template v-else-if="res">{{ items.length }} quick {{ items.length === 1 ? "result" : "results" }}</template>
        </p>
        <ul :id="listId" class="ss-list" role="listbox" aria-label="Quick results">
          <template v-for="g in groups" :key="g.type">
            <li class="ss-group" role="presentation" :data-group="g.type">
              <span class="ss-group-h">{{ TYPE_LABEL[g.type] }}</span>
              <span class="ss-group-n">{{ g.group.total }}</span>
            </li>
            <li
              v-for="item in g.group.items" :id="optionId('ss', item)" :key="`${item.type}:${item.id}`" class="ss-opt" role="option"
              :aria-selected="activeItem === item ? 'true' : 'false'" :data-type="item.type" @click="go(item)" @mousemove="active = indexOf(item)"
            >
              <img v-if="safeImage(item.image)" class="ss-img" :data-round="item.type === 'coaches' ? 'true' : undefined" :src="safeImage(item.image)" alt="" width="32" height="32" loading="lazy" referrerpolicy="no-referrer" />
              <span v-else class="ss-img ss-img-blank" :data-round="item.type === 'coaches' ? 'true' : undefined" aria-hidden="true">{{ initialsOf(item.title) }}</span>
              <span class="ss-text">
                <span class="ss-title">{{ item.title }}<span v-if="item.draft" class="sf-chip ss-draft" data-tone="muted">Draft</span></span>
                <span v-if="item.subtitle" class="ss-sub">{{ item.subtitle }}</span>
              </span>
              <span v-if="item.matched" class="ss-matched">{{ item.matched }}</span>
            </li>
          </template>
        </ul>
        <RouterLink class="ss-all" :to="searchPageLink(q)" data-action="see-all" @click="closeSheet(false)">See all results<template v-if="q.trim()"> for '{{ q.trim() }}'</template></RouterLink>
      </div>
    </div>
  </div>
</template>
