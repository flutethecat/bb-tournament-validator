<script setup lang="ts">
// League page, Teams tab, a team's roster, organisers and site admins (owner 10-31): what the team's coach shares with this
// league's organisers (GET /api/leagues/:id/members/:coach/contact): preferred name / email / phones only when the coach
// ticked them, "Not shared" otherwise; "Not joined yet" until the coach answers the league notice.
import { inject, onMounted, ref, watch } from "vue";
import { API_KEY } from "../app";
import { ApiError, api } from "../shared/api";

interface MemberContact { coach: string; preferredName?: string; email?: string; phones?: Array<{ number: string; label?: string }> }

const props = defineProps<{ leagueId: string; coach: string }>();
const fetcher = inject(API_KEY, api);
const status = ref<"loading" | "ok" | "absent" | "error">("loading");
const lines = ref<string[]>([]);

async function load(): Promise<void> {
  status.value = "loading";
  lines.value = [];
  try {
    const res = await fetcher<{ contact?: MemberContact }>(`/api/leagues/${encodeURIComponent(props.leagueId)}/members/${encodeURIComponent(props.coach)}/contact`);
    const c = res.contact;
    lines.value = c ? [
      ...(c.preferredName ? [c.preferredName] : []),
      ...(c.email ? [c.email] : []),
      ...(c.phones ?? []).map((p) => (p.label ? `${p.number} (${p.label})` : p.number)),
    ] : [];
    status.value = "ok";
  } catch (e) {
    status.value = e instanceof ApiError && e.status === 404 ? "absent" : "error";
  }
}
watch(() => `${props.leagueId}|${props.coach}`, () => void load());
onMounted(() => void load());
</script>

<template>
  <p class="hm-small lg-member-contact" data-member-contact>
    <span class="muted">Shared with organisers: </span>
    <template v-if="status === 'loading'">…</template>
    <template v-else-if="status === 'absent'"><span class="muted">Not joined yet</span></template>
    <template v-else-if="status === 'error'"><span class="muted">Can't load</span></template>
    <template v-else-if="lines.length">{{ lines.join(" · ") }}</template>
    <template v-else><span class="muted">Not shared</span></template>
  </p>
</template>
