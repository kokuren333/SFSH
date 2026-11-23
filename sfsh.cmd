@ECHO off
REM SFSH CLI launcher for Windows: .\sfsh.cmd <command> [args]
SETLOCAL
node "%~dp0harness\bin\sfsh.js" %*
EXIT /b %ERRORLEVEL%
