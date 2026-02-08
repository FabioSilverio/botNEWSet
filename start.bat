@echo off
title News Aggregator Bot
cd /d "%~dp0"

echo ============================================
echo   News Aggregator Bot - Iniciando...
echo ============================================
echo.

:: Mata qualquer instancia anterior do bot
taskkill /F /IM node.exe >nul 2>&1

:: Espera 2 segundos pra limpar
timeout /t 2 /nobreak >nul

:: Compila TypeScript
echo Compilando TypeScript...
call npx tsc
if %ERRORLEVEL% NEQ 0 (
    echo ERRO: Falha na compilacao!
    pause
    exit /b 1
)

echo Compilado com sucesso!
echo.

:: Inicia o runner (supervisor que reinicia automaticamente)
echo Iniciando bot com supervisor...
echo O bot vai reiniciar automaticamente se cair.
echo Feche esta janela para parar o bot.
echo.
echo ============================================
echo.

node runner.js
