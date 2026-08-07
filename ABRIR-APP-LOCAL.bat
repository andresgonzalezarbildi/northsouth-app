@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo No se encontro npm. Instala Node.js y volve a ejecutar este archivo.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo Preparando la app por primera vez...
  call npm install
  if errorlevel 1 (
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:5173"
call npm run dev
