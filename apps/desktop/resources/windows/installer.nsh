; This Source Code Form is subject to the terms of the Mozilla Public
; License, v. 2.0. If a copy of the MPL was not distributed with this
; file, You can obtain one at https://mozilla.org/MPL/2.0/.

; The Visual C++ runtime, installed system-wide where Windows Update services it (ADR-DESK-057).
; The helpers, the Rust core and the keyring addon import it, and Windows does not ship it. Before
; anything is installed or replaced, the installer checks the runtime Windows has for the app's
; architecture, and runs Microsoft's installer of it (scripts/windows/build-native.mts copies it
; from the build's Visual Studio) when it is missing or older than that one. Microsoft's installer
; asks for an administrator; refused or failed, TabMail Voice is not installed, and an installed
; version stays as it was.

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
; VOICE_RUNTIME_1 and VOICE_RUNTIME_2: the runtime's major and minor version, as Microsoft's
; installer carries them.
!getdllversion "${PROJECT_DIR}\dist\runtime\vc_redist.exe" VOICE_RUNTIME_

; $R0 is 1 when Windows has the runtime at that major and minor version or later (Microsoft keeps
; the installed version in VOICE_RUNTIME_KEY, read in the 64-bit view electron-builder sets).
!macro voiceRuntimeInstalled
  StrCpy $R0 0
  ReadRegDWORD $R1 HKLM "${VOICE_RUNTIME_KEY}" "Installed"
  ReadRegDWORD $R2 HKLM "${VOICE_RUNTIME_KEY}" "Major"
  ReadRegDWORD $R3 HKLM "${VOICE_RUNTIME_KEY}" "Minor"
  ${If} $R1 = 1
    ${If} $R2 > ${VOICE_RUNTIME_1}
      StrCpy $R0 1
    ${ElseIf} $R2 = ${VOICE_RUNTIME_1}
    ${AndIf} $R3 >= ${VOICE_RUNTIME_2}
      StrCpy $R0 1
    ${EndIf}
  ${EndIf}
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
    ; 3010: Microsoft's installer finishes replacing files in use when Windows restarts.
    ${If} $R4 = 3010
      MessageBox MB_OK|MB_ICONINFORMATION "Restart Windows to finish installing the Microsoft Visual C++ Runtime." /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend
