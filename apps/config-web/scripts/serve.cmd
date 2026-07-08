@echo off
REM FUMBBL40k config-web server — kept running by the "FUMBBL40k config-web" scheduled task
REM (owner directive 2026-07-08: config-web must stay up unless otherwise directed).
REM Serves the /api/fork/* routes (Register, one-click Launch, Create Game team-library +
REM matchmaking) on :4310. Register + Create Game in the client hard-require this to be up.
REM Invokes tsx via node with explicit paths so it works in the Task Scheduler env.
set "PATH=C:\Program Files\nodejs;%PATH%"
set "WEBDIR=C:\Users\Jay\Documents\Claude\bb-tournament-validator\apps\config-web"
set "LOG=%WEBDIR%\data-store\config-web.log"
cd /d "%WEBDIR%"
echo ---- %DATE% %TIME% starting config-web ---- >> "%LOG%"
call "%WEBDIR%\node_modules\.bin\tsx.CMD" src\server.ts >> "%LOG%" 2>&1
echo ---- %DATE% %TIME% config-web EXITED (task will restart per settings) ---- >> "%LOG%"
