# Super FUMBBL LibreTranslate (local)

Translation backend for config-web's chat relay (`POST /api/translate`, owner 10-12). config-web is
the public face (limits, rate limiting, cache, CORS); LibreTranslate listens on **127.0.0.1:5000
only**. Never bind it to 0.0.0.0.

## Install (already done on this box, 10-12)

```powershell
cd C:\Users\Jay\Documents\Claude\bb-tournament-validator\apps\config-web\tools\libretranslate
& "C:\Users\Jay\AppData\Local\Programs\Python\Python312\python.exe" -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install libretranslate
```

Python 3.12 is used on purpose: LibreTranslate's dependencies (ctranslate2, onnxruntime) lag new
Python releases. The Argos models for the `--load-only` list in `serve.cmd` download on first start
into `%USERPROFILE%\.local\share\argos-translate` (4.1 GB for the 20-language list on 10-12; first start took about 2 min 46 s). Norwegian is `nb` in Argos; the relay
maps the client's ISO `no` to it.

## Run

- `serve.cmd` runs LibreTranslate in the foreground and appends to `libretranslate.log`.
- `svc-libretranslate.vbs` runs `serve.cmd` with no window and restarts it 15 s after any exit.

Check it: `curl -X POST http://127.0.0.1:5000/translate -d q=hello -d source=en -d target=de`

## Scheduled task (owner: run once in an ELEVATED PowerShell)

Registering a task needs elevation, which the build agent did not have. Paste this into an
administrator PowerShell:

```powershell
$action    = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '//B "C:\Users\Jay\Documents\Claude\bb-tournament-validator\apps\config-web\tools\libretranslate\svc-libretranslate.vbs"'
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User "Jay"
$settings  = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "Jay" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "Super FUMBBL LibreTranslate" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Local LibreTranslate on 127.0.0.1:5000 for config-web /api/translate (chat auto-translate)."
```

Before the first `Start-ScheduledTask -TaskName "Super FUMBBL LibreTranslate"`, stop any copy that
was started by hand (it holds port 5000): find it with
`Get-CimInstance Win32_Process -Filter "Name='libretranslate.exe'" | Select ProcessId, CommandLine`
and stop that PID only (`Stop-Process -Id <pid>`), never by image name.

The task runs `wscript` (hidden) → `svc-libretranslate.vbs` (waits + restart loop) → `serve.cmd`.
Because the VBS waits, the task shows **Running** while LibreTranslate is up.

## config-web settings

`apps/config-web/.env` (see `.env.example`): `TRANSLATE_PROVIDER=libretranslate` (default),
`LIBRETRANSLATE_URL=http://127.0.0.1:5000` (default). Switch to `azure`, `deepl` or `off` there and
restart config-web.
