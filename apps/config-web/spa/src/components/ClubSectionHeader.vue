<script setup lang="ts">
// The section header on the club pages (owner 11-02, Q14): crest, name, the home region and member count chips, the
// viewer's role (Admin / Member) and, for the club's admins (and site admins), the cog to the management sub-panel.
// Reads the club from the page's controller (CLUB_DETAIL_KEY).
import { computed, inject } from "vue";
import { useRoute } from "vue-router";
import SectionHeader from "./SectionHeader.vue";
import { CLUB_DETAIL_KEY, initialsOf } from "../clubs/clubs";
import { activeTab, clubFacts, manageLocation, visibleTabs, type SectionActive, type SectionChip, type SectionHeaderModel } from "../shell/sectionNav";

const props = defineProps<{ id: string; active?: SectionActive }>();
const detail = inject(CLUB_DETAIL_KEY)!;
const route = useRoute();

const model = computed<SectionHeaderModel | null>(() => {
  const page = detail.state.page;
  const club = page?.club;
  if (!club || club.id !== props.id) return null;
  const me = page.me;
  const admin = me?.role === "admin";
  const active = props.active ?? activeTab("club", route);
  const chips: SectionChip[] = [];
  if (club.homeRegion) chips.push({ label: club.homeRegion, tone: "muted", key: "region" });
  return {
    kind: "club",
    id: props.id,
    name: club.name,
    logo: club.crestUrl ?? "",
    initials: initialsOf(club.name),
    banner: "",
    status: club.archivedAt
      ? { label: "Archived", tone: "muted", key: "archived" }
      : { label: `${club.memberCount} ${club.memberCount === 1 ? "member" : "members"}`, tone: "info", key: "members" },
    chips,
    tabs: visibleTabs("club", props.id, clubFacts(), { active }),
    active,
    role: admin ? "admin" : me?.member ? "member" : "",
    manageTo: admin || me?.siteAdmin ? manageLocation("club", props.id) : undefined,
    crumbs: [],
  };
});
</script>

<template>
  <SectionHeader v-if="model" :model="model" />
</template>
