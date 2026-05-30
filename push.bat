@echo off
:: ============================================================
::  Auto Editor PPRO - git push rapido
::  Duplo-clique pra subir o commit local pro GitHub.
:: ============================================================
:: %~dp0 = pasta deste .bat (com / no fim). cd /d funciona entre drives.
cd /d "%~dp0"

echo.
echo === git status ===
git status
echo.

echo === git push ===
git push

echo.
echo ============================================================
pause
