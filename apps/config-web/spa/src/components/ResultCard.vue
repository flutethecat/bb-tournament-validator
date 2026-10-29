<script setup lang="ts">
// One played game as a wide card (owner 10-30, after TourPlay's results view): a diagonal tint of the two teams'
// colours, a muted context line, each team block (crest, name, race, coach) either side of a big score with the
// casualties under each number. Shared contract with the league views: props below, styles in shared/result-card.css.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { raceTone } from "../shared/raceTone";
import { routerPathOf } from "../home/shell";

export interface ResultCardSide {
  name: string;
  race: string;
  coach: string;
  crestUrl?: string | null;
  score: number | null;
  cas: number | null;
}

const props = defineProps<{
  context: string;
  home: ResultCardSide;
  away: ResultCardSide;
  playedAt?: string;
  href?: string;
  tone?: { home?: string; away?: string };
  concede?: "home" | "away" | null;
  suspended?: boolean;
  /** "lg" scales the card up (Past Games strip); the default is the compact size other views use. */
  size?: "lg";
}>();

/** A CSS colour we are willing to put in a style attribute (hex, rgb()/hsl(), or a bare colour name). */
const SAFE_COLOUR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/]+\)|[a-z]{3,20})$/i;
const colour = (value: string | undefined, race: string) => (value && SAFE_COLOUR.test(value.trim()) ? value.trim() : raceTone(race));
const style = computed(() => ({ "--rc-home": colour(props.tone?.home, props.home.race), "--rc-away": colour(props.tone?.away, props.away.race) }));

/** Site paths and http(s) URLs only; anything else falls back to the initials badge. */
const crestSrc = (url: string | null | undefined): string => {
  const u = typeof url === "string" ? url.trim() : "";
  return /^\/(?!\/)/.test(u) || /^https?:\/\//i.test(u) ? u : "";
};
const initials = (name: string): string =>
  name.split(/\s+/).map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? "").filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
const scoreText = (n: number | null) => (n === null || n === undefined ? "–" : String(n));
const casText = (n: number | null) => (typeof n === "number" ? `(${n})` : "");

/** /app paths stay in the SPA (RouterLink); other site paths and http(s) URLs are plain links; anything else is no link. */
const link = computed((): { tag: unknown; attrs: Record<string, string> } => {
  const href = props.href?.trim() ?? "";
  const to = href ? routerPathOf(href) : undefined;
  if (to) return { tag: RouterLink, attrs: { to } };
  if (/^\/(?!\/)/.test(href) || /^https?:\/\//i.test(href)) return { tag: "a", attrs: { href } };
  return { tag: "div", attrs: {} };
});
const linked = computed(() => link.value.tag !== "div");
const when = computed(() => {
  const t = props.playedAt ? Date.parse(props.playedAt) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
});
const label = computed(() =>
  `${props.home.name} ${scoreText(props.home.score)}, ${props.away.name} ${scoreText(props.away.score)}. ${props.context}`);
/** The coach who conceded (the team name only when the game carries no coach). Text only: Vue escapes it once. */
const conceder = computed(() => { const side = props.concede === "home" ? props.home : props.away; return side.coach || side.name; });
const flag = computed(() =>
  props.suspended ? "Suspended" : props.concede ? `Conceded by ${conceder.value}` : "");
const sides = computed(() => [
  { key: "home" as const, side: props.home },
  { key: "away" as const, side: props.away },
]);
</script>

<template>
  <component
    :is="link.tag"
    v-bind="link.attrs"
    class="rc-card"
    :style="style"
    :aria-label="linked ? label : undefined"
    :data-suspended="suspended ? 'true' : undefined"
    :data-size="size"
    :data-conceded="concede ? 'true' : undefined"
  >
    <p class="rc-context"><span class="rc-context-text">{{ context }}</span><time v-if="when" class="rc-when" :datetime="playedAt">{{ when }}</time></p>
    <div class="rc-body">
      <template v-for="(s, i) in sides" :key="s.key">
        <div v-if="i === 1" class="rc-score" :data-conceded="concede ? 'true' : undefined">
          <span class="rc-nums">
            <span class="rc-num">{{ scoreText(home.score) }}<small v-if="casText(home.cas)" class="rc-cas">{{ casText(home.cas) }}</small></span>
            <span class="rc-num">{{ scoreText(away.score) }}<small v-if="casText(away.cas)" class="rc-cas">{{ casText(away.cas) }}</small></span>
          </span>
          <span v-if="concede" class="rc-plate-cap">Conceded</span>
        </div>
        <div class="rc-team" :class="`rc-${s.key}`">
          <img v-if="crestSrc(s.side.crestUrl)" class="rc-crest" :src="crestSrc(s.side.crestUrl)" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <span v-else class="rc-crest rc-initials" aria-hidden="true">{{ initials(s.side.name) }}</span>
          <span class="rc-who">
            <span class="rc-name">{{ s.side.name }}</span>
            <span v-if="s.side.race" class="rc-race">{{ s.side.race }}</span>
            <span v-if="s.side.coach" class="rc-coach"><span class="rc-avatar" aria-hidden="true">{{ initials(s.side.coach) }}</span>{{ s.side.coach }}</span>
          </span>
        </div>
      </template>
    </div>
    <p v-if="flag" class="rc-flag">{{ flag }}</p>
  </component>
</template>
