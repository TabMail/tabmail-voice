## ADR-DESK-050: Windows and Linux update themselves too, from signed packages proven by the app

> **Linux half SUPERSEDED by ADR-DESK-058 (owner 2026-10-11):** Linux updates through a signed apt
> repository instead. The app's Linux updater (`install-update`, its polkit action and keys, the
> `DebUpdater` download, the Linux question and Installing state, the `pkexec` AppArmor rule and the
> `openssl` and `pkexec` dependencies) was removed in 0.2.1. It had never been on: no key ever
> shipped in `update-keys/`, and no release wrote a Linux feed. The Windows half stands.

**Context:** ADR-DESK-041 gave macOS automatic updates; Windows and Linux had none (`publish: null`).
Owner, 2026-10-04: shared update logic with thin per-OS install adapters; the macOS security and
behavior kept; a feed per architecture for the signed Windows NSIS installer; on Ubuntu a direct
`.deb` with an explicit install that asks for an administrator, no silent install and no APT
repository unless one proves necessary; verified signatures, protection against downgrades, honest
failed and retry states, and real installed upgrades tested on all three platforms.
`electron-updater` 6.8.9, read before use, can't be trusted as it ships on either OS:
`NsisUpdater` accepts an installer when no publisher is configured, and when PowerShell can't run
`Get-AuthenticodeSignature`; `DebUpdater` installs with `dpkg -i` through `pkexec` and, if that
fails, `apt-get install -f -y --allow-unauthenticated --allow-downgrades`, vouched for by nothing but
the feed's own SHA-512.

**Decision:**
- **One `Updater`, one adapter per OS** (`src/main/updater.ts`; `src/main/native/<os>/update.ts`). The
  `Updater` decides when to look, downloads, keeps the state the menu and Settings show, asks once per
  version, retries and says why something failed, the same everywhere. An `UpdatePlatform` says only
  how a downloaded update is proven ours (`verify`) and how it is installed (`install`), and whether it
  installs when the app quits (macOS, Windows) or when the user installs it (Linux).
- **Never older, never the same.** `allowDowngrade` is off and `channel` is never set (it would turn
  downgrades on); `Updater` refuses any downloaded version not a later x.y.z than the running one; and
  each platform's proof binds the version to the signed file, so a feed can't name an older signed
  build as newer.
- **Windows** (`NsisUpdater`, feed `https://cdn.tabmail.ai/releases/voice/windows-${arch}`, one per
  architecture, `latest.yml`): the library's own signature check is replaced. Before a download is
  kept, `voice-windows.exe --verify-update <file>` asks `WinVerifyTrust` (the chain to a trusted root,
  revocation checked) and reads the certificate's common name and organization and the installer's
  signed product version. The app keeps it only when it is valid, both names are
  `windowsUpdatePublisher` ("Lisem AI LTD", as the release's signing certificate names them) and the
  product version is the offered version's four-part form (x.y.z.0). Otherwise the library deletes the
  download, and the user sees "Version x.y.z isn't signed by TabMail, so it wasn't installed." The
  library skips that check for an installer it already has whose SHA-512 is the feed's, so the
  installer kept is proven the same way again (`UpdatePlatform.verify`) before it is offered; a feed
  can't name a cached older installer as newer either. What the library kept installs at the quit
  only when the update is ready (proven): `autoInstallOnAppQuit` stays on while the app runs, since
  the library arms its quit-time install only for a download that finishes with it on, and as the app
  quits (`before-quit`, ahead of the library's `quit`) `Updater.quitting` turns it off unless the
  state is ready. An installer refused, not newer, or still being proven never installs at the quit.
  It
  installs when the app quits, or at once with Restart Now, quietly and for this user (no
  administrator), and the new version opens. *(Amended by ADR-DESK-057, 2026-10-10: an update that
  carries a newer Visual C++ runtime than the one installed first runs Microsoft's installer of it,
  which asks for an administrator; refused, the installed version stays and, after Restart Now,
  opens again and says the update didn't install.)* The web installer is off. The library calls that check
  only when the installed `app-update.yml` names a publisher, so the feed configuration names
  `windowsUpdatePublisher` itself (`publisherName` in `electron-builder.json`): every Windows build
  checks, signed or not, and none relies on release signing to add it. The release's verification
  refuses an installed app whose `app-update.yml` doesn't name it.
- **Linux** (`DebUpdater` for the download only, feed `https://cdn.tabmail.ai/releases/voice/linux-${arch}`,
  `latest-linux.yml` on x64, `latest-linux-arm64.yml` on ARM): the feed also carries `signature`, Ed25519, base64, over
  `TabMail Voice update\npackage: tabmail-voice\narchitecture: <arch>\nversion: <x.y.z>\nsha512: <base64>\n`.
  `install-update` (`resources/linux/install-update`, root-owned under `/opt` with the public keys in
  `update-keys/` beside it) checks, on a copy it made itself, the signature against those keys, the
  copy's SHA-512, and the package's own name, version and architecture, and that it is newer than the
  installed version. The app runs it once the download is in, as the user. The update is then ready:
  Install Now asks for an administrator through `pkexec`, and `install-update` checks again as root,
  on root's own copy, before `apt-get install`, which installs missing dependencies from the system's
  own sources, and never downgrades. The app then opens the
  new version. Nothing installs by itself, and `DebUpdater`'s install is never called. Its exit codes
  say why it refused (3 not signed by a key here, 4 not the signed package, 5 not newer, 6 the
  package manager failed), as do `pkexec`'s (126 dismissed: the update stays ready, nothing failed;
  127 not authorized). The authentication dialog says "Authentication is required to install a
  TabMail Voice update." (a polkit action for the packaged script, `auth_admin` every time), not the
  script's command line with its signature. The updated app is opened by a shell of the app's own once the old one has quit, never
  `app.relaunch()`: Chromium starts a relaunched app with no_new_privs, under which the AppArmor
  profile can't run `voice-linux` and `pkexec` can't raise privileges (found in the Ubuntu VM). The package depends on `openssl` and `pkexec`. The app's AppArmor profile lets
  `pkexec` leave it (`Ux`): dpkg, under the inherited profile, couldn't replace the files it names.
- **Linux updates stay off until a key ships.** The app turns them on only when `update-keys/` holds a
  `.pem`. The private key never enters the repository; the release signs each feed with it. A key is
  replaced by shipping the new one beside the old, signing with the new one from the next release,
  and dropping the old one after that.
- **Honest states.** `failed` (shown as Retry Update to Version x.y.z, the reason under Settings ›
  General) comes from a failed download, a refused proof or a failed install, until the next check or
  Retry. An install begun at the quit is recorded (`updateInstalling`); a next launch that isn't that
  version or newer shows "Version x.y.z didn't install." Nothing is called installed that wasn't.
- **The question** says what will happen: on macOS and Windows "It installs when TabMail Voice quits.
  Restart now to update?" (Restart Now / Later); on Linux "Installing it needs an administrator's
  authorization. Install now?" (Install Now / Later). Later stays the default and the cancel button,
  and it still waits for the user to stop dictating and close the chat window (ADR-DESK-041).
- **Release** (`tabmail-release-helpers`): each architecture's installer and feed go to its own folder,
  the feed last, so it never names a file not yet there; the Linux feed is signed there.

**Consequences:**
- A Windows release must be signed by a certificate whose common name and organization are
  `windowsUpdatePublisher`; a renamed certificate needs a release with the new name shipped first, or
  installed apps refuse every update after it.
- `WinVerifyTrust` checks revocation online. Where the CDN is reachable and the certificate
  authority's revocation server isn't, the download is refused as not signed by TabMail, and the next
  check tries again.
- On Linux a user who can't get an administrator's authorization can't update from the app; they are
  told so. A package that needs a dependency the system's sources don't have isn't installed (6), and
  the installed version keeps running.
- Tested as installed apps: a signed 0.0.1 upgraded to 0.0.2 on Windows on ARM (Restart Now, and the
  quit after Later), refusing unsigned, other-publisher, tampered and mislabeled installers and never
  downloading an older one; and on Ubuntu on ARM through the tray, `pkexec`, `install-update` and
  `apt-get`, with settings and helpers kept. The certificates and keys in those tests were made for
  them and removed after.

---

