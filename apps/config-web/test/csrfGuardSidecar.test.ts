// CSRF guard through the AUTH_SIDECAR session gate (src/auth/requireSession.ts), the path the live :4310 runs.
import { defineCsrfSuite } from "./csrfGuardShared.js";

defineCsrfSuite("sidecar");
