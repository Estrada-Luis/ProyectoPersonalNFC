@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo        CompraNFC - Lista NFC
echo ==========================================
echo.
echo Actualizando catalogo de productos...
node sync-catalog.js
if errorlevel 1 echo No se pudo actualizar el catalogo. Se usara el catalogo local.
echo.
node server.js
pause
