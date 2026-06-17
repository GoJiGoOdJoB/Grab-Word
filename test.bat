@echo off
title Grab-Word Dev Server
echo Starting server at http://localhost:3000 ...
start http://localhost:3000
npx serve . -p 3000 -s
pause
