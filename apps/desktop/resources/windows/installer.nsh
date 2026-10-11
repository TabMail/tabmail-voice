; This Source Code Form is subject to the terms of the Mozilla Public
; License, v. 2.0. If a copy of the MPL was not distributed with this
; file, You can obtain one at https://mozilla.org/MPL/2.0/.

; The Visual C++ runtime, installed system-wide where Windows Update services it (ADR-DESK-057).
; The helpers, the Rust core and the keyring addon import it, and Windows does not ship it. Before
; anything is installed or replaced, the installer checks the runtime Windows has for the app's
; architecture, and runs Microsoft's installer of it (scripts/windows/build-native.mts copies it
; from the build's Visual Studio) when it is missing or older than that one. Microsoft's installer
; asks for an administrator; refused or failed, TabMail Voice is not installed, and an installed
; version stays as it was (and opens again when it asked for the update as it quit).

!ifndef APP_ARM64
  !ifndef APP_64
    !error "The installer carries one architecture's Visual C++ runtime"
  !endif
!else ifdef APP_64
  !error "The installer carries one architecture's Visual C++ runtime"
!endif
!ifdef APP_ARM64
  !define VOICE_RUNTIME_KEY "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\arm64"
!else
  !define VOICE_RUNTIME_KEY "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
!endif
; How long an update waits for the app it replaces, which quits for it, to end (and again after
; ending it): the most checks, and the milliseconds between them.
!define VOICE_APP_QUIT_CHECKS 20
!define VOICE_APP_QUIT_INTERVAL 500
; VOICE_RUNTIME_1 to VOICE_RUNTIME_4: the runtime's version (major, minor, build, revision), as
; Microsoft's installer carries it.
!getdllversion "${PROJECT_DIR}\dist\runtime\vc_redist.exe" VOICE_RUNTIME_

; Compares one part of the version VOICE_RUNTIME_KEY records with the carried one, while the parts
; before it were equal ($R1 = 1): newer sets $R1 to 2, older to 0. A part not recorded counts as 0.
!macro voiceRuntimePart NAME CARRIED
  ${If} $R1 = 1
    ReadRegDWORD $R2 HKLM "${VOICE_RUNTIME_KEY}" "${NAME}"
    ${If} $R2 > ${CARRIED}
      StrCpy $R1 2
    ${ElseIf} $R2 < ${CARRIED}
      StrCpy $R1 0
    ${EndIf}
  ${EndIf}
!macroend

; Sets $R0 to 1 when VOICE_RUNTIME_KEY in this registry view records the runtime installed, at the
; carried version or later.
!macro voiceRuntimeInstalledIn VIEW
  SetRegView ${VIEW}
  ReadRegDWORD $R1 HKLM "${VOICE_RUNTIME_KEY}" "Installed"
  ${If} $R1 = 1
    !insertmacro voiceRuntimePart Major ${VOICE_RUNTIME_1}
    !insertmacro voiceRuntimePart Minor ${VOICE_RUNTIME_2}
    !insertmacro voiceRuntimePart Bld ${VOICE_RUNTIME_3}
    !insertmacro voiceRuntimePart Rbld ${VOICE_RUNTIME_4}
    ${If} $R1 <> 0
      StrCpy $R0 1
    ${EndIf}
  ${EndIf}
!macroend

; $R0 is 1 when Windows has the runtime at the carried version or later. Microsoft documents
; the key in the 32-bit view, and some machines record it only in the 64-bit one: either counts. The
; 64-bit view, read last, stays set, as electron-builder set it.
!macro voiceRuntimeInstalled
  StrCpy $R0 0
  !insertmacro voiceRuntimeInstalledIn 32
  !insertmacro voiceRuntimeInstalledIn 64
!macroend

; Waits, at most VOICE_APP_QUIT_CHECKS times, while the installed app is running: Windows doesn't
; let a running program's file be opened for writing (nothing is written to it). $R7 is 1 once it
; isn't running, 0 if it still was at the last check.
!macro voiceAppEnded
  StrCpy $R7 1
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $R5 1
    ${Do}
      ClearErrors
      FileOpen $R6 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
      ${IfNot} ${Errors}
        FileClose $R6
        ${Break}
      ${EndIf}
      ${If} $R5 >= ${VOICE_APP_QUIT_CHECKS}
        StrCpy $R7 0
        ${Break}
      ${EndIf}
      IntOp $R5 $R5 + 1
      Sleep ${VOICE_APP_QUIT_INTERVAL}
    ${Loop}
  ${EndIf}
!macroend

; The app an update replaces has quit for it; one still running after the wait is ended, as
; electron-builder ends it in an update (the user's own processes of the app's program).
!macro voiceAwaitAppQuit
  !insertmacro voiceAppEnded
  ${If} $R7 <> 1
    nsExec::Exec '"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"'
    Pop $R6
    !insertmacro voiceAppEnded
  ${EndIf}
!macroend

!macro customInit
  !insertmacro voiceRuntimeInstalled
  ${If} $R0 <> 1
    ; An update the app runs (--updated) starts as the app quits: Microsoft's installer runs, and the
    ; app is opened again below, once it has ended (electron-builder closes it later, after this).
    StrCpy $R7 0
    ${If} ${isUpdated}
      !insertmacro voiceAwaitAppQuit
    ${EndIf}
    InitPluginsDir
    File "/oname=$PLUGINSDIR\vc_redist.exe" "${PROJECT_DIR}\dist\runtime\vc_redist.exe"
    ; A silent install (an update the app runs as it quits) shows only Windows' administrator
    ; prompt; otherwise Microsoft's installer shows its progress.
    ${If} ${Silent}
      ExecWait '"$PLUGINSDIR\vc_redist.exe" /install /quiet /norestart' $R4
    ${Else}
      ExecWait '"$PLUGINSDIR\vc_redist.exe" /install /passive /norestart' $R4
    ${EndIf}
    Delete "$PLUGINSDIR\vc_redist.exe"
    !insertmacro voiceRuntimeInstalled
    ${If} $R0 <> 1
      MessageBox MB_OK|MB_ICONSTOP "TabMail Voice needs the Microsoft Visual C++ Runtime, which wasn't installed. Run the installer again and allow the runtime to install." /SD IDOK
      ; Restart Now quit the app for its update (--force-run): it opens again as it was, as
      ; electron-builder opens an installed one, and says the update didn't install (ADR-DESK-050).
      ; Only once the app it replaces has ended, whose single-instance lock it would otherwise lose.
      ${If} ${isForceRun}
      ${AndIf} $R7 = 1
        ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${EndIf}
    ; Microsoft's installer asks for a restart (3010, or 1641) when runtime files were in use: the new
    ; ones are already in place, which the app loads when it starts, and the old ones are removed at
    ; the restart. As standard installers do, the app is installed, and the user is told at the end.
    ${If} $R4 = 3010
    ${OrIf} $R4 = 1641
      SetRebootFlag true
    ${EndIf}
  ${EndIf}
!macroend

; electron-builder's one-click installer has no finish page to offer the restart: an interactive
; install says so once the app is installed. Nothing restarts Windows.
!macro customInstall
  ${If} ${RebootFlag}
    MessageBox MB_OK|MB_ICONINFORMATION "TabMail Voice is installed. Restart Windows when you can to finish installing the Microsoft Visual C++ Runtime." /SD IDOK
  ${EndIf}
!macroend
