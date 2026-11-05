<script setup lang="ts">
// Admin console v2 (/app/admin/:section, owner 11-04, spec-admin-console-v2-2026-11-04): the section header band (name,
// Admin role chip, the section tabs) over one section. Site admins only: the router shows the 403 page to anyone else and
// every server route checks again. Each section loads its own data.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { ADMIN_SECTIONS, type AdminSectionId } from "../admin/model";
import { useSectionTitle } from "../shell/pageTitle";
import AdminOverview from "../admin/AdminOverview.vue";
import AdminUsers from "../admin/AdminUsers.vue";
import AdminTeams from "../admin/AdminTeams.vue";
import AdminGames from "../admin/AdminGames.vue";
import AdminReports from "../admin/AdminReports.vue";
import AdminModeration from "../admin/AdminModeration.vue";
import AdminOrganisers from "../admin/AdminOrganisers.vue";
import AdminPrivacyJobs from "../admin/AdminPrivacyJobs.vue";
import AdminOperations from "../admin/AdminOperations.vue";
import "../shell/section.css";
import "../admin/admin.css";

const props = defineProps<{ section: string }>();
useSectionTitle();
const active = computed(() => (ADMIN_SECTIONS.some((s) => s.id === props.section) ? props.section : "overview") as AdminSectionId);
const VIEWS = {
  overview: AdminOverview, users: AdminUsers, teams: AdminTeams, games: AdminGames, reports: AdminReports,
  moderation: AdminModeration, organisers: AdminOrganisers, "privacy-jobs": AdminPrivacyJobs, operations: AdminOperations,
} as const;
const view = computed(() => VIEWS[active.value]);
</script>

<template>
  <div class="hm-page sf-fit adm" :data-section="active">
    <header class="sh adm-sh" data-section="admin">
      <div class="sh-row">
        <div class="sh-id">
          <span class="sh-logo sh-logo-blank" aria-hidden="true">SF</span>
          <h2 class="sh-name">Admin console</h2>
        </div>
        <nav class="sf-tabs sh-tabs" aria-label="Admin sections">
          <RouterLink
            v-for="s in ADMIN_SECTIONS" :key="s.id" class="sf-tab" :data-tab="s.id" :to="{ name: 'admin', params: { section: s.id } }"
            :aria-current="active === s.id ? 'page' : undefined"
          >{{ s.label }}</RouterLink>
        </nav>
        <div class="sh-act"><span class="sf-chip sh-role" data-tone="info" data-role="admin">Admin</span></div>
      </div>
    </header>
    <component :is="view" class="sf-fill" />
  </div>
</template>
