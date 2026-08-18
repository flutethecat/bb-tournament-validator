# FUMBBL40k FFB fork server (22227) — silent launcher. Waits for MariaDB (3316), max 90s; idempotent.
$ErrorActionPreference = 'Stop'
if (Get-NetTCPConnection -LocalPort 22227 -State Listen -ErrorAction SilentlyContinue) { exit 0 }
$deadline = (Get-Date).AddSeconds(90)
while (-not (Get-NetTCPConnection -LocalPort 3316 -State Listen -ErrorAction SilentlyContinue)) {
  if ((Get-Date) -gt $deadline) { exit 1 }  # MariaDB never came up — FFB would exit 99 anyway
  Start-Sleep -Seconds 3
}
Start-Sleep -Seconds 2  # small settle after the port opens
Start-Process -WindowStyle Hidden -WorkingDirectory 'C:\Users\Jay\Documents\Claude\fumbbl40k-server\ffb-server' `
  -FilePath 'C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot\bin\java.exe' `
  -ArgumentList '-jar','FantasyFootballServer.jar','standalone','-inifile','server-dev.ini' `
  -RedirectStandardOutput 'C:\Users\Jay\Documents\Claude\fumbbl40k-server\ffb-server\ffb-svc.log' `
  -RedirectStandardError 'C:\Users\Jay\Documents\Claude\fumbbl40k-server\ffb-server\ffb-svc-err.log'
