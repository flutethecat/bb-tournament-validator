import type { IncomingMessage, ServerResponse } from "node:http";
import { BANNED_ACCOUNT_MESSAGE, isBanned } from "./access.js";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  requestUsesTls,
  sessionFromRequest,
  sessionTokenFromRequest,
} from "./session.js";
import {
  attemptState,
  attemptsByCoach,
  attemptsByIp,
  lockoutRemaining,
  normalizeCoach,
  recordFailure,
} from "./loginAttempts.js";
import { validatedNextPath } from "./discordSso.js";

export interface PortalOptions {
  verifyCoachPassword: (username: string, password: string) => Promise<boolean>;
  authenticationAvailable: boolean;
  discordSsoEnabled: boolean;
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16 * 1024) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : {};
}

function loginPage(next: string, discordSsoEnabled: boolean): string {
  const serializedNext = JSON.stringify(next).replace(/</g, "\\u003c");
  const discordHref = `/api/auth/discord/start?next=${encodeURIComponent(next)}`;
  const discordLogin = discordSsoEnabled
    ? `<div class="divider"><span>or</span></div>
    <a class="discord-login" href="${discordHref}">Sign in with Discord</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Config Web Login</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #111827; color: #f9fafb; }
    main { width: min(24rem, calc(100vw - 2rem)); padding: 2rem; border: 1px solid #374151; border-radius: .75rem; background: #1f2937; box-sizing: border-box; }
    h1 { margin-top: 0; font-size: 1.5rem; }
    label { display: block; margin: 1rem 0 .35rem; }
    input, button { width: 100%; padding: .7rem; border-radius: .4rem; box-sizing: border-box; font: inherit; }
    input { border: 1px solid #4b5563; background: #111827; color: inherit; }
    button { margin-top: 1.25rem; border: 0; background: #2563eb; color: white; font-weight: 700; cursor: pointer; }
    .divider { display: flex; align-items: center; gap: .75rem; margin: .5rem 0 1rem; color: #9ca3af; }
    .divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid #4b5563; }
    .discord-login { display: block; padding: .7rem; border-radius: .4rem; background: #5865f2; color: white; font-weight: 700; text-align: center; text-decoration: none; }
    #error { min-height: 1.25rem; color: #fca5a5; }
  </style>
</head>
<body>
  <main>
    <h1>Config Web</h1>
    <p>Sign in with your FUMBBL40k coach account.</p>
    <form id="login-form">
      <label for="username">Coach name</label>
      <input id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
      <p id="error" role="alert"></p>
    </form>
    ${discordLogin}
  </main>
  <script>
    const next = ${serializedNext};
    const form = document.getElementById("login-form");
    const error = document.getElementById("error");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      const response = await fetch("/api/auth/login?next=" + encodeURIComponent(next), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "X-CW-Auth": "1" },
        body: JSON.stringify({ username: form.username.value, password: form.password.value }),
      });
      const result = await response.json().catch(() => ({ error: "Login failed." }));
      if (!response.ok) { error.textContent = result.error || "Login failed."; return; }
      location.assign(result.next || "/");
    });
  </script>
</body>
</html>`;
}

export async function handleAuthPortal(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: PortalOptions,
): Promise<boolean> {
  const method = req.method ?? "GET";

  if (url.pathname === "/login" && (method === "GET" || method === "HEAD")) {
    const next = validatedNextPath(url.searchParams.get("next"));
    if (sessionFromRequest(req)) {
      res.writeHead(302, { location: next, "cache-control": "no-store" }).end();
      return true;
    }
    const html = loginPage(next, options.discordSsoEnabled);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
    res.end(method === "HEAD" ? undefined : html);
    return true;
  }

  if (url.pathname === "/api/auth/login" && method === "POST") {
    if (req.headers["x-cw-auth"] !== "1") {
      sendJson(res, 403, { error: "Missing required X-CW-Auth header." });
      return true;
    }
    if (!options.authenticationAvailable) {
      sendJson(res, 503, { error: "Login is unavailable: fork DB is not configured on this host." });
      return true;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON request body." });
      return true;
    }
    const username = body && typeof body === "object" && "username" in body ? (body as { username?: unknown }).username : undefined;
    const password = body && typeof body === "object" && "password" in body ? (body as { password?: unknown }).password : undefined;
    if (typeof username !== "string" || !username.trim() || typeof password !== "string" || !password) {
      sendJson(res, 400, { error: "Coach name and password are required." });
      return true;
    }

    const now = Date.now();
    const ipKey = clientIp(req);
    const coachKey = normalizeCoach(username);
    const ipAttempt = attemptState(attemptsByIp, ipKey, now);
    const coachAttempt = attemptState(attemptsByCoach, coachKey, now);
    const remaining = Math.max(lockoutRemaining(ipAttempt, now), lockoutRemaining(coachAttempt, now));
    if (remaining > 0) {
      const retryAfter = Math.max(1, Math.ceil(remaining / 1000));
      sendJson(res, 429, { error: "Too many login attempts. Try again later." }, { "retry-after": String(retryAfter) });
      return true;
    }

    let verified = false;
    try {
      verified = await options.verifyCoachPassword(username.trim(), password);
    } catch {
      sendJson(res, 503, { error: "Coach authentication is temporarily unavailable." });
      return true;
    }
    if (!verified) {
      recordFailure(ipAttempt, now);
      recordFailure(coachAttempt, now);
      sendJson(res, 401, { error: "Invalid coach name or password." });
      return true;
    }
    if (isBanned(username.trim())) {
      sendJson(res, 403, { error: BANNED_ACCOUNT_MESSAGE });
      return true;
    }

    attemptsByIp.delete(ipKey);
    attemptsByCoach.delete(coachKey);
    const { token } = createSession(username.trim(), now);
    const next = validatedNextPath(url.searchParams.get("next"));
    sendJson(res, 200, { ok: true, next }, { "set-cookie": buildSessionCookie(token, requestUsesTls(req)) });
    return true;
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    if (req.headers["x-cw-auth"] !== "1") {
      sendJson(res, 403, { error: "Missing required X-CW-Auth header." });
      return true;
    }
    const token = sessionTokenFromRequest(req);
    if (!sessionFromRequest(req) || !token) {
      sendJson(res, 401, { error: "Authentication required." });
      return true;
    }
    deleteSession(token);
    sendJson(res, 200, { ok: true }, { "set-cookie": buildClearSessionCookie(requestUsesTls(req)) });
    return true;
  }

  return false;
}
