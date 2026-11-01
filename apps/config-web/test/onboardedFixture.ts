// Test fixture: a coach who has completed the new-user flow (privacy notice accepted at the current version). The
// onboarding gate (src/auth/onboarding.ts) answers 428 to /api/me/* writes for anyone else, so suites that exercise
// those writes seed their coaches with this consent block.
import { PRIVACY_VERSION } from "../src/auth/contactSchema.js";

export const ONBOARDED_CONSENT = { privacy: { acceptedVersion: PRIVACY_VERSION, at: "2026-10-31T00:00:00.000Z" } };
