@echo off
REM Super FUMBBL LibreTranslate - local translation backend for config-web's POST /api/translate
REM (owner 10-12: chat auto-translate, "LibreTranslate first with a provider switch behind it").
REM Kept running by the "Super FUMBBL LibreTranslate" scheduled task (see README.md in this folder).
REM Binds 127.0.0.1 ONLY: config-web is the public face (rate limit, cache, CORS); never 0.0.0.0.
REM Norwegian is "nb" in Argos (the relay maps the client's ISO "no" to it).
REM The Argos models for --load-only download on first start into %USERPROFILE%\.local\share\argos-translate.
set "LTDIR=C:\Users\Jay\Documents\Claude\bb-tournament-validator\apps\config-web\tools\libretranslate"
set "LOG=%LTDIR%\libretranslate.log"
set "PYTHONIOENCODING=utf-8"
cd /d "%LTDIR%"
echo ---- %DATE% %TIME% starting LibreTranslate ---- >> "%LOG%"
call "%LTDIR%\.venv\Scripts\libretranslate.exe" --host 127.0.0.1 --port 5000 --load-only en,de,fr,es,it,pt,nl,pl,ru,sv,da,fi,nb,cs,hu,el,tr,uk,ja,zh >> "%LOG%" 2>&1
echo ---- %DATE% %TIME% LibreTranslate EXITED (task will restart per settings) ---- >> "%LOG%"
