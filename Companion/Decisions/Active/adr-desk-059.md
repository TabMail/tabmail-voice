## ADR-DESK-059: The Linux AppImage, for those who can't install the package

**Context:** The `.deb` needs an administrator (`sudo apt install`, ADR-DESK-058). Owner, 2026-10-13:
offer a version for a user without one, and say on the download page that it's for that case; the
package stays the main download. Researched how open-source apps ship a no-administrator Linux
install: Signal Desktop (an AppImage that replaces itself, its updates signed with a key the app
carries), Joplin (an AppImage in the user's folder plus a launcher entry of its own), Telegram and
Firefox (an unpacked folder that updates itself, each update signed). Measured on a fresh Ubuntu
26.04 as a user with no `sudo`: a static-runtime AppImage mounts with the stock `fuse3`; Ubuntu's
unprivileged user namespace restriction leaves Chromium no sandbox outside an AppArmor profile, which
only an administrator can install, so electron-builder's launcher starts it with `--no-sandbox`
(owner, 2026-10-12: accepted for the AppImage); `gpgv` is there; replacing the AppImage file while the
old version runs works.

**Decision:**
- **An AppImage per architecture** (`TabMail-Voice-<version>-linux-x86_64.AppImage`, `…-arm64…`),
  built beside the `.deb` from the same app (`linux.target`), on electron-builder's static AppImage
  runtime (`toolsets.appimage` 1.0.3): the older runtime needs a `libz.so` stock Ubuntu doesn't have.
  The website links `TabMail-Voice-latest-linux-<arch>.AppImage`, a copy the release writes, under
  "No administrator (sudo) rights?"; the package stays the main Linux download.
- **Which AppImage this is.** The AppImage's runtime sets `APPIMAGE` (its file) and `APPDIR` (where
  it mounted it) for what it starts, and every process started from there inherits them: the
  package's app opened from another AppImage's terminal or editor has both. So the app is an AppImage
  only when packaged and its own executable is in the folder `APPDIR` names (`runningAppImage`, the
  folder's real path); otherwise it is the package's, and never opens, puts on the desktop or replaces
  that other AppImage. The login item names the AppImage so chosen, else the executable.
- **On the desktop by itself.** At each launch the AppImage writes, in the user's own data folder
  (`$XDG_DATA_HOME`, else `~/.local/share`), only what differs: the launcher entry
  `applications/ai.tabmail.voice.desktop` (the app ID the desktop portal registers it by, so its
  shortcuts and permissions work as the package's), its icons in `icons/hicolor`, and the GNOME
  extension (ADR-DESK-052) in `gnome-shell/extensions`, which GNOME loads at the next sign-in. The
  login item is the user's and a launch never rewrites it: one the user turned off (`Hidden=true`)
  stays off, and after the user moves the AppImage, Settings shows it off until turned on again,
  which names the new path. An update never moves the AppImage (below). Nothing is
  removed with the AppImage; deleting it leaves a launcher entry that no longer opens, as Joplin's does.
- **The X11 argument.** Opened from Files or a terminal, the AppImage's launcher passes no argument,
  and Electron chooses its display backend before the app's code runs. The app then opens itself
  again with `--ozone-platform=x11` (as every launcher entry passes it) and quits before starting
  anything else.
- **It updates itself**, through the same `Updater` as macOS and Windows (ADR-DESK-050), with
  `electron-updater`'s `AppImageUpdater`: the feed `https://cdn.tabmail.ai/releases/voice/linux-<arch>`
  (`latest-linux.yml` on x64, `latest-linux-arm64.yml` on ARM, beside the packages), one byte range per
  request (the CDN refuses several), a differential download from the blockmap the AppImage carries.
  The feed is Linux's publish setting (`linux.publish`), not the AppImage target's: electron-builder
  writes `app-update.yml` into the app only from the platform's, and the updater reads the name of its
  download folder there (`updaterCacheDirName`), so without it every download fails (a VM run: "Error
  ENOENT"). The package carries the file too, unread, as it starts no updater; `deb.publish` is null,
  so no feed names the package. The release checks the AppImage holds it.
- **Signed with the apt repository's key.** The feed carries `signature`: a detached OpenPGP signature,
  base64, made by the release with the key that signs the repository (ADR-DESK-058), over
  `TabMail Voice update\npackage: tabmail-voice-appimage\narchitecture: <arch>\nversion: <x.y.z>\nsha512: <base64>\n`
  (ADR-DESK-050's form, naming the AppImage). The app computes the download's SHA-512 itself, writes
  that statement and the signature to a fresh temporary folder, and runs `gpgv` with that folder as
  its home and only the keyring the app carries
  (`resources/linux/tabmail-voice-archive-keyring.gpg`, the package's), as apt checks the repository.
  The update is ready only when `gpgv` holds it; otherwise "Version x.y.z isn't signed by TabMail, so
  it wasn't installed." `Updater` already refuses a version that isn't newer. Key rotation is the
  repository's: the keyring the AppImage carries is the one the package installs, replaced with each
  release.
- **Install.** It installs when the app quits, or at once with Restart Now (the question is macOS's and
  Windows': "It installs when TabMail Voice quits. Restart now to update?"). The library runs the
  install at either moment, but it is the app's (`AppImageInstaller.doInstall`, the library's
  extension point): the library's own unlinks the AppImage before moving the download in, so a move
  that fails (the download gone from the cache) leaves no app at all, and it renames an AppImage
  whose name carries a version to the download's name, leaving the launcher entry and login item
  naming a missing file. The app's copies the very download `gpgv` held beside the AppImage (in a hidden folder of
  its own there, so the copy's name never depends on the AppImage's, which may already be as long as
  a name can be), with its permissions, checks the copy's SHA-512 against the one gpgv held, and
  renames it over the AppImage (`replaceAppImage`): the path holds the old AppImage or the new one,
  never neither, and keeps its name; on any failure the old one stays and the copy is removed. The
  library refuses every install after the first one begins; after one that failed, the app clears
  that, so Restart Now again, or the quit, tries again. After Restart Now the app opens the new AppImage from a shell of its own
  once it has quit (`relaunchAfterExit`), never `app.relaunch()` (no_new_privs, ADR-DESK-050, would
  stop `fusermount3` mounting it); an install that didn't happen fails, and nothing quits or reopens.
- **Release** (`tabmail-release-helpers`): CI builds and checks the AppImage with the package; the
  publish signs each architecture's statement with `VOICE_APT_SIGNING_KEY`, checks it with `gpgv`
  against the package's keyring, writes `signature` into the feed, and uploads the AppImage, then the
  feed (never one older than the CDN's), then the `latest` copy.

**Consequences:**
- The AppImage runs without Chromium's sandbox, as any AppImage does on Ubuntu 24.04 and later
  without an administrator; the package keeps it (its AppArmor profile).
- No dependency is installed: the AppImage needs what a stock Ubuntu 26.04 desktop has (measured:
  every library the app links), and `fuse3`, which it has.
- A user with both the package and the AppImage has one launcher entry, the AppImage's (the user's
  own folder comes first).
- The AppImage updates only while it runs; one not run for a long time updates on its next launch.


