// Fork route lockdown on the sidecar-off ADMIN_PASSWORD path (authorized() / PUBLIC_PATHS).
import { defineForkLockdownSuite } from "./forkRouteLockdownShared.js";

defineForkLockdownSuite("sidecar-off");
