# FUMBBL40k Caddy TLS proxy (443/80 -> :4310) — silent launcher. Idempotent: exits if 443 is listening.
$ErrorActionPreference = 'Stop'
if (Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue) { exit 0 }
Start-Process -WindowStyle Hidden `
  -FilePath 'C:\Users\Jay\AppData\Local\Microsoft\WinGet\Packages\CaddyServer.Caddy_Microsoft.Winget.Source_8wekyb3d8bbwe\caddy.exe' `
  -ArgumentList 'run','--config','C:\Users\Jay\Documents\Claude\bb-tournament-validator\deploy\Caddyfile' `
  -RedirectStandardError 'C:\Users\Jay\Documents\Claude\bb-tournament-validator\deploy\caddy-svc.log'
