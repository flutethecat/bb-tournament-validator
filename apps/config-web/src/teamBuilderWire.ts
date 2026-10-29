const STAT_INCREASE_KEYS = new Set(["MA", "ST", "AG", "PA", "AV"]);

/** Size limits on a builder body, checked BEFORE anything composes it (the composer expands each pick's
 *  `count` into players, so an unbounded count is an allocation bomb). Generous next to the real game limits. */
export const TEAM_BUILDER_BODY_BOUNDS = {
  bodyBytes: 64 * 1024,
  picks: 32,
  playersPerPick: 16,
  players: 16, // stars included: a team never fields more than 16
  skillsPerPick: 8,
  stringChars: 120,
  inducements: 32,
  inducementCount: 16,
  staff: 20, // reRolls / assistantCoaches / cheerleaders / dedicatedFans
} as const;

/** The bounded-aggregate check (null when the body is within limits). Run on every path that composes a body:
 *  preview, build, save create/update, recorded builds and stored saves read back for a share link. */
export function teamBuilderBoundsError(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "request body must be a JSON object.";
  const B = TEAM_BUILDER_BODY_BOUNDS;
  const raw = body as Record<string, unknown>;
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw), "utf8");
  } catch {
    return "request body must be plain JSON.";
  }
  if (size > B.bodyBytes) return `request body must be at most ${B.bodyBytes} bytes.`;
  // Length only: wrong types are reported by teamBuilderWireError / the composer with their own messages.
  const shortString = (v: unknown) => typeof v !== "string" || v.length <= B.stringChars;
  for (const key of ["rosterId", "teamName", "specialRule", "packageName", "skillPack", "teamId", "coach"] as const)
    if (!shortString(raw[key])) return `${key} must be at most ${B.stringChars} characters.`;
  for (const key of ["reRolls", "assistantCoaches", "cheerleaders", "dedicatedFans"] as const) {
    const v = raw[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > B.staff))
      return `${key} must be an integer between 0 and ${B.staff}.`;
  }
  const picks = raw.picks;
  if (picks !== undefined) {
    if (!Array.isArray(picks)) return "picks must be an array when supplied.";
    if (picks.length > B.picks) return `picks may list at most ${B.picks} entries.`;
    let players = 0;
    for (const pick of picks) {
      if (!pick || typeof pick !== "object" || Array.isArray(pick)) return "each pick must be an object.";
      const p = pick as Record<string, unknown>;
      if (!shortString(p.positionId)) return `positionId must be at most ${B.stringChars} characters.`;
      const count = p.count ?? 1;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > B.playersPerPick)
        return `each pick count must be an integer between 0 and ${B.playersPerPick}.`;
      players += count;
      if (players > B.players) return `a team may have at most ${B.players} players.`;
      for (const list of ["chosenSkills", "chosenStatIncreases"] as const) {
        const v = p[list];
        if (v === undefined) continue;
        if (!Array.isArray(v)) return `${list} must be an array when supplied.`;
        if (v.length > B.skillsPerPick) return `${list} may list at most ${B.skillsPerPick} entries.`;
        if (!v.every((x) => typeof x === "string" && x.length <= B.stringChars)) return `each ${list} entry must be a short string.`;
      }
    }
  }
  for (const key of ["rosteredInducements", "inducements"] as const) {
    const list = raw[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `${key} must be an array when supplied.`;
    if (list.length > B.inducements) return `${key} may list at most ${B.inducements} entries.`;
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return "each rostered inducement must be an object.";
      const { key: k, count } = item as Record<string, unknown>;
      if (!shortString(k)) return `each rostered inducement key must be at most ${B.stringChars} characters.`;
      if (count !== undefined && (typeof count !== "number" || !Number.isInteger(count) || count > B.inducementCount))
        return `each rostered inducement count must be at most ${B.inducementCount}.`;
    }
  }
  return null;
}

/** Validate only the externally typed fields before composition applies defaults. */
export function teamBuilderWireError(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "request body must be a JSON object.";
  }
  const bounds = teamBuilderBoundsError(body);
  if (bounds) return bounds;
  const apothecary = (body as Record<string, unknown>).apothecary;
  if (apothecary !== undefined && typeof apothecary !== "boolean") {
    return "apothecary must be a boolean when supplied.";
  }
  const packageName = (body as Record<string, unknown>).packageName;
  if (packageName !== undefined && typeof packageName !== "string") {
    return "packageName must be a string when supplied.";
  }
  const saveId = (body as Record<string, unknown>).saveId;
  if (saveId !== undefined && (typeof saveId !== "string" || !saveId.trim())) {
    return "saveId must be a non-empty string when supplied.";
  }
  const teamId = (body as Record<string, unknown>).teamId;
  if (teamId !== undefined && (typeof teamId !== "string" || !teamId.trim())) {
    return "teamId must be a non-empty string when supplied.";
  }
  // Tournament path: per-pick characteristic increases (legality is the validator's job).
  const picks = (body as Record<string, unknown>).picks;
  if (Array.isArray(picks)) {
    for (const pick of picks) {
      if (!pick || typeof pick !== "object" || Array.isArray(pick)) continue; // composer reports bad picks
      const captain = (pick as Record<string, unknown>).captain;
      if (captain !== undefined && typeof captain !== "boolean") return "captain must be a boolean when supplied.";
      const stats = (pick as Record<string, unknown>).chosenStats;
      if (stats !== undefined) {
        if (!stats || typeof stats !== "object" || Array.isArray(stats)) return "chosenStats must be an object when supplied.";
        for (const [k, v] of Object.entries(stats as Record<string, unknown>)) {
          if (!STAT_INCREASE_KEYS.has(k)) return "chosenStats keys must be MA, ST, AG, PA or AV.";
          if (v !== undefined && (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 20))
            return `chosenStats.${k} must be an integer between 0 and 20.`;
        }
      }
      const incs = (pick as Record<string, unknown>).chosenStatIncreases;
      if (incs === undefined) continue;
      if (!Array.isArray(incs)) return "chosenStatIncreases must be an array when supplied.";
      if (incs.length > 5) return "chosenStatIncreases may list at most 5 entries.";
      for (const k of incs)
        if (typeof k !== "string" || !STAT_INCREASE_KEYS.has(k))
          return "each chosenStatIncreases entry must be one of MA, ST, AG, PA, AV.";
    }
  }
  // The shipped client TeamBuilderView sends this list as `inducements`; accept both names.
  const raw = body as Record<string, unknown>;
  const rosteredInducements = raw.rosteredInducements ?? raw.inducements;
  if (rosteredInducements !== undefined) {
    if (!Array.isArray(rosteredInducements)) return "rosteredInducements must be an array when supplied.";
    for (const pick of rosteredInducements) {
      if (!pick || typeof pick !== "object" || Array.isArray(pick))
        return "each rostered inducement must be an object.";
      const { key, count } = pick as Record<string, unknown>;
      if (typeof key !== "string" || !key.trim()) return "each rostered inducement key must be a non-empty string.";
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0)
        return "each rostered inducement count must be a positive safe integer.";
    }
  }
  return null;
}
