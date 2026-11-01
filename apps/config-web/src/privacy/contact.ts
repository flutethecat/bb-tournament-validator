// Privacy notice contact block (GET /api/privacy/contact): the controller name and contact address come from the
// environment so the public repo never carries them. Besides those two, only provider switches are read (never a key or
// token is returned).

export interface PrivacyContact {
  controller: string | null;
  email: string | null;
  hosting: "United States";
  /** Appointed at paid launch; the notice gains the line then. */
  euRepresentative: null;
  /** The third-party translation provider chat text goes to, only while an operator has enabled one. */
  translation: "deepl" | "azure" | null;
  /** The mail provider portal email goes through, only while one is configured (src/mail/config.ts). */
  mail: "postmark" | null;
}

function clean(value: string | undefined, max: number): string | null {
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return text || null;
}

/** Mirrors translate/providers.ts providerFromEnv: a provider counts only when selected AND its key is set. Never returns a key. */
function translationProvider(env: Record<string, string | undefined>): "deepl" | "azure" | null {
  const setting = (env.TRANSLATE_PROVIDER ?? "").trim().toLowerCase();
  if (setting === "deepl" && env.DEEPL_API_KEY?.trim()) return "deepl";
  if (setting === "azure" && env.AZURE_TRANSLATOR_KEY?.trim()) return "azure";
  return null;
}

export function privacyContact(env: Record<string, string | undefined> = process.env): PrivacyContact {
  const email = clean(env.PRIVACY_CONTACT_EMAIL, 254);
  return {
    controller: clean(env.PRIVACY_CONTROLLER_NAME, 120),
    // A malformed address is dropped rather than published as given.
    email: email && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null,
    hosting: "United States",
    euRepresentative: null,
    translation: translationProvider(env),
    mail: env.POSTMARK_SERVER_TOKEN?.trim() ? "postmark" : null,
  };
}
