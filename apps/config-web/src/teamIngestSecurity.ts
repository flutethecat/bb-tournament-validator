import type { SessionIdentity } from "./auth/requireSession.js";

export type IngestDecision =
  | { ok: true; coach: string; team: string; allowRecovery: boolean; privileged: boolean }
  | { ok: false; status: 400 | 401 | 403; error: string };

export function parseLibraryIngestRequest(body: unknown, auth: SessionIdentity | undefined, adminAuthed: boolean): IngestDecision {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "A JSON request body is required." };
  const values = body as Record<string, unknown>;
  if (Object.keys(values).some((key) => !["coach", "team", "recovery"].includes(key)) ||
    typeof values.team !== "string" || !values.team.trim() ||
    (values.coach !== undefined && (typeof values.coach !== "string" || !values.coach.trim())) ||
    (values.recovery !== undefined && typeof values.recovery !== "boolean")) {
    return { ok: false, status: 400, error: "Ingest requires team, optional coach, and optional recovery fields only." };
  }
  const requestedCoach = typeof values.coach === "string" ? values.coach.trim() : undefined;
  const coach = auth?.coach ?? (adminAuthed ? requestedCoach : undefined);
  if (!coach) return { ok: false, status: 401, error: "Ingest requires an authenticated coach session or admin authorization." };
  if (auth && requestedCoach && requestedCoach.toLowerCase() !== auth.coach.toLowerCase()) {
    return { ok: false, status: 403, error: "A coach session may only ingest into its own library." };
  }
  const privileged = adminAuthed || auth?.organizer === true;
  const allowRecovery = values.recovery === true && privileged;
  if (values.recovery === true && !allowRecovery) return { ok: false, status: 403, error: "Destructive recovery ingest requires organizer or admin authorization." };
  return { ok: true, coach, team: values.team.trim(), allowRecovery, privileged };
}

export function libraryIngestOwnershipError(decision: Extract<IngestDecision, { ok: true }>, sourceCoach: string): string | undefined {
  if (decision.privileged || sourceCoach.trim().toLowerCase() === decision.coach.toLowerCase()) return undefined;
  return "Coaches may only ingest teams owned by their matching FUMBBL coach account.";
}
