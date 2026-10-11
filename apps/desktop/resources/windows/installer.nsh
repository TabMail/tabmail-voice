; This Source Code Form is subject to the terms of the Mozilla Public
; License, v. 2.0. If a copy of the MPL was not distributed with this
; file, You can obtain one at https://mozilla.org/MPL/2.0/.

; The Visual C++ runtime, installed system-wide where Windows Update services it (ADR-DESK-057).
; The helpers, the Rust core and the keyring addon import it, and Windows does not ship it. Before
; anything is installed or replaced, the installer checks the runtime Windows has for the app's
; architecture, and runs Microsoft's installer of it (scripts/windows/build-native.mts copies it
; from the build's Visual Studio) when it is missing or older than that one. Microsoft's installer
; asks for an administrator; refused or failed, or until Windows restarts when it asks to, TabMail
; Voice is not installed, and an installed version stays as it was.

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

!macro customInit
  !insertmacro voiceRuntimeInstalled
  ${If} $R0 <> 1
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
      SetErrorLevel 2
      Quit
    ${EndIf}
    ; 3010 and 1641: the runtime's files in use are replaced when Windows restarts, and until then
    ; the app would load the old ones, so it is installed after the restart.
    ${If} $R4 = 3010
    ${OrIf} $R4 = 1641
      MessageBox MB_OK|MB_ICONINFORMATION "Restart Windows to finish installing the Microsoft Visual C++ Runtime, then run the TabMail Voice installer again." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend
