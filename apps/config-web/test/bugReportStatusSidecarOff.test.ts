// POST /api/bug-reports/status on the sidecar-off path (ADMIN_PASSWORD set, authorized() / PUBLIC_PATHS).
import { bugReportStatusSuite } from "./bugReportStatusShared.js";

bugReportStatusSuite("sidecar off, authorized()", false);
