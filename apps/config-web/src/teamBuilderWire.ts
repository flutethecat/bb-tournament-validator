/** Validate only the externally typed fields before composition applies defaults. */
export function teamBuilderWireError(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "request body must be a JSON object.";
  }
  const apothecary = (body as Record<string, unknown>).apothecary;
  if (apothecary !== undefined && typeof apothecary !== "boolean") {
    return "apothecary must be a boolean when supplied.";
  }
  const packageName = (body as Record<string, unknown>).packageName;
  if (packageName !== undefined && typeof packageName !== "string") {
    return "packageName must be a string when supplied.";
  }
  const teamId = (body as Record<string, unknown>).teamId;
  if (teamId !== undefined && (typeof teamId !== "string" || !teamId.trim())) {
    return "teamId must be a non-empty string when supplied.";
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
