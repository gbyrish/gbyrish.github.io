@echo off
title Gbyrish local server (AI enabled)
cd /d "%~dp0"
echo Starting Gbyrish on http://localhost:8080 ...
start "" http://localhost:8080
node server/dev.js
pause
