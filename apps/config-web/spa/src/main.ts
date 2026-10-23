// League & Tournament Manager SPA entry (served at /app/). The site theme (/theme.css + /theme.js) is loaded
// unbundled by index.html; this bundle only adds the shell and the migrated pages.

import "./shared/lobby.css";
import "./style.css";
import "./tabletop/tabletop.css";
import { createWebHistory } from "vue-router";
import { createSpa } from "./app";
import { APP_BASE } from "./router";

const { app, router } = createSpa({ history: createWebHistory(APP_BASE) });
void router.isReady().then(() => app.mount("#app"));
