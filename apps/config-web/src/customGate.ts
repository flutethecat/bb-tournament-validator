export function teamEditingError(opts: {
  teamId: unknown;
  organizer: boolean;
  adminAuthed: boolean;
}): string | undefined {
  if (opts.teamId === undefined || opts.organizer || opts.adminAuthed) return undefined;
  return "team editing is organizer-only during testing";
}
