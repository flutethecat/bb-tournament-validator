<script setup lang="ts">
// Coach page Friends panel (spec §4.3): friend requests to answer, mutual friends, requests you sent, and People you
// know (coaches you played, from the results store, who are not friends yet). Friends are on for every coach (owner
// ruling 10-29 (a)); nobody is added without a request and an accept. GET /api/me/friends.
import { computed, inject, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import { messagesPath, shortDate, socialApi, useSocialActions, type FriendsResponse } from "../home/social";
import SocialCoachRow, { type SocialAction } from "./SocialCoachRow.vue";
import SocialBlockDialog from "./SocialBlockDialog.vue";
import "../home/social.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const router = useRouter();
const canWrite = computed(() => writesAllowed(session));

const data = ref<FriendsResponse | null>(null);
const loadError = ref("");
async function load(): Promise<void> {
  try { data.value = await socialApi.friends(fetcher); loadError.value = ""; } catch (e) { loadError.value = (e as Error).message; }
}
const actions = useSocialActions(fetcher, load);

const played = (at: string | null | undefined, games?: number) => {
  const d = shortDate(at);
  if (!d) return "";
  return games && games > 1 ? `Played ${games} times · last ${d}` : `Last played ${d}`;
};

function act(action: SocialAction, coach: string): void {
  if (action === "message") { void router.push({ path: messagesPath(), query: { to: coach } }); return; }
  if (action === "add") void actions.add(coach);
  else if (action === "accept") void actions.accept(coach);
  else if (action === "decline") void actions.decline(coach);
  else if (action === "cancel" || action === "remove") void actions.unfriend(coach);
  else if (action === "block") actions.askBlock(coach);
}

const count = computed(() => data.value?.friends.length ?? 0);
const empty = computed(() => {
  const d = data.value;
  return Boolean(d) && !d!.friends.length && !d!.incoming.length && !d!.outgoing.length && !d!.known.length;
});

onMounted(() => { void load(); });
</script>

<template>
  <section id="friends" class="hm-panel" aria-labelledby="hm-friends-h">
    <header class="hm-band"><h2 id="hm-friends-h">Friends</h2><span class="hm-cap">{{ count }}</span></header>
    <p v-if="loadError" class="sf-error">{{ loadError }}</p>
    <p v-else-if="!data" class="hm-empty">Loading…</p>
    <p v-else-if="empty" class="hm-empty">No friends yet. Coaches you play will show up here.</p>
    <div v-else class="so-panel-scroll">
      <template v-if="data.incoming.length">
        <h3 class="so-group">Requests ({{ data.incoming.length }})</h3>
        <ul class="so-list" aria-label="Friend requests">
          <li v-for="r in data.incoming" :key="`in:${r.coach}`">
            <SocialCoachRow :coach="r.coach" :avatar="r.avatar" sub="Wants to be friends" :primary="['accept', 'decline']" :more="['block']" :busy="actions.busy.value" :disabled="!canWrite" @act="act" />
          </li>
        </ul>
      </template>
      <template v-if="data.friends.length">
        <h3 class="so-group">Friends</h3>
        <ul class="so-list" aria-label="Friends">
          <li v-for="f in data.friends" :key="`f:${f.coach}`">
            <SocialCoachRow :coach="f.coach" :avatar="f.avatar" :sub="played(f.lastPlayed) || `Friends since ${shortDate(f.since)}`" :primary="['message']" :more="['remove', 'block']" :busy="actions.busy.value" :disabled="!canWrite" @act="act" />
          </li>
        </ul>
      </template>
      <template v-if="data.outgoing.length">
        <h3 class="so-group">Sent</h3>
        <ul class="so-list" aria-label="Friend requests you sent">
          <li v-for="r in data.outgoing" :key="`out:${r.coach}`">
            <SocialCoachRow :coach="r.coach" :avatar="r.avatar" sub="Request sent" :primary="['cancel']" :busy="actions.busy.value" :disabled="!canWrite" @act="act" />
          </li>
        </ul>
      </template>
      <template v-if="data.known.length">
        <h3 class="so-group">People you know</h3>
        <ul class="so-list" aria-label="People you know">
          <li v-for="k in data.known" :key="`k:${k.coach}`">
            <SocialCoachRow :coach="k.coach" :avatar="k.avatar" :sub="played(k.lastPlayed, k.games)" :primary="['add']" :more="['message', 'block']" :busy="actions.busy.value" :disabled="!canWrite" @act="act" />
          </li>
        </ul>
      </template>
    </div>
    <p v-if="actions.error.value" class="sf-error so-status" role="alert">{{ actions.error.value }}</p>
    <p v-else-if="actions.notice.value" class="sf-notice so-status" role="status">{{ actions.notice.value }}</p>
    <SocialBlockDialog
      v-if="actions.blockTarget.value" :coach="actions.blockTarget.value" :busy="actions.busy.value.startsWith('block:')" :error="actions.error.value"
      @close="actions.blockTarget.value = ''" @confirm="actions.confirmBlock()"
    />
  </section>
</template>
