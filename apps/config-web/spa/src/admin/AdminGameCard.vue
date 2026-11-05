<script setup lang="ts">
// One live fork game with the old console's controls: Close (ends it cleanly), Delete (removes the live row, confirmed),
// Concede home / away (the loss goes to that side). POST /api/fork/game/:id/(close|delete|concede).
import { inject, ref } from "vue";
import { API_KEY } from "../app";
import type { GameView } from "./model";

const props = defineProps<{ game: GameView }>();
const emit = defineEmits<{ done: [text: string] }>();
const fetcher = inject(API_KEY)!;
const busy = ref(false);
const error = ref("");
const confirmDelete = ref(false);

async function act(op: "close" | "delete" | "concede", teamId = ""): Promise<void> {
  if (busy.value) return;
  if (op === "concede" && !teamId) return void (error.value = `Game ${props.game.gameId} did not report a team ID for that side.`);
  busy.value = true;
  error.value = "";
  try {
    await fetcher(`/api/fork/game/${encodeURIComponent(props.game.gameId)}/${op}`, { method: "POST", body: teamId ? { teamId } : {} });
    emit("done", `${op[0]!.toUpperCase()}${op.slice(1)} completed for game ${props.game.gameId}.`);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
    confirmDelete.value = false;
  }
}
</script>

<template>
  <article class="hm-panel adm-game" :data-game="game.gameId">
    <header class="hm-band" data-tone="admin">
      <h2>Game {{ game.gameId }}</h2>
      <span class="hm-cap">{{ game.status }} · half {{ game.half }} · turn {{ game.turn }}{{ game.started ? ` · started ${game.started}` : "" }}</span>
    </header>
    <dl class="adm-kv">
      <dt>Home</dt><dd><strong>{{ game.homeTeamName }}</strong> <span class="adm-muted">{{ game.homeCoach }}{{ game.homeTeamId ? ` · team ${game.homeTeamId}` : "" }}</span></dd>
      <dt>Away</dt><dd><strong>{{ game.awayTeamName }}</strong> <span class="adm-muted">{{ game.awayCoach }}{{ game.awayTeamId ? ` · team ${game.awayTeamId}` : "" }}</span></dd>
    </dl>
    <div class="adm-actions adm-game-actions">
      <button class="sf-btn small" type="button" :disabled="busy" @click="act('close')">Close</button>
      <button v-if="!confirmDelete" class="sf-btn small danger" type="button" :disabled="busy" @click="confirmDelete = true">Delete</button>
      <template v-else>
        <span class="adm-muted">Delete game {{ game.gameId }}? This removes the game row.</span>
        <button class="sf-btn small" type="button" :disabled="busy" @click="confirmDelete = false">Keep</button>
        <button class="sf-btn small danger" type="button" :disabled="busy" @click="act('delete')">Delete game</button>
      </template>
      <button class="sf-btn small" type="button" :disabled="busy || !game.homeTeamId" @click="act('concede', game.homeTeamId)">Concede home</button>
      <button class="sf-btn small" type="button" :disabled="busy || !game.awayTeamId" @click="act('concede', game.awayTeamId)">Concede away</button>
    </div>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
  </article>
</template>

