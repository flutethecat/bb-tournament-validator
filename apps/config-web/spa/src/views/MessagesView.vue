<script setup lang="ts">
// Messages page (/app/messages, /app/messages/:id; spec §4.4-4.5): the conversation list and a New message box on the
// left with Messages settings (the Blocked list) under them; the open thread on the right (bubbles in seat colours,
// composer). In-site only: nothing is sent by email or Discord. Text is plain and rendered as text. A phone shows the
// list, or the thread with a Back link. ?to=<coach> opens a new conversation with that coach.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import { NOTIFICATIONS_KEY } from "../home/notifications";
import {
  fixtureRoute, MESSAGE_MAX_CHARS, MESSAGES_KEY, messagesPath, shortDate, socialApi, useSocialActions,
  type BlockRow, type FriendsResponse, type ThreadResponse, type ThreadSummary,
} from "../home/social";
import SocialAvatar from "../components/SocialAvatar.vue";
import SocialCoachRow, { type SocialAction } from "../components/SocialCoachRow.vue";
import SocialBlockDialog from "../components/SocialBlockDialog.vue";
import "../home/social.css";
import { shown } from "../shared/profanity";

const POLL_MS = 30_000;
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const messages = inject(MESSAGES_KEY)!;
const notifications = inject(NOTIFICATIONS_KEY)!;
const route = useRoute();
const router = useRouter();
const canWrite = computed(() => writesAllowed(session));

const threadId = computed(() => (typeof route.params.id === "string" && route.params.id ? route.params.id : ""));
const toCoach = computed(() => (typeof route.query.to === "string" ? route.query.to.trim().slice(0, 40) : ""));
const open = computed(() => Boolean(threadId.value || toCoach.value));

const threads = ref<ThreadSummary[] | null>(null);
const listError = ref("");
const blocked = ref<BlockRow[]>([]);
const friends = ref<FriendsResponse | null>(null);
const current = ref<ThreadResponse | null>(null);
const threadError = ref("");
const loadingOlder = ref(false);

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function loadList(): Promise<void> {
  try {
    const res = await socialApi.threads(fetcher);
    threads.value = res.threads;
    messages.set(res.unread);
    listError.value = "";
  } catch (e) { listError.value = (e as Error).message; }
}
async function loadSide(): Promise<void> {
  try { blocked.value = (await socialApi.blocks(fetcher)).blocked; } catch { /* the panel shows the last list */ }
  try { friends.value = await socialApi.friends(fetcher); } catch { /* relation unknown: no Add friend button */ }
}
async function loadThread(scroll = true): Promise<void> {
  const id = threadId.value;
  if (!id) { current.value = null; threadError.value = ""; return; }
  try {
    const res = await socialApi.thread(fetcher, id);
    if (threadId.value !== id) return;
    const grew = !current.value || current.value.thread.id !== id || res.messages.at(-1)?.id !== current.value.messages.at(-1)?.id;
    current.value = res;
    threadError.value = "";
    // Read up to the last message this screen now shows; anything that arrives later stays unread.
    const shown = res.messages.at(-1)?.id ?? 0;
    if (canWrite.value && shown > 0 && threads.value?.find((t) => t.id === id)?.unread !== 0) {
      try {
        const left = (await socialApi.read(fetcher, id, shown)).unread;
        messages.set(left);
        void loadList();
      } catch { /* stays unread */ }
    }
    if (scroll && grew) void scrollToEnd();
  } catch (e) { current.value = null; threadError.value = (e as Error).message; }
}
async function loadOlder(): Promise<void> {
  const c = current.value;
  if (!c || !c.messages.length || loadingOlder.value) return;
  loadingOlder.value = true;
  try {
    const res = await socialApi.thread(fetcher, c.thread.id, c.messages[0]!.id);
    if (current.value?.thread.id === c.thread.id) current.value = { ...current.value, messages: [...res.messages, ...current.value.messages], more: res.more };
  } catch (e) { threadError.value = (e as Error).message; }
  finally { loadingOlder.value = false; }
}

const bubbles = ref<HTMLElement | null>(null);
async function scrollToEnd(): Promise<void> {
  await nextTick();
  if (bubbles.value) bubbles.value.scrollTop = bubbles.value.scrollHeight;
}

// ---- the open conversation ----
const partner = computed(() => current.value?.thread.with ?? (threadId.value ? "" : toCoach.value));
const relation = computed<"friend" | "incoming" | "outgoing" | "none" | "unknown">(() => {
  const f = friends.value;
  const p = partner.value;
  if (!f || !p) return "unknown";
  if (f.friends.some((x) => same(x.coach, p))) return "friend";
  if (f.incoming.some((x) => same(x.coach, p))) return "incoming";
  if (f.outgoing.some((x) => same(x.coach, p))) return "outgoing";
  return "none";
});
const isBlocked = computed(() => Boolean(partner.value) && blocked.value.some((b) => same(b.coach, partner.value)));
const deleted = computed(() => current.value?.thread.deleted === true);
const canSend = computed(() => canWrite.value && (threadId.value ? current.value?.thread.canSend === true : Boolean(toCoach.value) && !isBlocked.value));
const reason = computed(() => {
  if (!canWrite.value) return "Test sign-in sessions can read messages but not send them.";
  if (threadId.value) return current.value && !current.value.thread.canSend ? current.value.thread.reason ?? "" : "";
  return isBlocked.value ? "You blocked this coach. Unblock them to send a message." : "";
});

const text = ref("");
const sending = ref(false);
const sendError = ref("");
const length = computed(() => [...text.value].length);
const over = computed(() => length.value > MESSAGE_MAX_CHARS);
async function send(): Promise<void> {
  const body = text.value;
  if (sending.value || !body.trim() || over.value || !canSend.value) return;
  sending.value = true;
  sendError.value = "";
  try {
    if (threadId.value) {
      const res = await socialApi.send(fetcher, threadId.value, body);
      text.value = "";
      if (current.value) current.value = { ...current.value, messages: [...current.value.messages, res.message] };
      void scrollToEnd();
    } else {
      const res = await socialApi.start(fetcher, toCoach.value, body);
      text.value = "";
      await router.replace(messagesPath(res.thread.id));
    }
    void loadList();
  } catch (e) { sendError.value = (e as Error).message; }
  finally { sending.value = false; }
}
function onComposeKey(e: KeyboardEvent): void {
  // Ctrl/Cmd+Enter sends; Enter alone is a new line.
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
}

// ---- new message ----
const newName = ref("");
const newError = ref("");
async function startNew(): Promise<void> {
  const name = newName.value.trim();
  newError.value = "";
  if (!name) { newError.value = "Type a coach name."; return; }
  const existing = threads.value?.find((t) => !t.deleted && same(t.with, name));
  newName.value = "";
  if (existing) await router.push(messagesPath(existing.id));
  else await router.push({ path: messagesPath(), query: { to: name } });
}
const suggestions = computed(() => {
  const f = friends.value;
  if (!f) return [];
  return [...f.friends.map((x) => x.coach), ...f.known.map((x) => x.coach)].slice(0, 50);
});

// ---- row actions (Add friend, Block, Unblock) ----
const actions = useSocialActions(fetcher, async () => { await loadSide(); await loadThread(false); });
function act(action: SocialAction, coach: string): void {
  if (action === "unblock") void actions.unblock(coach);
  else if (action === "block") actions.askBlock(coach);
  else if (action === "add") void actions.add(coach);
  else if (action === "accept") void actions.accept(coach);
}

// A ?to= coach that already has a conversation opens it instead.
watch([toCoach, threads], ([to, list]) => {
  if (!threadId.value && to && list) {
    const existing = list.find((t) => !t.deleted && same(t.with, to));
    if (existing) void router.replace(messagesPath(existing.id));
  }
});
watch(threadId, () => { sendError.value = ""; void loadThread(); });
watch(() => notifications.unread.value, () => { void loadList(); void loadThread(); });

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void loadList();
  void loadSide();
  void loadThread();
  timer = setInterval(() => { void loadList(); void loadThread(); }, POLL_MS);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div class="so-page sf-fit" :data-open="open ? 'true' : 'false'">
    <div class="so-side sf-scroll sf-col">
      <section class="hm-panel" aria-labelledby="so-threads-h">
        <header class="hm-band"><h2 id="so-threads-h">Conversations</h2><span class="hm-cap">{{ messages.unread.value }} unread</span></header>
        <form v-if="canWrite" class="so-new" @submit.prevent="startNew">
          <label class="sf-k" for="so-new-name">New message to</label>
          <div class="so-new-row">
            <input id="so-new-name" v-model="newName" class="sf-input" list="so-new-list" maxlength="40" autocomplete="off" placeholder="Coach name" />
            <datalist id="so-new-list"><option v-for="s in suggestions" :key="s" :value="s" /></datalist>
            <button type="submit" class="sf-btn primary">Write</button>
          </div>
          <p v-if="newError" class="sf-error" role="alert">{{ newError }}</p>
        </form>
        <p v-if="listError" class="sf-error">{{ listError }}</p>
        <p v-else-if="!threads" class="hm-empty">Loading…</p>
        <p v-else-if="!threads.length" class="hm-empty">No messages yet.</p>
        <ul v-else class="so-threads" aria-label="Conversations">
          <li v-for="t in threads" :key="t.id">
            <RouterLink
              class="so-thread" :to="messagesPath(t.id)" :aria-current="t.id === threadId ? 'page' : undefined"
              :data-unread="t.unread ? 'true' : undefined" :data-deleted="t.deleted ? 'true' : undefined"
            >
              <SocialAvatar :name="t.with" :avatar="t.avatar" :deleted="t.deleted" />
              <span class="so-who">
                <strong>{{ t.with }}</strong>
                <small class="so-sub">{{ t.lastFromMe ? "You: " : "" }}{{ shown(t.preview) }}</small>
              </span>
              <span class="so-meta">
                <time :datetime="t.lastAt">{{ shortDate(t.lastAt) }}</time>
                <span v-if="t.organiser" class="sf-chip so-chip-org">Organiser</span>
                <span v-if="t.unread" class="so-dot" :aria-label="`${t.unread} unread`">{{ t.unread }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </section>

      <section id="blocked" class="hm-panel" aria-labelledby="so-blocked-h">
        <header class="hm-band"><h2 id="so-blocked-h">Blocked</h2><span class="hm-cap">Messages settings</span></header>
        <p v-if="!blocked.length" class="hm-empty">You haven't blocked anyone.</p>
        <ul v-else class="so-list" aria-label="Blocked coaches">
          <li v-for="b in blocked" :key="b.coach">
            <SocialCoachRow :coach="b.coach" :avatar="b.avatar" :sub="`Blocked ${shortDate(b.at)}`" :primary="['unblock']" :busy="actions.busy.value" :disabled="!canWrite" @act="act" />
          </li>
        </ul>
        <p class="hm-small hm-empty so-status">A blocked coach can't message you or send you friend requests.</p>
      </section>
    </div>

    <section class="hm-panel so-convo" aria-labelledby="so-thread-h">
      <header class="hm-band">
        <h2 id="so-thread-h">{{ open ? "Conversation" : "Messages" }}</h2>
        <RouterLink class="sf-btn small so-back" :to="messagesPath()">Back</RouterLink>
      </header>
      <template v-if="!open">
        <p class="hm-empty">Pick a conversation, or write to a coach by name.</p>
      </template>
      <template v-else-if="threadError">
        <p class="sf-error" role="alert">{{ threadError }}</p>
      </template>
      <template v-else-if="threadId && !current">
        <p class="hm-empty">Loading…</p>
      </template>
      <template v-else>
        <div class="so-convo-head">
          <SocialAvatar :name="partner" :avatar="current?.thread.avatar ?? null" :deleted="deleted" big />
          <span class="so-who">
            <span class="so-name">{{ partner }}</span>
            <small v-if="deleted" class="so-sub">This account was deleted.</small>
            <small v-else-if="relation === 'friend'" class="so-sub">Friend</small>
            <small v-else-if="relation === 'outgoing'" class="so-sub">Friend request sent</small>
          </span>
          <span v-if="current?.thread.organiser" class="sf-chip so-chip-org">Organiser</span>
          <span v-if="!deleted && canWrite" class="so-acts">
            <button v-if="relation === 'none' && !isBlocked" type="button" class="sf-btn small" :disabled="Boolean(actions.busy.value)" @click="act('add', partner)">Add friend</button>
            <button v-if="relation === 'incoming' && !isBlocked" type="button" class="sf-btn small primary" :disabled="Boolean(actions.busy.value)" @click="act('accept', partner)">Accept friend</button>
            <button v-if="isBlocked" type="button" class="sf-btn small" :disabled="Boolean(actions.busy.value)" @click="act('unblock', partner)">Unblock</button>
            <button v-else type="button" class="sf-btn small" data-act="block" :disabled="Boolean(actions.busy.value)" @click="act('block', partner)">Block</button>
          </span>
        </div>
        <p v-if="actions.error.value" class="sf-error so-status" role="alert">{{ actions.error.value }}</p>
        <p v-else-if="actions.notice.value" class="sf-notice so-status" role="status">{{ actions.notice.value }}</p>

        <ul ref="bubbles" class="so-bubbles" aria-label="Messages" aria-live="polite">
          <li v-if="current?.more" class="so-more-older"><button type="button" class="sf-btn small" :disabled="loadingOlder" @click="loadOlder">{{ loadingOlder ? "Loading…" : "Older messages" }}</button></li>
          <li v-if="!current?.messages.length" class="hm-empty">No messages yet. Say hello.</li>
          <li
            v-for="m in current?.messages ?? []" :key="m.id" class="so-bubble"
            :data-mine="m.mine ? 'true' : undefined" :data-organiser="m.organiser ? 'true' : undefined"
          >
            <span v-if="m.organiser" class="so-org">Organiser · {{ m.organiser.name }}</span>
            <span v-if="m.fixture" class="so-org" data-fixture-context>Fixture · <RouterLink v-if="fixtureRoute(m.fixture.link)" :to="fixtureRoute(m.fixture.link)">{{ shown(m.fixture.title) }}</RouterLink><template v-else>{{ shown(m.fixture.title) }}</template></span>
            <p class="so-text">{{ shown(m.text) }}</p>
            <time class="so-when" :datetime="m.at">{{ m.mine ? "You" : m.from }} · {{ shortDate(m.at) }}</time>
          </li>
        </ul>

        <form class="so-compose" @submit.prevent="send">
          <label class="sf-k" for="so-compose-text">Message</label>
          <textarea
            id="so-compose-text" v-model="text" class="sf-input" rows="3" :maxlength="MESSAGE_MAX_CHARS" :disabled="!canSend || sending"
            :placeholder="canSend ? `Write to ${partner}` : ''" aria-describedby="so-compose-count" @keydown="onComposeKey"
          ></textarea>
          <p v-if="reason" class="so-reason">{{ reason }}</p>
          <p v-if="sendError" class="sf-error" role="alert">{{ sendError }}</p>
          <div class="so-compose-foot">
            <span id="so-compose-count" class="so-count" :data-over="over ? 'true' : undefined">{{ length }} / {{ MESSAGE_MAX_CHARS }}</span>
            <button type="submit" class="sf-btn primary" :disabled="!canSend || sending || !text.trim() || over">{{ sending ? "Sending…" : "Send" }}</button>
          </div>
        </form>
      </template>
      <SocialBlockDialog
        v-if="actions.blockTarget.value" :coach="actions.blockTarget.value" :busy="actions.busy.value.startsWith('block:')" :error="actions.error.value"
        @close="actions.blockTarget.value = ''" @confirm="actions.confirmBlock()"
      />
    </section>
  </div>
</template>
