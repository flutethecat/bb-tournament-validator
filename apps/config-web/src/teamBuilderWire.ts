/** Validate only the externally typed fields before composition applies defaults. */
export function teamBuilderWireError(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "request body must be a JSON object.";
  }
  const apothecary = (body as Record<string, unknown>).apothecary;
  if (apothecary !== undefined && typeof apothecary !== "boolean") {
    return "apothecary must be a boolean when supplied.";
  }
  return null;
}
