## ADR-DESK-032: One Electron app for macOS, Windows and Linux

**Context:** Owner, 2026-09-27, after a study of OpenWhispr (MIT), which ships one Electron app on
all three platforms: "We should move to a unified one NOW (move mac to electron). mimic openwhispr,
don't reinvent the wheel. prefer ts over js." Then: "we should build our own app — our focus is
different. we hold the release until unification. Current feature parity must be matched before …
we're working towards using the Electron Mac app to replace the Swift one." Wayland may be tap to
start, tap to stop. The study and the phase plan are kept outside this repository.

**Decision:**
- `apps/desktop/` is one Electron app in TypeScript (strict `tsc`, eslint with zero warnings):
  Electron, React and Vite for the windows, Vitest for the tests, electron-builder for the packages.
  Our own app, not a fork of OpenWhispr; we copy its patterns.
- `src/core/` is the platform-free port of the Swift app's logic (the dictation controller, the
  gesture timing, the backend clients, the agent and its tools, tips, the welcome wizard, settings,
  the overlay geometry): no Node or Electron imports, so every OS runs the same code and Vitest
  tests it directly. The Swift app is its behavioral spec, as Thunderbird is iOS's (ADR-IOS-008);
  its tests were ported with it.
- What needs the OS is a **native helper executable** per role, spawned by the main process and
  spoken to over stdin/stdout, one JSON object a line (`{id, method, params}` → `{id, result}` or
  `{id, error}`; events as `{event, …}`; stderr lines `debug …`/`error …`, the debug ones kept only
  while the app writes its debug log). A helper exits when its stdin closes and is restarted after
  `helperRestartDelay` if it dies (`HelperClient`). On macOS the helpers are the Swift app's own code
  as a SwiftPM package (`native/macos`): `voice-hotkey` owns the keyboard event tap (it must decide
  within the tap whether Space or Escape is kept from the app, so the gesture runs there) and
  `voice-macos` the rest (paste and clipboard restore, the screen read, the caret, the keyboard's
  language, the Globe setting, the Accessibility activator, the email apps, Thunderbird). The
  Accessibility grant is expected to be the app's, macOS attributing a spawned helper's use of it to
  the app that launched it; the first manual pass on a packaged, signed build confirms it. Helpers are executables, not Node addons, so they need no rebuild per Electron version and can
  crash without taking the app down.
- The microphone is `getUserMedia` in a hidden window, into an AudioWorklet in an `AudioContext`
  at the recording rate (Chromium resamples), each chunk sent to the main process; each dictation is
  a session and the tracks are stopped when it ends. Only that window may use the microphone
  (`setPermissionRequestHandler`), and only for audio.
- The main process owns every model; each window draws the state it is sent and sends back commands,
  which are checked at the boundary (`isCommand`, `isAudioReport`). Every window is sandboxed with
  context isolation, no Node, no navigation and no new windows, under a CSP with no inline script.
- The session stays in the Keychain item the Swift app uses (`@napi-rs/keyring`), settings in a JSON
  file in the app's data folder, the debug log in `~/Library/Logs/TabMail Voice/`.
- macOS first, to the Swift app's parity; Windows and Linux follow with their own helpers. The
  public release waits for the Electron app, which then replaces the Swift app (`apps/macos/` is
  deleted then).

**Consequences:**
- A resident Electron app uses more memory than the Swift one; accepted by the owner's choice.
- Every Swift change merged before cutover must be ported too (the parity checklist in the plan).
- Wayland has no global key-up: tap to start, tap to stop there (owner, 2026-09-27).
- The first launch of the Electron build asks for access to the Swift app's Keychain item once, as
  the item's access list names the Swift app.
- The macOS helpers are built for Apple silicon only, as the Swift app is (Xcode 27 deprecates
  x86_64).
- Numbered 032: ADR-DESK-031 is the Globe key's, and 022 to 030 are taken by agent-tool branches not
  yet merged.

**Amendment 2026-09-27 (owner): a sign-out the credential store refuses.** The Swift app signs out
in memory and only logs a refused Keychain delete, so the old sign-in returns at the next launch
without a word. Asked, the owner chose "sign out, show a warning": `AccountModel.signOut` signs out
in the app first, then removes the saved sign-in; when the store refuses, its error says, in the
app's words, that the sign-in may come back at the next launch, and Settings shows it. A refused save (sign-in or refresh) fails with the app's own
message and leaves the account as it was, as the Swift store's throwing `save` does.

**Amendment 2026-09-27 (owner): Settings in a branded sidebar.** The Electron Settings page was the
Swift app's single grouped form on a flat gray; the owner found it "bland" and wanted it "themed and
look professional", and chose, from three looks, the branded sidebar. Settings is now a
System Settings-style window: a sidebar with the app icon, the account and five sections (Account,
Dictation, Agent mode, Permissions, General), the chosen section's cards beside it. It is in the
TabMail icon's blue → purple (`brand.ts`, as the overlay): the selected section, switches and the
default button carry the gradient, section icons the brand blue, and a red dot marks a section that
needs the user (signed out, a permission missing), in light and dark. White text sits on the
gradient darkened by `textShade`, so small text keeps WCAG AA's 4.5:1 along it, the account shows
in the text color (in the content and the sidebar), the notes and "Allowed" are darker than
`form.css`'s in light mode (its gray and green were under 4.5:1 on the window's color), and focus
is Chromium's own ring, the browser's default indicator (the brand blue's was under 3:1 on the light sidebar); under a Windows
contrast theme (`forced-colors`), which drops gradients, the switches are the system's checkboxes,
the chosen section is in the system's selection colors with its own focus ring in the text color
(the system's took no contrast with that fill) and the attention mark in the text color.
The page's transparency outranks `form.css`'s page color by specificity, since the build links the
shared `form.css` after `settings/index.css`: at equal specificity it painted over the frosted sidebar. On macOS the sidebar shows the
window's frosted material under inset traffic lights (`vibrancy: "sidebar"`); Windows and Linux draw
no material, so the window has its own color (`settingsWindowColor`). The settings and their
wording are unchanged (a test holds the notes to the Swift app's); the sidebar adds only its own
labels (the app's name, the account or "Not signed in", the attention mark's "Needs attention").
This departs from the Swift app's look only, which the Swift app keeps until cutover. Whether the
sidebar shows the frosted material with a clear `backgroundColor` but no `transparent` flag can
only be seen in the running app on macOS, not in the offscreen previews.

**Amendment 2026-09-27 (owner, trying the Electron build): "the startup is much slower … at least
2–3 seconds until the thing shows up … the awesome startup that Swift app has to be carried on."**
- Measured on the owner's Mac: the app's log gave the first audio 1.47–1.56 s after key-down (the
  Swift app: 0.59–0.62 s). A probe of the same `getUserMedia` call gave 0.4–1.3 s to open the device,
  up to 0.5 s to resume the context, then up to 0.45 s of digital silence before the first real
  signal, which is when the pill replaces the swirl. Chromium opens the device afresh for each
  dictation; nothing it offers keeps a device prepared with the microphone off. The overlay window
  itself paints 30–50 ms after it is shown, so it is not the cause.
- On macOS the microphone is now `voice-macos`'s, run as the Swift app runs it (`MicrophoneCapture`:
  an `AVAudioEngine` prepared ahead with the microphone off, started per dictation, discarded after
  it, rebuilt when the default input changes). It converts each buffer to mono float samples at
  `recordingSampleRate` and sends them as `microphoneChunk` events (base64 of little-endian floats),
  numbered by the app's session; `SessionAudioCapture` (formerly `WindowAudioCapture`) drives it
  through `MacSystem.microphone`, with the same sessions, start timeout and late-report dropping.
  The same probe through the helper: first audio 0.57–0.62 s, first real signal 0.67–0.9 s.
- Elsewhere the hidden audio window (`getUserMedia`) stays the microphone for now. The owner
  (2026-09-27): *"it is important that the dictation part and everything as you did right now
  remains native so that it's super fast … this needs to be done for other platforms as well"*: the
  Windows and Linux helpers take over the microphone, hotkey and paste when those platforms are built.
- The helper runs under the app's microphone grant, as its Accessibility use does; packaged, it
  inherits the `audio-input` entitlement (`entitlementsInherit`). A restarted helper is prepared
  again (`macHelper.onStart`).
- A helper that exits mid-dictation takes the microphone with it (the Swift app has no such case: its
  microphone is in-process). Asked, the owner chose *"send what was said"*: `macHelper.onExit` makes
  `SessionAudioCapture.lost()` tell the started session, and the controller finishes the dictation as
  at the length cap, transcribing what was heard; lost during the release tail, the tail's end
  transcribes it; lost before the hold is deliberate, it fails as the microphone does. A start still pending when the helper exits fails through its request, as before. What was said
  is then pasted through the restarted helper (agent mode's Edit and Compose first check the app in
  front, a request that fails during a restart as "you switched apps"; after a loss their backend
  calls outlast the restart): the paste carries its dictation's `AbortSignal`, and a
  request with one made while the helper restarts (from `onExit` on, the restart being due first)
  waits for it within its own timeout; one that times out, or whose dictation is canceled, while it
  waits is never sent (a canceled dictation pastes nothing). Every other request fails at once
  during a restart, as before.
- The helper's engine stopping by itself mid-dictation (AVAudioEngine stops on a configuration
  change: the input's sample rate or channels changed) is the same loss: `MicrophoneCapture`
  watches each engine for `AVAudioEngineConfigurationChange` from before it starts (weakly, so the
  notification's queue never holds the engine's last reference), stops that session
  (`MicrophoneSessions.lost`, like a failed start) and emits `microphoneLost {session}` after the
  chunks already queued; the app reports it as `lost`, and the controller sends what was said, as
  above. One arriving while the start is still pending fails that start. (The Swift app does not
  watch for this; its dictation keeps listening to a stopped engine.) The audio window's path
  (Windows, Linux) does not report it yet.
- `MicrophoneSessions` treats a failed start like its stop (no older session starts after it), and
  the whole-number request params (session, pid, Globe value) are read with `JSON.integer`, the
  restore delay rounded to whole milliseconds with `Int(exactly:)`, so a malformed number is refused
  rather than trapping the helper. Engine release has no hardware-free test: the owner declined a test-only
  engine seam in `MicrophoneCapture` (no production complication for test convenience); the release
  decision itself is `MicrophoneSessions`', which is tested.

**Amendment 2026-09-27 (owner): the Swift app removed.** *"Once everything is clean … clean up the
non‑Electron version so that we don't have dead weight being carried over."* With the Electron app's
parity branches merged (the native microphone, the branded Settings, the overlay's swirl and icon,
the hands-free tip and fn double tap), `apps/macos/` is deleted, together with what only the Swift
app used: `Scripts/copy-worktree-secrets.sh` and the signing-config template (the Xcode project read
its `DEVELOPMENT_TEAM`; the Electron app signs through electron-builder from the keychain). The
gitignore keeps ignoring the local signing config, so a copy left in a checkout is never committed.
The native helpers in `apps/desktop/native/` stay: the dictation path stays native. The Swift app's
source stays in git history (the parent of this change) and in the unmerged Swift agent-tool
branches, which remain the reference for porting agent mode. The docs describe the Electron app
only; code comments that name the Swift app record what a port matches.

**Amendment 2026-10-01 (owner: the microphone "not working and hanging" with AirPods): no engine is
released on the capture queue, and none is prepared while the helper sees the input device changing.** The helper's log and crash reports gave three
failures, all in `MicrophoneCapture`'s default-input listener, which released the prepared engine
and built the next one on the spot: `installTap` raising an Objective-C exception (the helper
aborts: Swift cannot catch it); AVFAudio's own listener for the engine just released crashing; and
the capture queue held for up to minutes, so the next starts and stops timed out ("Couldn't start
the microphone", nothing recorded) and then ran all at once.
- No engine is released on the capture queue. Every engine on its way out (the prepared one when
  the device changes, the running one at its stop or loss, one whose start failed) is stopped there,
  so the microphone is off as before, and released `microphoneDeviceSettleDelay` later on a queue of
  its own: a headset changes as a dictation starts and again as it ends, without the default input
  changing, so any release can fall in a change, and its release must not hold up a start.
- After a change the helper sees (the default input switched; a running engine's
  `AVAudioEngineConfigurationChange`), the next engine is prepared once no further change has come
  for `microphoneDeviceSettleDelay` (`InputChanges`: a headset arriving changes the device several times over, and only the
  latest change's wait settles it). A stop in that window prepares nothing either; the settle does.
- The tap is installed with no format, so it takes the node's own: a format read first and passed
  in can differ from the device's by the time it is installed, which raises that exception. The
  device's own format is checked for a sample rate and channels before.
- The start path is unchanged: a prepared engine for the current device is started as before
  (measured through the helper on a USB microphone, 16 starts each: the first chunk 553–568 ms after
  the request, 550–576 ms before this change). A key-down inside the settle window builds its own engine, as a
  start always did when none was prepared for the current device.
- A change while a dictation is listening ends it as its release would (the owner, 2026-10-01:
  *"force dictation to terminate as if user stopped dictating"*): this is `microphoneLost` as
  above, what was said is sent, and it is not retried.
- The log says how each prepared engine's device is connected (the transport's four characters,
  never the device's name), its sample rate and channels and how long preparing took, and when the
  default input changed.
- Not closed: an exception from `installTap` in a start made inside the settle window, were the
  device to lose its format between the check and the tap; the engine prepared right after a stop,
  which is built at once and so can fall in a change the helper does not see (a headset leaving its
  microphone mode); a release `microphoneDeviceSettleDelay` later that still falls in a longer
  change (off the capture queue, so it holds up no start); and what the audio system itself takes
  to start a Bluetooth headset's microphone, which is the system's.
- Windows needs none of this (`native/windows/src/microphone.h`): each start opens the default
  endpoint afresh on its own thread and nothing is prepared or kept between dictations, so there is
  no engine to go stale and no listener; an endpoint that goes away mid-capture fails the capture
  call, which is reported as `microphoneLost`, the same ending.

**Amendment 2026-10-01 (owner: "it should be a separate helper"): the microphone has a helper to
itself, `voice-microphone`, which runs one engine and is then started afresh.** The amendment above
did not hold when a headset was switched off: with the default input gone, the engine prepared for
it rebound itself inside AVFAudio, and building the next engine waited on the audio system (one
took 64 s), so every start in that time failed. Switching the input with the headset still
connected worked. Waiting for the device to settle cannot fix an engine that is already alive in
the process when its device goes; the owner chose a process of its own over more handling in
`voice-macos`. Tested with AirPods, that fixed switching them off, but every other dictation then
failed: the engine prepared after a stop, in the process whose engine had just run, lost its
configuration about 0.2 s after it started (the headset changes mode as a dictation ends), while
the first engine of a fresh process always worked. So a process runs one engine.
- `voice-microphone` (`VoiceMicrophone` over `VoiceMicrophoneKit`: `MicrophoneService`,
  `MicrophoneCapture`, its `HelperConfig`) answers `microphonePrepare`, `microphoneStart` and
  `microphoneStop` and emits `microphoneChunk`, as `voice-macos` did; `voice-macos` no longer has a
  microphone. The start path is the same code: an engine prepared ahead, started at key-down.
- The helper ends itself (`_exit`, code `restartExitCode`, after the chunks already queued; no exit
  handlers, which would release what the audio system holds) once its engine has run (the
  session's stop) or failed to start, when the default input changes, and when the running engine
  posts `AVAudioEngineConfigurationChange`. It prepares nothing more and releases nothing: the
  process's end releases its engine. The app starts it again at once (`HelperOptions.restartExitCode`,
  `microphoneHelperRestartExitCode`; logged at debug, not as an error) and its `onStart` prepares
  the new process's engine. A prepare or a stop cut short by such an exit, which can come before
  their reply, is logged at debug. Any other exit restarts after `helperRestartDelay`, as every
  helper's. A start that reaches a process whose engine has already started (a newer dictation's
  start handled before the previous one's stop, as the helper takes requests in any order) or whose
  engine was prepared for another device is refused and ends the process, so the app's retry
  starts it in a fresh one; `MicrophoneSessions` makes these decisions and its tests pin them. This
  replaces `InputChanges`, the settle wait, the delayed release of engines (the amendment above,
  `microphoneDeviceSettleDelay` after their stop) and the helper's `microphoneLost` event on macOS
  (`voice-windows` still sends it).
- A change while a dictation is listening ends it as before, now through the helper's exit
  (`onExit` → `SessionAudioCapture.lost()`): what was said is sent, and it is not retried. The
  paste and the caret are `voice-macos`'s, which keeps running, so the paste no longer waits out a
  restart for this.
- A start that fails is tried again (owner, 2026-10-01: *"try at least a couple times within the
  first two seconds or so"*): `SessionAudioCapture` sends a new session `microphoneStartRetryDelay`
  after a failed one while `microphoneStartRetryWindow` from key-down has not passed, then fails
  the dictation with the last reason; the one `microphoneStartTimeout` covers every try. A new
  session each time, as the helper has ended the failed one. This covers a key-down while the
  helper starts afresh (one right after the previous dictation's stop) and an input that refuses
  its first start mid-change. It applies wherever the microphone runs (the audio window too); a
  start that succeeds is not delayed.
- Still kept from the amendment above: the tap takes the node's own format, and the log names the
  transport.
- Windows keeps its microphone in `voice-windows` for now, opened afresh per dictation with
  nothing prepared ahead; a helper of its own and a prepared endpoint are tracked in issue #98.
- The owner's manual test (2026-10-01), before one engine per process: a headset connected and
  then switched off each restarted the helper within 10 ms, the next engine was prepared within
  2 s (twice over when the input changed again as the new process started), and dictation kept
  working.
- Not closed: what the audio system itself takes to start a Bluetooth headset's microphone; and a
  prepare that now and then takes seconds with no device change seen (issue #101).

### Amendment 2026-10-07: `voice-microphone` on Windows and Linux too

Owner, 2026-10-07: *"all audio helpers should be separate in the same way"*, as the screen reader is,
so that nothing the platform helper waits on can block a recording. Until now the Windows microphone
was in `voice-windows`, which ends itself (`ExitProcess`) when one UI Automation request outlives
`accessibilityWatchdogMs` (2.5 s): a provider that stopped answering took the recording with it
(seen as a lost caret lookup on a freshly activated Chromium window in the Windows VM's cold test),
and on Linux the microphone shared `voice-linux`'s process with AT-SPI calls that can wait on a
provider. Per-call UI Automation timeouts were tried first (TabMail/tabmail-voice#168) and only
narrowed the window: a provider slow on each of a request's later calls still reached the watchdog.

- Every platform runs `voice-microphone` (`voice-microphone.exe` on Windows), speaking the same
  wire (`microphonePrepare`, `microphoneStart {session, sampleRate}`, `microphoneStop {session}`,
  the `microphoneChunk` event). `voice-windows` and `voice-linux` no longer answer the microphone.
  The app wires it the same way everywhere (`HelperOptions.restartExitCode`, its `onStart`
  preparing, its `onExit` ending a running dictation as lost).
- It captures once per process, as on macOS: it ends itself with `VoiceMicrophoneRestartExitCode`
  (75, defined once in the shared core's header, the app's `microphoneHelperRestartExitCode`) once
  its session stops, its start fails, a newer start comes before the stop, or the running capture
  fails (a Windows endpoint that goes away, a PulseAudio stream that fails); its replies and chunks
  already sent are written first. That last replaces the `microphoneLost` event, which no helper
  sends now. Windows and Linux open the default input afresh at each start and prepare nothing
  ahead (prepare only checks there is an input), so they need no listener for a changed input: the
  next dictation's fresh process opens the new default.
- Which session runs, and when the process ends, is decided once, in the shared Rust core
  (`native/shared/rust/src/microphone.rs`, a C value state like the gesture's; ADR-DESK-054), with
  its cases in `native/shared/microphone/session-cases.json`, run by Rust, Swift
  (`MicrophoneSessions`, now a thin wrapper) and C++ (`sessions.h`, Windows and Linux). The rules
  are macOS's, unchanged. What a start or stop may ask for is decided there too (`request.rs`,
  `microphoneStart`/`microphoneStop`, cases in `native/shared/context/request-cases.json`): a session
  that is a whole number from 1 and a rate in whole hertz from 8,000 to 96,000, so the three helpers
  refuse the same requests (they had three hand-written checks with three answers; macOS accepted
  any session and any positive rate).
- On Linux PulseAudio now runs on the helper's own GLib main loop with its requests (no AT-SPI in the
  process), so the worker thread and context that kept AT-SPI from starving capture are gone.
- `native/shared/microphone/protocol.mjs` checks the Windows and Linux helpers' wire against the built
  helper (refusals, one capture per process, the restart exit, EOF); on Linux with a synthetic tone
  through a private null sink, on Windows without needing an input. A failed start and a lost capture
  are checked too: on Linux with no sound server, and with the helper's connection to it cut through
  a relay; on Windows by stopping Windows Audio, in an elevated run in the test VM
  (`tests/microphone-loss.mjs`), since stopping a service is no CTest step.
- Not done here (issue #98): preparing a Windows capture client ahead of the key press and measuring
  first-audio time on built-in and Bluetooth inputs. This amendment supersedes the line above that
  Windows keeps its microphone in `voice-windows`.

### Amendment 2026-10-03: one native gesture algorithm

The Rust static library now owns the push-to-talk, double/triple-tap, agent-intent, cancellation and semantic key-ownership transitions. Swift and C++ use an allocation-free C value-state interface, preserving value-copy/reset behavior and caller-supplied monotonic time. Native adapters keep key codes, Globe/AltGr filtering, event taps/hooks/portal lifecycle and swallowed key-up ledgers; reconfiguration still follows each monitor's existing contract. Shared traces were run against both prior implementations before their duplicate transition bodies were removed. This avoids a second state-machine implementation without adding per-key JSON, threads, callbacks or a daemon.

### Amendment 2026-10-05: a microphone that gives only digital silence is called muted

Owner, 2026-10-04, after an Ubuntu VM whose input was muted at 0 % kept the warm-up swirl going
forever: "if the volume is 0, we should just tell it instead of silently being unable to load the
microphone forever", on every platform. A muted input still opens and delivers frames, all zero, so
neither the start timeout nor the retry above sees it, and the waveform waits for a first real
signal (`silenceDecibels`) that never comes. The dictation controller now starts
`silentMicrophoneDuration` (3 s) at the microphone's first audio; if nothing above digital silence
has come by then while the hold is arming or listening, the dictation ends with
`silentMicrophoneMessage` ("Microphone muted or at zero volume.") and nothing is sent. The same
check runs on every platform, with no OS volume API: a real microphone's noise floor is above
digital silence. Silence only as a device starts (a Bluetooth headset switching profile) is waited
out, and once the key is released the recording goes on as any does. A spoken answer to a question
is not checked.

### Amendment 2026-10-11 (owner): an Intel Mac app too, and a universal one

Owner: "why no intel mac support? doesn't mac support universal binaries?" The consequence above
that the macOS helpers are built for Apple silicon only "(Xcode 27 deprecates x86_64)" is
superseded. Xcode 27 still builds x86_64; it warns only when the deployment target is its own macOS
(27), which `swift build --arch x86_64` assumes. For macOS 15, the app's minimum, x86_64 is
supported, and a build that names the deployment target (`--triple x86_64-apple-macosx15.0`) is
clean.

**Decision:**
- Three Mac downloads, as VS Code and Notion offer them (owner: "three releases like other apps
  with universal as default ... and have links to each platform"): `TabMail-Voice-latest-universal.dmg`,
  the website's main download, runs natively on both; `TabMail-Voice-latest-arm64.dmg`, unchanged,
  and `TabMail-Voice-latest-x64.dmg`, each about half the universal app's size, are linked beside it.
- Every app updates from the feed of the architecture it runs as (ADR-DESK-041's amendment of the
  same day), so a universal install updates to that Mac's own app, and only the two thin apps have
  feeds.
- Each is its own build. `scripts/macos/build-native.mts` builds the helpers for `VOICE_MAC_ARCH`
  (`arm64`, `x64`, or `universal`: both, joined by `lipo`; by default the build machine's, the app
  electron-builder builds by default) with the triple for macOS
  15, and links that architecture's Rust core: `Package.swift` takes the target from
  `VOICE_RUST_TARGET`, as a manifest only knows the build machine's architecture. Each
  architecture has its own SwiftPM scratch folder.
- npm installs native packages for the build machine only, so every Mac build installs the app's
  own Mac packages for both architectures (the keychain's `@napi-rs/keyring-darwin-*`) from
  package-lock.json, each tarball checked against the lockfile's integrity before it is unpacked.
  Every app carries both keychain binaries (about 0.5 MB each): electron-builder joins the universal
  app from an Apple silicon and an Intel build, which must hold the same files, and
  `mac.x64ArchFiles` lets it keep the two single-architecture binaries as they are.
- The release (`tabmail-release-helpers/voice/release-mac.sh`) builds, notarizes, verifies and
  publishes all three, each in its own CDN folder (`macos-<arch>`); the universal app is a DMG
  alone, with no ZIP and no feed.

**Consequences:**
- Nobody here has an Intel Mac: the x64 app is checked under Rosetta on Apple silicon, the same
  x86_64 code, but not on Intel hardware. The universal app's Intel half is that same code.
- A universal install becomes a thin app with its first update; nothing it needs is lost, as it
  runs only its own architecture's half.
- macOS 26 is the last macOS for Intel Macs, so this app serves them on macOS 15 and 26.

