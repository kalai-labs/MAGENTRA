@echo off
rem MAGENTRA terminal command. Installed to <install dir>\bin by the NSIS
rem setup (see build/installer.nsh), which also puts that dir on the user
rem PATH. Runs the terminal UI through Electron's own Node - no system Node
rem needed.
rem
rem The CON redirections are load-bearing: MAGENTRA.exe is a GUI-subsystem
rem binary, and cmd starts those with NO console handles - under
rem ELECTRON_RUN_AS_NODE that means stdin/stdout.isTTY are false and the TUI
rem correctly hands off to the desktop app (the exact field bug: `magentra`
rem opened the GUI). Redirecting to the CON device hands the child real
rem console handles, so libuv sees a TTY and raw-mode input works. Cost: this
rem shim is for interactive use - piping `magentra ... | foo` sees CON, not
rem the pipe. The TUI still guards the no-console case itself (--gui/no-TTY
rem hands off to the GUI), so a windowless launch of this shim stays safe.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\MAGENTRA.exe" "%~dp0..\resources\engine\tui.mjs" %* <CON >CON 2>CON
endlocal
