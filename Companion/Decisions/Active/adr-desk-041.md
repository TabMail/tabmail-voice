## ADR-DESK-041: The app updates itself from cdn.tabmail.ai

**Context:** Owner, 2026-09-30: 0.1.0 shipped with no way to update but downloading it again. The
native-FTS host updates itself with its own Ed25519 signing key and a signed manifest, because
nothing else vouches for its download. The owner asked whether Voice needs the same, and chose both
behaviors offered: download quietly and install at the quit, and ask to restart once it is ready.
Hosting: GitHub releases were the simpler option, but every installed app would then contact
GitHub, a recipient the records of processing and the privacy policy don't name. TabMail's own CDN
(Cloudflare R2, `cdn.tabmail.ai`, where the Thunderbird add-on and native-FTS updates already come
from) adds none, so the owner chose R2 (2026-09-30). The owner also asked that an update check send
no user data.

**Decision:**
- `electron-updater` (electron-builder's own), with the `generic` provider:
  `electron-builder.json`'s `publish` is `https://cdn.tabmail.ai/releases/voice/macos-arm64`, so the
  packaged app carries `app-update.yml` and reads `latest-mac.yml` there, and nowhere else. Each
  release uploads the versioned ZIP and its blockmap, the DMG, and `latest-mac.yml` last, so the
  feed never names a file not yet there. The ZIP's name has no spaces (`artifactName`).
  `useMultipleRangeRequest` is off: the CDN answers a request for several byte ranges with 400, so
  a differential update (only the blocks that changed, from the blockmaps) asks for one range at a
  time instead of falling back to the whole ZIP.
- The DMG's name carries no version (`TabMail-Voice-latest-arm64.dmg`, as the build names it, so the
  build, the CDN and the website agree): each release replaces it, so the website's download button
  links to it and serves the newest release without an edit per release (owner, 2026-09-30). A
  versioned copy is kept beside it. The first name, `TabMail-Voice-arm64.dmg`, is retired: the CDN
  served that object unreliably, and a fresh name was the fix.
- The DMG window has our own background (`resources/dmg-background.png`, at 1x and 2x): white with
  the arrow, and the app and the Applications link in its top half. Its title, the volume's name, is
  "TabMail Voice", without the version. The window is the background's size, and
  Finder's path and status bars cover its bottom; with the stock layout's icons lower down, the
  window scrolled on a Mac with those bars on.
- Nothing about the user or the installation is sent: `electron-updater` keeps a random ID for the
  installation (`.updaterId`, for staged rollouts, which we don't use) and sends it as
  `x-user-staging-id` with every request; `Updater` sets that header to a constant
  (`updateRequestHeaders`), which the library merges over its own. A request carries the IP address
  and user agent any download does, and the generic provider's random `noCache` query.
- Uploaded twice (owner, 2026-09-30): the GitHub release also carries a copy of the DMG (versioned),
  the ZIP and `SHA256SUMS`, for anyone who wants them from the source. The app and the website
  download and update from the CDN alone; the feed is not put on GitHub.
- No update key of our own on macOS: Squirrel.Mac installs an update only if it carries the running
  app's Developer ID signature (its designated requirement), and the feed's SHA-512 covers the ZIP.
  Someone who could write to the CDN can't ship a build we didn't sign, nor roll the app back to an
  older signed one: `ElectronSquirrelPreventDowngrades` in `Info.plist` makes Squirrel.Mac refuse an
  update whose own `CFBundleShortVersionString` is lower than the running app's (the feed's version is
  the writer's to choose; the bundle's is signed). Squirrel then also refuses any version not of the
  form x.y.z, so releases keep plain x.y.z versions (no pre-release suffix); the release script
  checks it.
- `Updater` (`src/main/updater.ts`), packaged builds only: looks `updateFirstCheckDelay` after launch
  and every `updateCheckInterval`, downloads by itself (`autoDownload`), installs when the app quits
  (`autoInstallOnAppQuit`). An update is ready only when Squirrel.Mac (Electron's own
  `autoUpdater`) says `update-downloaded`: `electron-updater`'s event of that name comes before
  Squirrel has fetched the ZIP from it, let alone checked its signature, so an update Squirrel then
  refuses would have been offered and Restart Now would do nothing. Once ready it asks once per
  version "Restart now?", on a task of its
  own (the dialog is modal and holds the main process: never inside a dictation's phase change),
  never while a dictation runs or the chat window is open (it waits for `appIsFree`). Later is both
  the default and the cancel button: Return, typed as the question appears, does nothing, and
  Escape picks Later. The menu shows Check for Updates…, what a check is doing, or Restart to Update
  once one is ready; Settings › General shows the same as a button under the version (owner,
  2026-09-30). A downloaded update stops further checks until the quit installs it.
- Its errors log their type and `electron-updater`'s code through `log.error`; the library's own
  logger is off (it writes to the console).
- Released with `tabmail-release-helpers/voice/release-mac.sh` (skill `tabmail-voice-release`):
  electron-builder notarizes and staples the app before it zips it (`APPLE_KEYCHAIN_PROFILE`), so the
  ZIP and the feed's hash are the published ones; the DMG is signed, notarized and stapled after, and
  the feed rewritten with its final hash.

**Consequences:**
- 0.1.0 has no updater: its users download 0.1.1 once by hand; every release after reaches them.
- Windows (NSIS) and Linux (AppImage) can use the same kind of feed when their targets exist;
  without Authenticode signing a Windows update is vouched for only by the feed's hash, and a
  `.deb`/`.rpm` install is updated by its package manager instead.
- An app run from the mounted DMG, or from a folder the user can't write, can't be replaced: the
  update is refused, so it is never offered, and each check tries again. The owner accepted this
  without telling the user (2026-09-30): the disk image's window shows where the app goes.

**Amendment 2026-10-04 — Windows and Linux update too (ADR-DESK-050).** The second consequence above
is superseded: Windows updates from signed NSIS installers whose Authenticode signature the app
checks itself, and Linux from `.deb` packages with an Ed25519 signature of our own, each from its
architecture's feed. `Updater` is now the same on every platform, with a thin adapter per OS
(`src/main/native/<os>/update.ts`); the macOS one keeps everything above (Squirrel.Mac's Developer ID
check, `ElectronSquirrelPreventDowngrades`, ready only on Squirrel's `update-downloaded`, a refusal
from an app run off its disk image not shown). The menu and Settings › General add Install Version…
(Linux), Installing Version…, and Retry Update to Version… after a failure, with the reason under
the General card. A refusal or failed install logs the platform's own fixed sentence, never content.

**Amendment 2026-10-11 — Linux updates through apt (ADR-DESK-058).** The Linux part of the amendment
above is superseded: a packaged Linux build has no updater and no update item; apt updates the
package from the signed repository at `cdn.tabmail.ai/releases/voice`, as the second consequence
above foresaw for a `.deb`. Install Version… and Installing Version… are gone.

**Amendment 2026-10-13 — the Linux AppImage updates itself (ADR-DESK-059).** The package still has
no updater; the AppImage, for those who can't install it, has the same one as macOS and Windows,
with a Linux adapter (`src/main/native/linux/update.ts`) and the same question and states.

**Amendment 2026-10-11 — each Mac app reads the feed of the architecture it runs as
(ADR-DESK-032's amendment).** The app sets its feed when it starts the updater:
`https://cdn.tabmail.ai/releases/voice/macos-<process.arch>` (`macUpdateFeedURL` in `config.ts`,
`src/main/native/macos/update.ts`), not the `app-update.yml` its build wrote. So the universal app,
downloaded for either kind of Mac, updates to that Mac's own app (`macos-arm64` on Apple silicon,
`macos-x64` on Intel); the Apple silicon app reads `macos-arm64`, as every copy installed before
did; and an Apple silicon Mac that runs the Intel app under Rosetta (where it runs as x64) stays on
the Intel feed. Squirrel.Mac installs the thin app over the universal one, as both carry the same
Developer ID signature. `publish` is `https://cdn.tabmail.ai/releases/voice/macos`, with no
architecture: electron-builder joins the universal app from an Apple silicon and an Intel build and
refuses when their `app-update.yml` differ, and electron-updater reads that file only for its
download cache's folder. A build-time feed URL would also be wrong for the universal app on one of
the two kinds of Mac; were the app ever not to set its feed, `macos` has no feed and updates fail
visibly instead. The mac targets name no architecture (one there would override the release's
`--arm64`, `--x64` or `--universal`), so a plain build is the build machine's app, and the helpers
default to the build machine's architecture to match.

