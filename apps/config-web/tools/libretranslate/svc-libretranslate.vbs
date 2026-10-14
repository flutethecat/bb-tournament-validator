' Super FUMBBL LibreTranslate - hidden-window launcher for the "Super FUMBBL LibreTranslate" scheduled task.
' Runs serve.cmd with no console window and WAITS for it, so the task shows Running while LibreTranslate
' lives; if LibreTranslate exits or crashes it is restarted after 15 s (Task Scheduler's own
' restart-on-failure only covers launch failures, so the loop lives here).
Set sh = CreateObject("WScript.Shell")
Do
  sh.Run "cmd /c ""C:\Users\Jay\Documents\Claude\bb-tournament-validator\apps\config-web\tools\libretranslate\serve.cmd""", 0, True
  WScript.Sleep 15000
Loop
