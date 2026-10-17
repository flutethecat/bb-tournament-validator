@echo off
REM FUMBBL40k Discord bot — kept running by the "FUMBBL40k discord-bot" scheduled task
REM (Yularen-approved durability 2026-07-09; previously a manual `tsx src/index.ts` process).
REM Hosts the /bbbot slash commands + the build-announce poller (now TAG-GATED, a687c4b) and
REM the daily-summary poller. Mirrors config-web/scripts/serve.cmd so both run identically
REM under Task Scheduler. Invokes tsx via node with explicit paths for the Task Scheduler env.
set "PATH=C:\Program Files\nodejs;%PATH%"
set "BOTDIR=C:\Users\Jay\Documents\Claude\bb-tournament-validator\apps\discord-bot"
set "LOG=%BOTDIR%\data-store\discord-bot.log"
cd /d "%BOTDIR%"
REM Owner 10-16: the task never restarted an exited bot (down 10-15 16:35 -> 10-16 17:47); this loop does, after 15 s.
:loop
echo ---- %DATE% %TIME% starting discord-bot ---- >> "%LOG%"
call "%BOTDIR%\node_modules\.bin\tsx.CMD" src\index.ts >> "%LOG%" 2>&1
echo ---- %DATE% %TIME% discord-bot EXITED - restarting in 15 s ---- >> "%LOG%"
timeout /t 15 /nobreak > nul
goto loop
