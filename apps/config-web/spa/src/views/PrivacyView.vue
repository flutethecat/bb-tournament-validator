<script setup lang="ts">
// Privacy notice (/app/privacy, spec-privacy-gdpr-2026-10-31 §1). Public. Plain-language sections; the "What we collect"
// table renders from privacy/inventory.ts (shared with the export lane), the contact block from GET /api/privacy/contact.
import { computed, inject, onMounted, onServerPrefetch, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { COLLECT_GROUPS, INVENTORY, PRIVACY_HOSTING, PRIVACY_LAST_UPDATED, type InventoryRow } from "../privacy/inventory";

interface Contact { controller: string | null; email: string | null; hosting: string; euRepresentative: string | null }

const fetcher = inject(API_KEY)!;
const contact = ref<Contact | null>(null);
const loaded = ref(false);

async function load(): Promise<void> {
  try { contact.value = await fetcher<Contact>("/api/privacy/contact"); } catch { contact.value = null; }
  loaded.value = true;
}
onMounted(() => { if (!loaded.value) void load(); });
onServerPrefetch(load);

const hosting = computed(() => contact.value?.hosting || PRIVACY_HOSTING);
const rowById = (id: string): InventoryRow | undefined => INVENTORY.find((r) => r.id === id);
const publicLabel = (r: InventoryRow): string => (r.public === "yes" ? "Yes" : r.public === "partly" ? "Partly" : "No");

const sections = [
  ["who", "Who we are"], ["collect", "What we collect"], ["why", "Why we use it"], ["public", "What is public"],
  ["share", "Who we share it with"], ["transfers", "International transfers"], ["keep", "How long we keep it"],
  ["rights", "Your rights"], ["cookies", "Cookies"], ["children", "Children"], ["changes", "Changes to this notice"],
] as const;
</script>

<template>
  <div class="hm-page pv-page">
    <section class="hm-panel" aria-labelledby="pv-h">
      <header class="hm-band"><h2 id="pv-h">Privacy notice</h2></header>
      <p class="pv-updated"><time :datetime="PRIVACY_LAST_UPDATED">Last updated {{ PRIVACY_LAST_UPDATED }}</time></p>
      <p>This is how Super FUMBBL uses your data, in plain language.</p>
      <nav aria-label="Sections" class="pv-toc">
        <template v-for="([id, title], i) in sections" :key="id"><span v-if="i > 0"> · </span><a :href="`#${id}`">{{ title }}</a></template>
      </nav>
    </section>

    <section id="who" class="hm-panel" aria-labelledby="pv-who-h">
      <header class="hm-band"><h2 id="pv-who-h">Who we are</h2></header>
      <p>Super FUMBBL is run by <strong v-if="contact?.controller">{{ contact.controller }}</strong><span v-else>the site's operator</span>, who decides how your data is used.</p>
      <p v-if="contact?.email">Contact: <a :href="`mailto:${contact.email}`">{{ contact.email }}</a></p>
      <p v-else>Contact: see the <RouterLink to="/help">Help page</RouterLink>.</p>
      <p>We will appoint a representative in the European Union when paid plans launch, and add them here.</p>
    </section>

    <section id="collect" class="hm-panel" aria-labelledby="pv-collect-h">
      <header class="hm-band"><h2 id="pv-collect-h">What we collect</h2></header>
      <ul class="hm-help">
        <li v-for="g in COLLECT_GROUPS" :key="g.title"><h3 class="hm-log-title">{{ g.title }}</h3><p>{{ g.text }}</p></li>
      </ul>
      <div class="pv-table-wrap">
        <table class="pv-table" data-testid="privacy-inventory">
          <caption class="pv-sr">Every place we keep personal data</caption>
          <thead><tr><th scope="col">Where</th><th scope="col">What</th><th scope="col">Why</th><th scope="col">Public?</th><th scope="col">How long</th></tr></thead>
          <tbody>
            <tr v-for="r in INVENTORY" :key="r.id" :data-row="r.id">
              <th scope="row"><code>{{ r.store }}</code></th>
              <td>{{ r.data }}</td>
              <td>{{ r.purpose }}</td>
              <td>{{ publicLabel(r) }}<span v-if="r.publicNote" class="pv-note"> {{ r.publicNote }}</span></td>
              <td>{{ r.retention }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section id="why" class="hm-panel" aria-labelledby="pv-why-h">
      <header class="hm-band"><h2 id="pv-why-h">Why we use it</h2></header>
      <ul class="hm-help">
        <li><h3 class="hm-log-title">To run your account and the services you use</h3><p>Signing in, rosters, teams, games, leagues and tournaments. Legal basis: contract.</p></li>
        <li><h3 class="hm-log-title">For public results and standings</h3><p>Game results, ratings and standings are a shared record for the community and organisers. Legal basis: legitimate interest. You have the right to object.</p></li>
        <li><h3 class="hm-log-title">For security and abuse prevention</h3><p>Rate limits, bans and keeping the site safe. Legal basis: legitimate interest. If a banned coach deletes their account we keep a hash of their Discord id so the ban holds.</p></li>
        <li><h3 class="hm-log-title">To let organisers contact you</h3><p>If you agree, the organisers of leagues and tournaments you join may contact you by email or phone. Legal basis: your consent. You can withdraw it at any time on the <RouterLink to="/account">Account page</RouterLink>. We also record that you accepted this notice when you signed up.</p></li>
        <li><h3 class="hm-log-title">Announcement emails</h3><p>We send none today. If we add them, they will be opt-in, and your consent is the legal basis.</p></li>
      </ul>
    </section>

    <section id="public" class="hm-panel" aria-labelledby="pv-public-h">
      <header class="hm-band"><h2 id="pv-public-h">What is public</h2></header>
      <p>Anyone can see your coach name, avatar, teams, rosters you share, your tournament and league participation, and your game results and ratings.</p>
      <p><strong>Your email, phone numbers and Discord ids are never public.</strong></p>
      <p>Your preferred name, contact email and phone numbers are visible only to the organisers of leagues and tournaments you joined, and only if you agreed to be contacted. They are deleted with your account.</p>
    </section>

    <section id="share" class="hm-panel" aria-labelledby="pv-share-h">
      <header class="hm-band"><h2 id="pv-share-h">Who we share it with</h2></header>
      <ul class="hm-help">
        <li><h3 class="hm-log-title">Discord</h3><p>You sign in with it, and a league's webhook posts that league's news to its Discord server.</p></li>
        <li><h3 class="hm-log-title">Our hosting provider</h3><p>It stores the data on our behalf.</p></li>
        <li><h3 class="hm-log-title">A mail provider</h3><p>Only if we add email. We will list it here first.</p></li>
      </ul>
      <p>We do not sell your data, show ads, or run analytics trackers.</p>
    </section>

    <section id="transfers" class="hm-panel" aria-labelledby="pv-transfers-h">
      <header class="hm-band"><h2 id="pv-transfers-h">International transfers</h2></header>
      <p>Our servers are in the {{ hosting }}. If you use the site from the UK or the EU, your data is sent there. Our processors handle it under standard contractual clauses.</p>
    </section>

    <section id="keep" class="hm-panel" aria-labelledby="pv-keep-h">
      <header class="hm-band"><h2 id="pv-keep-h">How long we keep it</h2></header>
      <ul class="hm-help">
        <li><h3 class="hm-log-title">Account data</h3><p>While your account exists. When you delete your account it is removed.</p></li>
        <li><h3 class="hm-log-title">Game history</h3><p>Results stay in league and tournament history, with your coach name replaced by "Deleted coach". We anonymise rather than erase so other people's records stay correct.</p></li>
        <li><h3 class="hm-log-title">Bug reports</h3><p>{{ rowById("bug-reports")?.retention }}</p></li>
        <li><h3 class="hm-log-title">Logs</h3><p>{{ rowById("logs")?.retention }}</p></li>
        <li><h3 class="hm-log-title">Sessions</h3><p>They expire after a period of inactivity, and always after a fixed maximum.</p></li>
      </ul>
    </section>

    <section id="rights" class="hm-panel" aria-labelledby="pv-rights-h">
      <header class="hm-band"><h2 id="pv-rights-h">Your rights</h2></header>
      <p>You can ask to see your data, get a copy, correct it, delete it, or object to how it is used. You can also complain to your local data protection authority.</p>
      <p>Use the <RouterLink to="/account">Account page</RouterLink> for your profile, export and deletion, or contact us<template v-if="contact?.email"> at <a :href="`mailto:${contact.email}`">{{ contact.email }}</a></template><template v-else> through the <RouterLink to="/help">Help page</RouterLink></template>. Your email comes from Discord, so change it there.</p>
    </section>

    <section id="cookies" class="hm-panel" aria-labelledby="pv-cookies-h">
      <header class="hm-band"><h2 id="pv-cookies-h">Cookies</h2></header>
      <p>One cookie that is strictly necessary: your session, which keeps you signed in. It is httpOnly and SameSite. Your browser's local storage keeps preferences such as the theme and navigation state. That is all, so there is no cookie banner.</p>
    </section>

    <section id="children" class="hm-panel" aria-labelledby="pv-children-h">
      <header class="hm-band"><h2 id="pv-children-h">Children</h2></header>
      <p>Super FUMBBL is not aimed at anyone under 16. Discord's own age rules apply to signing in.</p>
    </section>

    <section id="changes" class="hm-panel" aria-labelledby="pv-changes-h">
      <header class="hm-band"><h2 id="pv-changes-h">Changes to this notice</h2></header>
      <p>The date at the top shows the current version. We will announce material changes on the site.</p>
    </section>
  </div>
</template>

<style>
.pv-page { display: grid; gap: 16px; }
.pv-updated { margin: 0; color: var(--ui-muted); }
.pv-toc { margin: 8px 0 0; line-height: 1.8; }
.pv-table-wrap { overflow-x: auto; margin-top: 12px; }
.pv-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.pv-table th, .pv-table td { padding: 6px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--ui-border, rgba(128, 128, 128, .3)); }
.pv-table thead th { white-space: nowrap; }
.pv-note { color: var(--ui-muted); }
.pv-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.pv-small { margin: 6px 0 0; font-size: 12px; color: var(--ui-muted); }
.pv-small a { color: inherit; text-decoration: underline; }
</style>
