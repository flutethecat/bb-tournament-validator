/**
 * Team Captain appointment on a TABLETOP team (owner ruling 10-30; ../captain.ts holds the rules the league and library
 * team stores share). postMatch.ts flags `captainVacant` on the revision a match writes when the captain dies.
 *
 *   GET  /api/tabletop/teams/captain?coach=&team=   the vacancy, the eligible players (picker rows) and the head revision
 *   POST /api/tabletop/teams/captain                { coach, team, playerId, revision }   appoint
 *   POST /api/tabletop/teams/captain/revoke         { coach, team, revision }             take the appointment back
 *
 * Who: the team's own coach (the chain's coach), or a recorder organiser / admin (stamped admin when not the coach).
 * Rules: the same as leagues - a roster player, not dead, not a journeyman or mercenary, not a Star, not a Big Guy (the
 * BB2025 dataset position of the team's roster), on a roster with the Team Captain rule; the player gains the trait and
 * Pro (Pro only when not already owned), recorded in `captainGrants`; the team value does not change.
 *
 * VERSIONING RULE. A tabletop team is a revision chain (store.ts TeamChain) and an organiser's match undo moves the head
 * back to the match revision's parent. An appointment never rewrites a revision: it APPENDS one (parent = the head,
 * stamped `appointment`, no matchId), so the chain stays linear and history is kept. Consequences:
 *   - undoing a LATER match (built on top of the appointment) moves the head back to the appointment revision: kept;
 *   - undoing the match that left the captaincy vacant needs the head to be that match's revision, so the appointment
 *     blocks it (409 naming the appointment) until someone revokes it explicitly here. Nothing drops it silently;
 *   - appoint and revoke run only while no recorded match is open on the team (an open match pinned the head when it was
 *     created; its confirm would be refused) and no commit journal on the team is unfinished.
 * Revoke moves the head back to the appointment's parent (the revision is kept, as every undone revision is).
 */
import { findPosition, isStarName, rosterHasTeamCaptain } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { appointedSkills, captainGrantsFor, captainIneligibility, hasTeamCaptain } from "../captain.js";
import type { TabletopApiDeps, TabletopResult } from "./api.js";
import { teamFileCaptainVacant, type TabletopPlayer, type TabletopTeamFile } from "./postMatch.js";
import { rosterFor } from "./pregame.js";
import { headRevision, type TabletopRepository, type TeamChain } from "./store.js";
import { parseTeamRef } from "./teamFile.js";

const err = (status: number, error: string, extra: Record<string, unknown> = {}): TabletopResult => ({ status, body: { error, ...extra } });
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Why this tabletop player cannot be the team's captain ("" = eligible). Per-roster dataset data decides Big Guy / Star. */
export function tabletopCaptainIneligibility(file: TabletopTeamFile, p: TabletopPlayer): string {
  const who = p.name?.trim() || "This player";
  if (p.dead) return `${who} is dead.`;
  if (p.journeyman || p.kind === "journeyman") return "A journeyman cannot be Team Captain.";
  if (p.kind === "mercenary") return "A Mercenary cannot be Team Captain.";
  const roster = rosterFor(file);
  if (!roster) return `The ${file.race || "team's"} roster could not be checked for the Team Captain rule.`;
  if (!rosterHasTeamCaptain(roster.specialRules)) return `${roster.name} teams have no Team Captain.`;
  const star = p.kind === "star" || isStarName(bb2025, p.positionId ?? "") || isStarName(bb2025, p.positionName ?? "");
  const pos = star ? undefined : (roster.positions.find((x) => x.id === p.positionId)
    ?? (p.positionName ? (roster.positions.find((x) => x.name === p.positionName) ?? findPosition(roster, p.positionName)) : undefined));
  return captainIneligibility({ star, bigGuy: pos?.type === "bigguy", positionKnown: star || Boolean(pos), name: p.name });
}

/** Appoints `playerId` on a copy of the team file, or answers why not. */
export function appointTabletopCaptain(file: TabletopTeamFile, playerId: string): { ok: true; file: TabletopTeamFile; player: TabletopPlayer; grants: string[] } | { ok: false; status: number; error: string } {
  if (file.players.some((p) => !p.dead && hasTeamCaptain(p.skills))) return { ok: false, status: 409, error: "This team already has a Team Captain." };
  if (!teamFileCaptainVacant(file)) return { ok: false, status: 409, error: "A new Team Captain is appointed only when the captain has left the team." };
  const player = file.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, status: 400, error: "That player is not on this team's roster." };
  const why = tabletopCaptainIneligibility(file, player);
  if (why) return { ok: false, status: 400, error: why };
  const grants = captainGrantsFor(player.skills);
  const next: TabletopPlayer = { ...player, skills: appointedSkills(player.skills), captainGrants: grants };
  const { captainVacant: _v, ...rest } = file;
  return { ok: true, file: { ...rest, players: file.players.map((p) => (p.id === playerId ? next : p)) }, player: next, grants };
}

/** The team refs (of `coach`) whose chain head is waiting for a new captain (GET /api/tabletop/saves marks them). */
export async function teamCaptainVacancy(repo: TabletopRepository, coach: string, refs: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ref of refs) {
    const parsed = parseTeamRef(ref);
    try {
      const chain = parsed ? await repo.getChain(coach, parsed.ref) : undefined;
      if (chain && teamFileCaptainVacant(headRevision(chain).teamFile)) out.add(ref);
    } catch { /* a reminder only: an unreadable chain never breaks the team list */ }
  }
  return out;
}

/** Picker rows (the shared player picker's RosterPlayerView shape) for the eligible players. */
function candidateRows(file: TabletopTeamFile) {
  return file.players.filter((p) => !tabletopCaptainIneligibility(file, p)).map((p) => ({
    id: p.id, name: p.name, ...(p.number !== undefined ? { number: p.number } : {}), spp: p.spp, mng: p.mng, dead: false,
    ...(p.positionId ? { positionId: p.positionId } : {}), ...(p.positionName ? { position: p.positionName, positionName: p.positionName } : {}),
    skills: [...p.skills], niggles: p.niggles,
    ...(p.ma !== undefined ? { ma: p.ma } : {}), ...(p.st !== undefined ? { st: p.st } : {}), ...(p.ag !== undefined ? { ag: p.ag } : {}),
    ...(p.pa !== undefined ? { pa: p.pa } : {}), ...(p.av !== undefined ? { av: p.av } : {}),
  }));
}

// One writer per team chain (appoint / revoke), like api.ts serialises each match.
const queues = new Map<string, Promise<unknown>>();
function serialTeam<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

/** Another commit (confirm / undo / publish) still being completed on this team: its chain write must land first. */
async function journalPending(repo: TabletopRepository, coach: string, saveId: string): Promise<boolean> {
  for (const id of await repo.listJournalMatchIds()) {
    const j = await repo.getJournal(id);
    if (j && [j.match.home, j.match.away].some((s) => s.coach === coach && s.teamSaveId === saveId)) return true;
  }
  return false;
}

export async function tabletopCaptainApi(
  method: string, path: string, query: URLSearchParams, body: unknown, me: string, organiser: boolean, deps: TabletopApiDeps,
  dropSnapshots: () => void,
): Promise<TabletopResult | undefined> {
  if (path !== "/api/tabletop/teams/captain" && path !== "/api/tabletop/teams/captain/revoke") return undefined;
  const revoke = path.endsWith("/revoke");
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const read = method === "GET" && !revoke;
  if (!read && method !== "POST") return err(405, "Method not allowed.");
  const coach = String((read ? query.get("coach") : b.coach) ?? "").trim();
  const ref = parseTeamRef(read ? query.get("team") : b.team);
  if (!coach || coach.length > 60) return err(400, "coach is required.");
  if (!ref) return err(400, "team must be library:<id> or save:<id>.");
  const mine = same(coach, me);
  if (!mine && !organiser) return err(403, "Only this team's coach, an organiser or an admin can appoint its Team Captain.");
  const { repo } = deps;

  if (read) {
    const chain = await repo.getChain(coach, ref.ref);
    if (!chain) return { status: 200, body: { vacant: false, revision: null, players: [] } };
    const head = headRevision(chain);
    const vacant = teamFileCaptainVacant(head.teamFile);
    return {
      status: 200,
      body: {
        teamName: head.teamFile.name, revision: chain.head, vacant, players: vacant ? candidateRows(head.teamFile) : [],
        ...(head.appointment ? { appointment: { by: head.appointment.by, at: head.appointment.at, admin: head.appointment.admin, playerId: head.appointment.playerId } } : {}),
      },
    };
  }

  return serialTeam(`${coach}\0${ref.ref}`, async () => {
    const chain = await repo.getChain(coach, ref.ref);
    if (!chain) return err(404, "This team has no recorded matches yet.");
    if (!Number.isInteger(b.revision)) return err(428, "Send the team revision you loaded (revision).", { revision: chain.head });
    if (b.revision !== chain.head) return err(409, "This team changed since you opened it. Reload to see the latest.", { revision: chain.head });
    if (await repo.findOpenMatchForSave(chain.coach, chain.saveId)) return err(409, "This team is in an unfinished recorded match: finish it (or have it removed) first.", { revision: chain.head });
    if (await journalPending(repo, chain.coach, chain.saveId)) return err(409, "A result on this team is still being saved. Try again in a moment.", { revision: chain.head });
    const at = (deps.now?.() ?? new Date()).toISOString();
    const head = headRevision(chain);
    let next: TeamChain;
    let playerId: string;
    if (revoke) {
      if (!head.appointment || head.parent === null) return err(409, "The team's latest revision is not a Team Captain appointment.", { revision: chain.head });
      next = { ...chain, head: head.parent };
      playerId = head.appointment.playerId;
    } else {
      if (typeof b.playerId !== "string" || !b.playerId.trim() || b.playerId.length > 64) return err(400, "playerId is required.");
      const done = appointTabletopCaptain(head.teamFile, b.playerId);
      if (!done.ok) return err(done.status, done.error, { revision: chain.head });
      const revision = chain.revisions.length;
      next = {
        ...chain, head: revision,
        revisions: [...chain.revisions, {
          saveId: chain.saveId, revision, parent: chain.head, teamFile: done.file, createdAt: at,
          appointment: { by: me, at, admin: !mine, playerId: done.player.id, grants: done.grants },
        }],
      };
      playerId = done.player.id;
    }
    await repo.putChain(next);
    dropSnapshots(); // finished matches on this team show the head's roster
    const file = headRevision(next).teamFile;
    return { status: 200, body: { ok: true, revision: next.head, playerId, vacant: teamFileCaptainVacant(file), skills: file.players.find((p) => p.id === playerId)?.skills ?? [] } };
  });
}
