@echo off
rem MAGENTRA terminal command. Installed to <install dir>\bin by the NSIS
rem setup (see build/installer.nsh), which also puts that dir on the user
rem PATH. Runs the terminal UI through Electron's own Node — no system Node
rem needed. A cmd shim cannot test for a TTY, so the TUI itself hands over to
rem the desktop app when run without one (or with --gui).
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\MAGENTRA.exe" "%~dp0..\resources\engine\tui.mjs" %*
endlocal
