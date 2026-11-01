// CSRF guard on the sidecar-off ADMIN_PASSWORD path (authorized() / PUBLIC_PATHS).
import { defineCsrfSuite } from "./csrfGuardShared.js";

defineCsrfSuite("sidecar-off");
