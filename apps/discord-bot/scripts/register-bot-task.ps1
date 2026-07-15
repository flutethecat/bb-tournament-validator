# Registers the "FUMBBL40k discord-bot" scheduled task (durable hosting, mirrors the
# "FUMBBL40k config-web" task). Registering a scheduled task needs elevation, so:
#   RIGHT-CLICK PowerShell -> "Run as administrator", then run this script once.
# It runs the bot at logon (non-elevated, as you), restarts on failure (3x / 1 min),
# no time limit. After registering, it starts the task immediately.
# NOTE: if another bot instance is already running (e.g. a `pnpm start` process), stop it
# first so you don't get two bots double-answering commands / double-announcing.

$action    = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument '/c "C:\Users\Jay\Documents\Claude\bb-tournament-validator\apps\discord-bot\scripts\serve-bot.cmd"'
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'FUMBBL40k discord-bot' -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force `
  -Description 'FUMBBL40k Discord bot (slash cmds + tag-gated build-announce poller + daily summary). Durable hosting, 2026-07-09.'

Write-Host "Registered. Starting the task now..."
Start-ScheduledTask -TaskName 'FUMBBL40k discord-bot'
Start-Sleep -Seconds 4
Get-ScheduledTask -TaskName 'FUMBBL40k discord-bot' | Select-Object TaskName, State
