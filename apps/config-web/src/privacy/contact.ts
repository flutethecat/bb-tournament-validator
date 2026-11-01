// Privacy notice contact block (GET /api/privacy/contact): the controller name and contact address come from the
// environment so the public repo never carries them. Only these two keys are ever read.

export interface PrivacyContact {
  controller: string | null;
  email: string | null;
  hosting: "United States";
  /** Appointed at paid launch; the notice gains the line then. */
  euRepresentative: null;
}

function clean(value: string | undefined, max: number): string | null {
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return text || null;
}

export function privacyContact(env: Record<string, string | undefined> = process.env): PrivacyContact {
  const email = clean(env.PRIVACY_CONTACT_EMAIL, 254);
  return {
    controller: clean(env.PRIVACY_CONTROLLER_NAME, 120),
    // A malformed address is dropped rather than published as given.
    email: email && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null,
    hosting: "United States",
    euRepresentative: null,
  };
}
