<script setup lang="ts">
// Help (/app/help): where to get help, in the coach page design. Public read.
import { RouterLink } from "vue-router";
</script>

<template>
  <div class="hm-page sf-fit sf-scroll sf-col">
    <section class="hm-panel" aria-labelledby="help-h">
      <header class="hm-band"><h2 id="help-h">Help</h2><span class="hm-cap">Where to ask</span></header>
      <ul class="hm-help">
        <li>
          <h3 class="hm-log-title">Ask on Discord</h3>
          <p>Super FUMBBL runs on Discord: you sign in with it, and the Super FUMBBL Discord server is the quickest place to
            ask a question, find an opponent or reach a tournament organiser.</p>
        </li>
        <li>
          <h3 class="hm-log-title">Report a bug</h3>
          <p>In the Super FUMBBL app, use the Report button during or after a game: it sends the game log (and a screenshot
            if you add one) straight to us. For a problem on this site, tell us on Discord what you clicked and what you saw.</p>
        </li>
        <li>
          <h3 class="hm-log-title">What's new</h3>
          <p>Every change to the site, newest first: <RouterLink to="/whats-new">What's new</RouterLink></p>
        </li>
        <li>
          <h3 class="hm-log-title">Rules questions</h3>
          <p>The Resources list in the sidebar links rules references and guides.</p>
        </li>
      </ul>
    </section>
  </div>
</template>
