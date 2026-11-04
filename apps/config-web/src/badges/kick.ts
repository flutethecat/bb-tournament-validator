/**
 * Which writes recompute badges (badges lane review 11-04, P2-2): only those that can change a RESULT or a milestone. Recorder
 * in-game events, turn and pre-game steps, dice, chat and settings never do (the minute tick still catches anything missed).
 *
 *   recorder     confirm, publish, undo of a revision, the organiser's bulk confirm-publish / reopen, the forfeit dialog
 *   tournaments  a result reported (scheduled-matches/:id/result), an organiser's result edit or clear, finishing a tournament
 *   fork         a Super FUMBBL result posted for a game
 *   leagues      fixture results and decisions, forfeits, deadlines, a season finished / reopened / removed, a team's fixture
 *                decisions or coach assignment, ladder results / rounds / challenges / titles / Rumbles / close, the TourPlay
 *                apply and its coach assignments and claims
 */
const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RULES: readonly RegExp[] = [
  /^\/api\/tabletop\/matches\/[\w-]+\/(?:confirm|publish|undo-revision|forfeit(?:\/[\w-]+)?)$/,
  /^\/api\/tabletop\/organiser\/bulk$/,
  /^\/api\/scheduled-matches\/[^/]+\/result$/,
  /^\/api\/(?:fork\/)?tournaments\/[^/]+\/(?:finish|fixtures\/[^/]+\/result(?:\/clear)?)$/,
  /^\/api\/fork\/match\/[^/]+\/result$/,
  /^\/api\/leagues\/[^/]+\/seasons\/[^/]+$/,
  /^\/api\/leagues\/[^/]+\/seasons\/[^/]+\/(?:fixtures(?:\/.*)?|forfeits?(?:\/.*)?|deadlines|finish|reopen|teams\/[^/]+(?:\/(?:fixtures|status))?)$/,
  /^\/api\/leagues\/[^/]+\/ladders\/[^/]+(?:\/(?:fixtures|results?|rounds|challenges|titles|rumbles|close|start)(?:\/.*)?)?$/,
  /^\/api\/leagues\/[^/]+\/tourplay\/(?:apply|coaches\/[^/]+\/assign|claims\/[^/]+\/approve)$/,
];

export function badgeKickPath(method: string, path: string): boolean {
  return WRITE.has(method) && RULES.some((r) => r.test(path));
}
