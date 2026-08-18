/**
 * SR-260 ③: `custom:true` bypasses ALL legality/budget validation, so it is an
 * organizer/admin power — never open to an arbitrary coach. Fail closed: with no
 * organizer identity and no admin auth (including when ADMIN_PASSWORD is unset),
 * custom requests are refused.
 */
export function customModeError(opts: { custom: unknown; organizer: boolean; adminAuthed: boolean }): string | undefined {
  if (!opts.custom) return undefined; // truthy check — the honor sites are truthy too
  if (opts.organizer || opts.adminAuthed) return undefined;
  return "custom:true is restricted to organizers — sign in as an organizer coach or use admin auth.";
}
