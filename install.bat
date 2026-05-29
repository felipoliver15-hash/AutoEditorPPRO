@echo off
echo ============================================================
echo  Auto Editor PPRO - Instalador
echo ============================================================
echo.

:: Destino do plugin CEP
set DEST=%APPDATA%\Adobe\CEP\extensions\AutoEditorPPRO

echo Instalando em: %DEST%
echo.

:: Cria a pasta de destino
if not exist "%DEST%" mkdir "%DEST%"

:: Copia todos os arquivos
xcopy /E /Y /I "%~dp0*" "%DEST%\" >nul

echo [OK] Arquivos copiados.

:: Habilita extensoes nao assinadas no Premiere (PlayerDebugMode)
echo.
echo Habilitando modo de extensoes de desenvolvimento...
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1

echo [OK] PlayerDebugMode ativado para CSXS 11 e 12.
echo.
echo ============================================================
echo  PRONTO!
echo  - Feche e reabra o Adobe Premiere Pro 2025
echo  - Va em: Janela > Extensoes > Auto Editor
echo ============================================================
echo.
pause
