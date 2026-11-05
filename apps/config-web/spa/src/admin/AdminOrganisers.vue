<script setup lang="ts">
// Admin console Organisers (owner 11-04): the organiser request queue and the all-tournaments list (owner, organisers,
// Set owner / Add / Remove organiser), side by side. Both are the existing admin views, moved here from their own pages
// (/app/admin/organiser-requests and /app/admin/tournaments now redirect to this section).
import AdminOrganiserRequestsView from "../views/AdminOrganiserRequestsView.vue";
import AdminTournamentsView from "../views/AdminTournamentsView.vue";
</script>

<template>
  <div class="adm-cols even">
    <div class="adm-col" data-pane="organiser-requests"><AdminOrganiserRequestsView /></div>
    <div class="adm-col" data-pane="tournaments"><AdminTournamentsView /></div>
  </div>
</template>
