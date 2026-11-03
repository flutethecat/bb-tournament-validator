// Fork route lockdown through the AUTH_SIDECAR session gate (src/auth/requireSession.ts), the path the live :4310 runs.
import { defineForkLockdownSuite } from "./forkRouteLockdownShared.js";

defineForkLockdownSuite("sidecar");
