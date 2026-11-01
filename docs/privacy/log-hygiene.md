# Log hygiene

Checked 2026-10-31 against `apps/config-web/src`.

## Where logs live

- Live host: stdout of the config-web process, redirected to `data-store/config-web.log` by the scheduled task
  (see `docs/RESUME.md`); older runs may sit beside it as `config-web.*.log`.
- Bug-report bundles are not logs; they are kept separately (12 months).

## Emails

No email address is written to a log. Emails are read from Discord at sign-in (`auth/discordSso.ts`) and stored only in the
identity record. No `console.*` call in `src/` prints an identity record, a profile or an email.

Portal mail (`src/mail/`) logs the template name, a message id, recipient counts and the provider's HTTP status only: the
log transport (no `POSTMARK_SERVER_TOKEN`) writes `template=… recipients=1`, the webhook logs the record type and whether
it suppressed, never the address. Postmark's own activity log holds recipient addresses on Postmark's side (45 days by
default; see `docs/mail/setup.md`).

## IP addresses

`clientIp` exists in three places and only ever feeds in-memory rate limiters, never a log line or a file:

- `auth/portal.ts` and `auth/coachLogin.ts` (`req.socket.remoteAddress`): the key of the login-attempt map `attemptsByIp`
  (in memory, lost on restart).
- `translate/route.ts` (`clientIp`, which also trusts the last `X-Forwarded-For` hop behind the local proxy): the key of the
  translate rate limiter. Its log lines (`[translate] 200 / 429 / 502 / languages`) carry counts, characters, provider names
  and timings only: no IP, no coach, no text.
- `auth/testLogin.ts` reads `remoteAddress` to refuse non-loopback callers; it does not log it.
- `server.ts` uses the same translate `clientIp` for the standings and shared-read limiters (memory only).

There is no request/access logger in config-web. If the reverse proxy (Caddy) keeps access logs, those would contain IPs;
they are outside this repo, so turn them off or keep them no longer than 14 days.

## What the logs do carry

Startup lines, session-file read/write errors (`[sessions]`), `[deprecated-password-auth]` counters, `[records]` and `[naf]`
skip warnings with game ids and error messages, `[ban-enforcement]` warnings naming a side and team id, and
`[leagues]` results applied with league and game ids. Coach names can appear inside error messages or league ids.

## Logged values from the network

`src/super/service.ts` used to log the claimed coach string on an auth failure. It now logs `safeLogValue()`
(`src/privacy/logSafe.ts`): whitespace and control characters stripped, `@` replaced, at most 40 characters.

## Retention

The notice promises 14 days, and the server enforces it (`src/privacy/logRotation.ts`, started from `server.ts`): at startup
and then daily, any `*.log`, `*.out` or `*.err` file in the data-store directory (`FORK_STATE_DIR`), the config-web folder, and
`CONFIG_WEB_LOG_DIR` if set, last written before today is renamed with its date (`config-web.log.2026-10-30`), or copied and
truncated where Windows holds the redirected file open; dated files older than 14 days are deleted. Caddy access logs, if
kept, are outside this and must be rotated separately.

Bug-report folders are pruned the same way after 12 months (`pruneBugReports` in `src/bugReports.ts`, daily).
