@echo off
setlocal
cd /d "%~dp0"

REM ---------------------------------------------------------------
REM  CheckMate - push.bat
REM  First run: turns this folder into the repo and pushes it.
REM  Every run after that: commits whatever changed and pushes.
REM  Optional message:  push.bat "fixed the estimate chips"
REM ---------------------------------------------------------------

where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Git is not installed, or not on your PATH.
  echo   Get it from https://git-scm.com/download/win then run this again.
  echo.
  pause
  exit /b 1
)

if not exist ".git" (
  echo.
  echo   First run - setting this folder up as the CheckMate repo.
  echo.
  git init
  git branch -M main
  git remote add origin https://github.com/jaschro/CheckMate.git
  echo.
  echo   A browser window may open asking you to sign in to GitHub.
  echo   That is Git asking for permission to push. Approve it.
  echo.
)

git add -A

git diff --cached --quiet
if not errorlevel 1 (
  echo.
  echo   Nothing has changed since the last push.
  echo.
  pause
  exit /b 0
)

set "MSG=%~1"
if "%MSG%"=="" set "MSG=CheckMate update"
git commit -m "%MSG%"

git push -u origin main
if errorlevel 1 (
  echo.
  echo   The push failed. The usual causes:
  echo     - the repo does not exist yet at github.com/jaschro/CheckMate
  echo     - you cancelled the GitHub sign-in window
  echo     - someone pushed since you last pulled  ^(run: git pull --rebase^)
  echo.
  pause
  exit /b 1
)

echo.
echo   Pushed. Reload the app to pick it up.
echo.
pause
