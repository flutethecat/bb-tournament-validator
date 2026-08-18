# TLS Runbook — Caddy reverse-proxy for config-web

Caddy terminates HTTPS for `superfumbbltest.duckdns.org` (Let's Encrypt, automatic) and proxies to config-web on `127.0.0.1:4310`. Prepared 2026-08-18; NOT yet serving.

- Caddy: v2.11.4, winget-installed at
  `C:\Users\Jay\AppData\Local\Microsoft\WinGet\Packages\CaddyServer.Caddy_Microsoft.Winget.Source_8wekyb3d8bbwe\caddy.exe`
  (also on PATH as `caddy` in NEW shells via WinGet Links).
- Caddyfile: `deploy\Caddyfile` in this repo (validated with `caddy validate`).

## Prerequisites — OWNER ONLY (router)
1. Port-forward **80/tcp** and **443/tcp** -> this machine. Required for Let's Encrypt issuance (HTTP/TLS-ALPN challenge) and for serving HTTPS.
2. Once TLS is confirmed live: **remove the direct 4310 forward** so all public traffic goes through Caddy. (Keep it during cutover if a fallback is wanted.)

Windows Firewall: first `caddy run` will pop the usual allow prompt; accept for the ports to open locally. No firewall changes made during prep.

## Start (foreground, first run / testing)
```powershell
caddy run --config C:\Users\Jay\Documents\Claude\bb-tournament-validator\deploy\Caddyfile
```
Watch the log: cert issuance happens on first HTTPS hit / at startup. Errors about ACME = port 80/443 not reachable from outside yet.

## Run as a Windows service (pick one)
- **NSSM** (simplest): `nssm install caddy <caddy.exe path> run --config <Caddyfile path>`; `nssm start caddy`. Set AppDirectory to a writable dir (certs live under `%APPDATA%\Caddy`).
- **Task Scheduler**: task at logon/startup, action = the `caddy run --config ...` command line, "run whether user is logged on or not", restart on failure.
- Caddy has no built-in Windows service mode; NSSM is the recommended route.

## Verify
```powershell
curl.exe -sS https://superfumbbltest.duckdns.org/health   # or any known config-web route
curl.exe -sSI http://superfumbbltest.duckdns.org/         # expect 308 redirect to https
```
NAT loopback works on this router (verified previously), so these work from the LAN too.

## Rollback
Stop Caddy (Ctrl-C / `nssm stop caddy` / end the scheduled task). Nothing else was changed — config-web still listens on 0.0.0.0:4310 and the old direct-:4310 path keeps working as long as the router forward remains.

## Follow-up once TLS is live
- config-web should bind **127.0.0.1 only** (Caddy is the sole public entry); then the direct 4310 router forward is removed.
- Auth sidecar Secure-cookie mode engages automatically behind TLS (TLS-aware already per SR-259).
