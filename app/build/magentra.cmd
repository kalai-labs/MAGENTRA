@echo off
rem MAGENTRA terminal command. Installed to <install dir>\bin by the NSIS
rem setup (see build/installer.nsh), which also puts that dir on the user
rem PATH. Runs the terminal UI through Electron's own Node - no system Node
rem needed.
rem
rem It runs magentra-cli.exe - the console-subsystem copy of MAGENTRA.exe
rem that scripts/afterPack.js writes into every Windows build - NOT the GUI
rem exe. A GUI-subsystem binary never attaches to the launching console, so
rem under ELECTRON_RUN_AS_NODE libuv finds no TTY and the terminal UI cannot
rem read keys (verified in a real conhost; explicit CON redirection does not
rem help either). The console copy attaches like any CLI: real TTY, raw-mode
rem input, working pipes, and a propagated exit code.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\magentra-cli.exe" "%~dp0..\resources\engine\tui.mjs" %*
rem %ERRORLEVEL% expands before endlocal runs, so the TUI's exit code survives
rem the scope teardown - a bare `endlocal` as the last line reported 0 always.
endlocal & exit /b %ERRORLEVEL%
