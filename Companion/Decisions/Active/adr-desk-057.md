## ADR-DESK-057: On Windows, the Visual C++ runtime is installed system-wide by the installer

**Context:** The Windows helpers, the Rust core and the keyring addon (`@napi-rs/keyring`, prebuilt
by its maintainers) import the Visual C++ runtime (`vcruntime140.dll`, `msvcp140.dll`), which
Windows does not ship; only the Universal CRT is part of Windows. The first hosted-runner builds
found every helper and the addon would fail to load on a machine without Visual Studio. A first fix
linked the runtime into the helpers and the core statically and shipped `vcruntime140.dll` beside
the addon. Owner, 2026-10-10: rely on the DLL, "the proper commercial software way". Microsoft's
guidance (Learn, "Choose a deployment method" and "Deployment in Visual C++") prefers the
Redistributable installed centrally over a local copy or static linking, because Windows Update can
service a central runtime and neither of the others; and the runtime must be at least as new as the
newest toolset that built any binary using it (the first fix shipped runtime 14.44 beside an addon
built with 14.51).

**Decision:**
- Nothing links the runtime in (`CMAKE_MSVC_RUNTIME_LIBRARY` and `+crt-static` are unset: the
  defaults, the DLL runtime) and the app ships no copy of it.
- The Windows build copies Microsoft's installer of the runtime for its architecture
  (`vc_redist.<arch>.exe`, signed by Microsoft) from the newest version its Visual Studio
  redistributes, to `dist/runtime/vc_redist.exe` (`runtimeInstaller` in
  `scripts/windows/build-native.mts`).
- The installer (`resources/windows/installer.nsh`, electron-builder's `customInit`) carries it and,
  before anything is installed or replaced, reads the installed runtime of its architecture where
  Microsoft records it (`HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\<arch>`: `Installed`,
  `Major`, `Minor`, `Bld`, `Rbld`; documented in the 32-bit registry view, and found only in the
  64-bit one on some machines, so either counts). When it is missing or its version, compared part by
  part (major, minor, build, revision; a part not recorded counts as 0), is older than the carried
  installer's (read from that file when the installer is built), it runs Microsoft's installer
  (`/install /passive /norestart`, `/quiet` in a silent install such as the update the app runs as
  it quits), which asks for an administrator, and reads the version again. Still missing or older,
  TabMail Voice says so and is not installed (exit 2): the version already installed stays as it was,
  and an update reports it didn't install (ADR-DESK-050). An update Restart Now ran (`--force-run`,
  the app having quit for it) opens that version again, as electron-builder opens an installed app,
  so the user is not left without it and sees at once that the update didn't install. An update the
  app runs (`--updated`) starts as the app quits, so before Microsoft's installer runs it waits, at
  most 10 seconds, until the app has ended (Windows doesn't let a running program's file be opened
  for writing); one still running then is ended with `taskkill`, as electron-builder ends it in an
  update, and checked again for as long. Microsoft's installer then doesn't find the app holding the
  runtime, and the app is opened again only once the one it replaces has ended, so it keeps its
  single-instance lock (an app that can't be seen to end isn't opened again). An install that isn't
  an update doesn't wait; electron-builder asks to close the app afterwards, as before. When Microsoft's installer asks for a
  restart (3010, or 1641), the app is installed as usual, and an interactive install then says to
  restart Windows when convenient; a silent one says nothing, and nothing restarts Windows. That is
  what standard installers do (Wireshark's NSIS installer sets the reboot flag and continues; WiX
  Burn's `scheduleReboot` continues and asks at the end). Measured (2026-10-10, Windows 11 ARM64,
  runtime 14.44 held in use, 14.51 installed over it): Windows Installer moved the files in use aside,
  put the new ones in place at once (a new process loaded 14.51), and scheduled only the old copies'
  deletion for the restart. Accepted (owner, 2026-10-10): should Windows be unable to move a file in
  use aside and schedule its replacement for the restart instead, the app may load the old runtime
  until then.
- The release (`tabmail-release-helpers`) checks that the runtime installer is signed by Microsoft,
  that no installed file was built with a newer Visual C++ (its linker version) than that installer,
  and that no copy of the runtime is installed with the app.

**Consequences:**
- A user without the runtime, or with an older one, sees Windows' administrator prompt once when
  installing, or when an update carries a newer runtime than the one installed (the build takes the
  newest its Visual Studio redistributes, so a Visual Studio update can bring one); one without an administrator
  can't install TabMail Voice until someone installs the runtime. Everyone else installs for
  themselves with no prompt, as before.
- The installer is larger by Microsoft's installer (about 20 MB on x64).
- Electron itself links its runtime statically; that is Electron's choice, not ours.
- A runner whose Visual Studio redistributes an older runtime than a prebuilt addon was built with
  fails the release rather than shipping it; the x64 Windows build runs on a runner with Visual
  Studio 2026.

---

