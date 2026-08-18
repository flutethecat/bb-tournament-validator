# FUMBBL40k MariaDB (3316) — silent scheduled-task launcher. Idempotent: exits if 3316 is listening.
$ErrorActionPreference = 'Stop'
if (Get-NetTCPConnection -LocalPort 3316 -State Listen -ErrorAction SilentlyContinue) { exit 0 }
Remove-Item 'C:\Users\Jay\tools\ffbdb-data\*.pid' -Force -ErrorAction SilentlyContinue
Start-Process -WindowStyle Hidden -FilePath 'C:\Users\Jay\tools\mariadb-11.8.8-winx64\bin\mariadbd.exe' `
  -ArgumentList '--defaults-file=C:\Users\Jay\tools\ffbdb-data\my.ini','--console' `
  -RedirectStandardError 'C:\Users\Jay\tools\ffbdb-data\mariadb-svc.log'
