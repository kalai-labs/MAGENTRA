; MAGENTRA installer additions: the `magentra` terminal command.
;
; customInstall drops bin\magentra.cmd into the install dir and appends
; $INSTDIR\bin to the USER (HKCU) PATH; customUnInstall reverses both. The
; setup defaults to a per-user install, so HKCU is the right hive; an elevated
; all-users install updates the elevating user's PATH — documented limitation.
;
; Deliberately self-contained: electron-builder compiles with warnings as
; errors, and NSIS zeroes out any defined-but-unreferenced function (warning
; 6010) — StrFunc.nsh's declare-then-call pattern tripped exactly that. So the
; one string helper this file needs is defined here via the classic `un.`
; macro trick. Register-only (saved/restored) — no global Vars to collide
; with the electron-builder template's own.
;
; PASS GUARDS ARE LOAD-BEARING: electron-builder compiles installer.nsi TWICE
; — once with BUILD_UNINSTALLER (which includes uninstaller.nsh/customUnInstall
; and SKIPS installSection.nsh/customInstall) and once without (the reverse).
; A function variant defined in the pass that never references it is warning
; 6010 again, so each variant exists only in its own pass.

!include "WinMessages.nsh"

; magentraStrLoc: Push haystack, Push needle, Call — Pop offset ("" if absent).
!macro MAGENTRA_STRLOC un
Function ${un}magentraStrLoc
  Exch $R0        ; needle
  Exch
  Exch $R1        ; haystack
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrLen $R2 $R0  ; needle length
  StrLen $R3 $R1  ; haystack length
  StrCpy $R4 0    ; scan index
  loop:
    StrCpy $R5 $R1 $R2 $R4
    StrCmp $R5 $R0 found
    IntCmp $R4 $R3 notfound
    IntOp $R4 $R4 + 1
    Goto loop
  found:
    StrCpy $R0 $R4
    Goto done
  notfound:
    StrCpy $R0 ""
  done:
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0        ; result out, caller's $R0 restored
FunctionEnd
!macroend

!ifndef BUILD_UNINSTALLER
  !insertmacro MAGENTRA_STRLOC ""
!endif
!ifdef BUILD_UNINSTALLER
  !insertmacro MAGENTRA_STRLOC "un."
!endif

!macro customInstall
  CreateDirectory "$INSTDIR\bin"
  SetOutPath "$INSTDIR\bin"
  File "${BUILD_RESOURCES_DIR}\magentra.cmd"
  ; Restore immediately: OutPath is global NSIS state, and the template's
  ; finish-page "Run MAGENTRA" launches with the CURRENT OutPath as the app's
  ; working directory — leaving it at bin\ ships a subtly wrong first launch.
  SetOutPath "$INSTDIR"

  ReadRegStr $0 HKCU "Environment" "Path"
  Push $0
  Push "$INSTDIR\bin"
  Call magentraStrLoc
  Pop $1
  StrCmp $1 "" 0 magentraPathDone            ; found ⇒ already on PATH
  StrCmp $0 "" 0 magentraPathAppend
    WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR\bin"
    Goto magentraPathNotify
magentraPathAppend:
  WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR\bin"
magentraPathNotify:
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
magentraPathDone:
!macroend

!macro customUnInstall
  Delete "$INSTDIR\bin\magentra.cmd"
  RMDir "$INSTDIR\bin"

  ReadRegStr $0 HKCU "Environment" "Path"
  StrCmp $0 "" magentraUnDone                ; no user PATH at all
  StrCmp $0 "$INSTDIR\bin" 0 magentraUnMid
    DeleteRegValue HKCU "Environment" "Path" ; PATH was exactly our entry
    Goto magentraUnNotify

magentraUnMid:
  ; The appended form we write: "...;$INSTDIR\bin" (possibly mid-string after
  ; later appends by other software).
  Push $0
  Push ";$INSTDIR\bin"
  Call un.magentraStrLoc
  Pop $1
  StrCmp $1 "" magentraUnLead
    StrCpy $2 $0 $1                          ; before the match
    StrLen $3 ";$INSTDIR\bin"
    IntOp $4 $1 + $3
    StrCpy $5 $0 "" $4                       ; after the match
    WriteRegExpandStr HKCU "Environment" "Path" "$2$5"
    Goto magentraUnNotify

magentraUnLead:
  ; Leading form: we wrote a bare entry into an empty PATH and something later
  ; appended after it — "$INSTDIR\bin;rest".
  Push $0
  Push "$INSTDIR\bin;"
  Call un.magentraStrLoc
  Pop $1
  StrCmp $1 "0" 0 magentraUnDone             ; only honor it at position 0
    StrLen $3 "$INSTDIR\bin;"
    StrCpy $5 $0 "" $3
    WriteRegExpandStr HKCU "Environment" "Path" "$5"
    Goto magentraUnNotify

magentraUnNotify:
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
magentraUnDone:
!macroend
