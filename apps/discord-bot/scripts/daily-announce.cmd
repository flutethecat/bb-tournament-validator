@echo off
REM Daily FUMBBL40k build announce - run by the scheduled task at 09:00 local (Pacific).
REM Publishes the latest build to the Discord announce channel if it is new (de-duped).
REM Invokes tsx via node with explicit paths so it works in the Task Scheduler env.
set "PATH=C:\Program Files\nodejs;%PATH%"
set "BOTDIR=C:\Users\Jay\Documents\Claude\bb-tournament-validator\apps\discord-bot"
set "LOG=%BOTDIR%\data-store\announce.log"
cd /d "%BOTDIR%"
echo ---- %DATE% %TIME% ---- >> "%LOG%"
call "%BOTDIR%\node_modules\.bin\tsx.CMD" src\announceOnce.ts >> "%LOG%" 2>&1
