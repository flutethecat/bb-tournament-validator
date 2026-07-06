/**
 * Generate a text prompt for an LLM / image model to produce key art for a
 * tournament, derived from its package (name, date, and the teams involved).
 * Pure string in/out so the bot and the config pane both use it.
 */

import type { TournamentPackage } from "../package/types";

/** All team/race names referenced anywhere in the package. */
function collectTeams(pkg: TournamentPackage): string[] {
  const set = new Set<string>();
  const add = (names?: string[]) => names?.forEach((n) => n && n !== "*" && set.add(n));
  add(pkg.eligibleRosters);
  pkg.tiers?.forEach((t) => add(t.rosters));
  pkg.matrix?.cells.forEach((c) => add(c.teams));
  pkg.teamRules?.forEach((t) => set.add(t.team));
  return [...set];
}

export function renderArtPrompt(pkg: TournamentPackage): string {
  const teams = collectTeams(pkg);
  const teamPhrase = teams.length
    ? teams.slice(0, 8).join(", ") + (teams.length > 8 ? `, and ${teams.length - 8} more` : "")
    : "a wild variety of fantasy football teams";
  const date = pkg.date ? ` held on ${pkg.date}` : "";
  const flavor = pkg.description ? `\n\nTournament flavor: ${pkg.description}.` : "";

  return `Create dramatic promotional key art for a fantasy sports tournament.

Title: "${pkg.name}"${date}. This is a BLOOD BOWL tournament — Blood Bowl is a brutal, darkly comedic fantasy sport that blends American football with Warhammer-style fantasy battle.${flavor}

Featured teams / races: ${teamPhrase}. Show their iconic archetypes clashing on the pitch mid-action — e.g. armoured orcs, lithe elves, shambling undead, stout dwarves, spear-wielding amazons — muscles, mud, spikes, and a studded football in play.

Setting: a roaring fantasy stadium at dusk — torch-lit stands packed with a grotesque, cheering crowd, team banners and pennants, a battered scoreboard, sweeping stadium lights, dust and haze.

Composition: dynamic low-angle hero shot; the tournament name rendered as a bold engraved metal-and-stone title banner across the top; a golden trophy or grinning skull motif as the focal accent; cinematic depth of field.

Style: gritty painterly Warhammer-fantasy illustration, rich saturated colour, strong rim lighting, high detail, splash-art / movie-poster framing, 4k.

Avoid: real-world sports logos, modern gear, gibberish lettering (keep any text to the tournament title only), watermarks, extra limbs.`;
}
