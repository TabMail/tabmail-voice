# Windows native helpers

These helpers use Win32 rather than Chromium for global key capture and microphone sessions. `voice-hotkey.exe` runs the push-to-talk gesture on a dedicated keyboard-hook thread. `voice-windows.exe` runs UI Automation caret queries and target-checked clipboard insertion. `voice-microphone.exe`, a program of its own as on macOS and Linux, runs the WASAPI microphone and nothing else (ADR-DESK-032), so a UI Automation call that blocks, or the watchdog that ends `voice-windows.exe` over one, never holds up or ends a recording. It captures once: it ends itself with the shared restart code (`VoiceMicrophoneRestartExitCode`) once its session stops, its start fails, a newer start comes or the running capture fails, and the app starts it afresh; which session runs is the shared core's decision (`../shared/microphone`). `voice-screen-reader.exe`, a program of its own, reads the screen and nothing else, and `voice-field-reader.exe`, another, reads the focused field that correction learning watches after a paste and nothing else, in the window `voice-windows.exe` named at key-down, the one pasted into, by its handle (ADR-DESK-053). All speak the same newline JSON request/event protocol as the Mac helpers.

Overlay startup sends `caretAnchor` without a `window` parameter so the helper snapshots the foreground HWND when enqueueing the request. This avoids a foreground-query round trip before caret placement. Explicit window targets remain supported; a captured window that loses foreground ownership yields no geometry. The portable `voice-accessibility-worker` test compiles the actual worker with synthetic OS/provider boundaries and checks queued focus changes, fresh-request recovery, cancellation and malformed input.

Install Node.js 24 and Visual Studio Build Tools (2022 or later) with the C++ workload, Windows 11 SDK, CMake tools, and compiler tools for the target architecture. Run from a developer shell where `node` and `cmake` are on PATH; CMake picks the newest Visual Studio installed:

```powershell
cmake -S apps/desktop/native/windows -B apps/desktop/native/windows/build -A ARM64
cmake --build apps/desktop/native/windows/build --config Release --parallel 2
ctest --test-dir apps/desktop/native/windows/build -C Release --output-on-failure
```

Use `-A x64` and a separate build directory for an x64 target. The app build dispatcher uses the current Node architecture. `npm run compile:native` copies the two release executables into `dist/helpers`.

The helpers link the C++ runtime statically, as the Rust core does (`../shared/rust/.cargo/config.toml`): Windows does not ship the Visual C++ runtime and the installer does not carry it, so a helper that imported it would not start on a machine without Visual Studio. The app build refuses a helper that imports it (`runtimeImports` in `scripts/windows/build-native.mts`).

The JSON dependency is fetched from its official versioned release with a pinned SHA-256. Gesture tests are portable; native helper protocol tests must run on the Windows desktop as a normal user. Running them as SYSTEM does not validate access to the user's foreground windows or keyboard. Launch focus-dependent tests from a visible foreground terminal; a hidden background launcher may not have permission to give its fixtures foreground focus.

Windows offers Right Alt by default (the MacBook right Option key), with Right Control as the alternative. Control+Right Alt / AltGr input is passed through for ordinary typing, including its synthesized Control events; injected input never starts dictation. Space and Escape are swallowed only while the gesture owns them. When Windows gives up waiting for a late hook, the key-down reaches the system anyway; the hook then lets that key's key-up through, so the system never keeps the key held, and on a leaked Right Alt it presses the unassigned key 0xE8 first, so the release opens no menu bar (best effort). Input/output queues are bounded, and EOF ends each helper and releases its native resources. The microphone opens a fresh WASAPI client for each recording and closes it when that session ends; preparation does not capture audio. UI Automation runs in another process from the microphone and has a provider deadline.

Current helper tests cover gesture timing and emitted action names, both Control-key chords, stale activation completions after returning to the same window, the documented zero-duration WASAPI event-driven initialization contract, the shared microphone session cases, `voice-microphone.exe`'s protocol (refusals, one capture per process, the restart exit, EOF; `tests/microphone-loss.mjs`, run elevated in the test VM, stops Windows Audio before a start and during a capture to check that a failed start and a lost capture also end it with the restart code), protocol refusal/recovery, foreground identity shape, inactive caret queries, EOF, synthetic editable/password/read-only/non-text fields, real insertion, the clipboard saved ahead and put back after the paste with every format (not over a copy made after the paste or since the save, not for a password manager's copy; `tests/clipboard-keeper.cpp`: nor over a copy made as the paste closes the clipboard or as a save lets it go), a clipboard owner that renders late never asked for its data by the paste and saved in the background, a clipboard held open by another program, cancellation before insertion, expired deadlines and privacy flags. Correction learning reads the complete focused editable field (in a terminal, the box around its cursor) only while its original window remains foreground, refuses password/read-only/non-text fields and fields beyond 20,000 UTF-16 units, and keeps the field text local. Tests exercise empty, Unicode, exact-limit and over-limit fields. Classic Win32 Edit controls use bounded system messages when they expose no UI Automation text range. They do not demonstrate live microphone recording, packaging, or complete app operation. The paste only writes the clipboard, never reads it: `ClipboardKeeper` saves it ahead on a thread of its own (`clipboardSave`) and puts it back `restoreDelay` after the paste keys while the clipboard sequence number is still the paste's and the clipboard still holds the paste's text (the number is read once the paste closes the clipboard, when another program may already have copied; ADR-DESK-002, amended 2026-10-08). A save still reading a slow owner's clipboard when the paste comes holds it open, and the paste waits for it up to its 500 ms open wait. UIA validates the same unprotected focused control before mutation; final nonblocking window/focus, deadline, cancellation and modifier checks precede SendInput. Higher-integrity targets are refused. The app must construct the Windows helper client with `cancelRequests: true`; the fire-and-forget cancel message carries the request id, and the helper still answers the canceled request exactly once: a queued one with an error, a running one with its own result or error. Cancellation after input has already committed cannot undo that insertion. Apple Notes, iMessage, Apple Calendar and Apple Contacts integration requires platform-specific alternatives; the Mac adapters remain in `macos` folders.

The synthetic UIA provider suite crosses the real COM boundary into the shipped helper and counts protected name, value, pattern and subtree reads. It covers password fields inside windows, rows, links and web controls; excluded pages at focus, below focus, elsewhere in the window and inside frames/rows; failed page-address reads; genuinely addressless pages; and address-bar correction learning. A failed address read remains unknown even when UIA substitutes an empty default value, so host exclusions fail closed. Portable policy tests also cover malformed host lists and absent foreground windows.

The Chromium integration test requires the desktop app's npm dependencies and a normal Windows desktop session. CMake registers it automatically when Electron is installed before configuration, and reports a warning when it is unavailable. Foreground accessibility, paste and Electron tests run serially even with parallel CTest. From `apps/desktop`, after building the helper, run:

```powershell
node_modules/electron/dist/electron.exe native/windows/tests/electron.mjs native/windows/build/Release/voice-windows.exe
```

It checks real textarea and contenteditable providers: field-scoped context beside unrelated page text, selected and collapsed anchors, caret movement at the beginning/middle/end of a Unicode field, actual clipboard paste, empty-field anchoring, and refusal of password/read-only/non-text fields. The helper uses an active text-range caret, a Win32 edit caret, or the standard MSAA caret object before falling back to range-selection geometry and a field-sized focus frame. This avoids treating a Chromium field rectangle as its insertion point. Classic Win32 controls retain their system caret fallback. Each helper request has a four-second limit. The complete caret matrix has a two-minute budget to accommodate x64 emulation on ARM64 development VMs, with case/request diagnostics on timeout. This test does not establish authenticated dictation or service connectivity.

Windows Terminal exposes its cursor through a collapsed `TextPattern` selection,
without the editable-field patterns. Caret lookup uses the focused control’s accessibility capabilities, independently
of its editable-value capabilities: active `TextPattern2` carets or collapsed
`TextPattern` selections can provide geometry without making the control a field.
No application name or control-class allowlist is used for the caret (the screen
read knows a terminal by `HelperConfig::terminalApps`). Disabled, hidden, password
and explicitly read-only value controls are refused. Selected output alone does
not establish a caret, and correction learning reads a terminal only as the box around its
cursor, never its whole output. Validate the real
Terminal provider from a focused Windows Terminal tab, with the app quit and no
output redirection (from `apps/desktop`):

```powershell
node native/windows/tests/terminal-caret.mjs native/windows/build/Release/voice-windows.exe
```

Keep that tab focused until `TERMINAL_CARET_AND_VIEWPORT_PASS`. The test writes
synthetic output and verifies horizontal cursor movement, a new line, unchanged
foreground identity and refusal of field learning. It then fills the viewport
with synthetic rows and reads the displayed text, checking exact UTF-16 caret
offsets for ASCII and Unicode, exclusion of old scrollback, and retention of blank
rows below the caret. It does not use the clipboard or inject input. This
interactive check is separate from CTest, whose redirected output cannot establish
the terminal cursor contract. A passing single-pane run does not establish split
pane, explicit selection or ancestor-clipping behavior.

Insertion sends the normal Ctrl+V command to the same unprotected focused control;
it does not require an editable-value pattern or an application allowlist. The
target decides whether to consume paste. A successful request confirms command
delivery, not that the target changed its text. The paste writes the clipboard
and never reads it; the text, marked out of history and the cloud, stays on it
unless the clipboard was saved ahead, which is then put back after the paste. This
matches the Mac and Ubuntu insertion contract. In a terminal the field read for
correction learning is the box around the cursor, cut by the shared core from the
viewport the screen read reads (ADR-DESK-038, amended 2026-10-07), never the
terminal's whole output. Focus, password, integrity and deadline checks remain in force.
Elevated targets are refused.

To check insertion without dictation, open a disposable Windows Terminal tab with
its title fixed to `TabMail Terminal Insertion Fixture` (`--title` plus
`--suppressApplicationTitle`), then run:

```powershell
node native/windows/tests/terminal-paste.mjs native/windows/build/Release/voice-windows.exe terminal-paste-result.json
```

Keep it focused until `TERMINAL_INSERTION_PASS`. The fixture consumes ASCII and
Unicode paste in raw input mode and never sends Enter to a shell. It checks exact
received text, retained focus and that the field read is the box around the cursor. It saves no
clipboard first, so the text stays on the clipboard afterwards. Run this only in a disposable tab with no other
activity.

For split panes, use a disposable Windows Terminal tab with two vertical panes.
From `apps/desktop`, run this in the left pane (it stays alive for two minutes):

```powershell
node native/windows/tests/terminal-splits.mjs --left
```

Then run this in the right pane, keeping that pane focused:

```powershell
node native/windows/tests/terminal-splits.mjs native/windows/build/Release/voice-windows.exe terminal-splits-result.json
```

Once the right prompt changes to `selected terminal`, press Ctrl+Shift+A. Wait
for the evidence file's `explicit-selection` stage, then press Escape and
Alt+Left. The fixture verifies both identical panes, exact Unicode caret offsets,
selection confined to the right pane, truthful unavailable caret during selection,
and the left pane's caret after focus returns. It records synthetic evidence and
sets `passed: true` only after all assertions; each interactive wait is bounded.
Windows Terminal's TextPattern provider has no independently available caret while
output is selected. Run this fixture without other activity in that tab.

An ancestor-clipped aggregate remains refused. UIA's
[bounding rectangles](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationtextrange-getboundingrectangles)
can represent partially visible lines, and
[endpoint movement](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationtextrange-moveendpointbyunit)
can substitute a larger supported unit. Neither proves a UTF-16 clipping boundary.
Supporting that case requires a proven provider range mapping; it is not covered
by the ordinary split-pane test.

## Calendar, contacts and reminders

Calendar and contacts use the bundled `voice-productivity` WinRT adapter. Reads cover locally accessible Windows stores; they do not establish Outlook/To Do cloud-account integration. Writes use a local app-owned “TabMail Voice” calendar/address book, disclosed in confirmation and tool descriptions. They do not write to an inferred user default. A named mutex serializes container discovery/creation and saves; multiple matching containers refuse writes. Provider errors and timeouts propagate as refusals, and writes are never automatically retried.

The calendar provider expands recurrence and returns saved values, including native second precision. Shared wire all-day dates are inclusive local dates; the adapter converts to WinRT's exclusive end using historical Windows time-zone rules. Reminders remain unavailable after task write/deletion probes were denied. Notes have no Windows provider.

Real-provider tests are opt-in, outside CTest. Build `voice-calendar-provider-tests` or `voice-provider-identity-tests`, then run the executable with `--synthetic-store <absolute-evidence-path>` in a disposable logged-in VM. They create uniquely named synthetic containers and delete only their exact owned IDs. The identity test additionally launches a copied executable from a new directory to check upgrade-path store visibility; preserve its local evidence if cleanup fails. These tests do not prove full installed-app acceptance or all provider failure/concurrency paths. The unpackaged provider can omit newly created app-owned containers from enumeration even in the creating process. Direct lookup by provider ID succeeds in both a new process at the same path and a relocated executable. The helper therefore persists exact destination IDs in the current user’s registry and reuses them under its write lock; an unavailable saved destination is refused rather than silently replaced. Actual installed-app replacement/upgrade acceptance remains pending.

## Development packaging

Run `npm run dist -- --win --publish never` in the Windows guest after building for its Node architecture. The per-user NSIS installer contains the matching Windows executables outside ASAR; it runs the app at normal user integrity. Use a separate native build for each architecture. Mac helper resources and release settings remain under the Mac configuration.

NSIS uses a ZIP payload with differential packages disabled. The bundled NSIS 7-Zip decoder can silently omit ARM64 executables and DLLs compressed with the newer ARM64 branch filter ([upstream issue #9983](https://github.com/electron-userland/electron-builder/issues/9983)); ZIP avoids that filter. Verify the installed executable and native helpers, not only a successful installer build.

Packaged builds update themselves from their architecture's feed, `https://cdn.tabmail.ai/releases/voice/windows-${arch}/latest.yml` (ADR-DESK-050). Before a downloaded installer is kept, `voice-windows.exe --verify-update <file>` asks `WinVerifyTrust` for its Authenticode signature (chain and revocation) and prints one line of JSON: whether it is valid, the certificate's common name and organization, and the installer's signed product version. The app keeps it only when it is valid, signed by `windowsUpdatePublisher` and the offered version; it installs quietly, for this user, when the app quits. The feed configuration names that publisher (`publisherName` in `electron-builder.json`), without which electron-updater skips the check and installs anything its feed offers; so a local unsigned installer, for development validation and not a production release, also refuses every update it is offered unless signed by the release's publisher. CTest `voice-update-signature` checks the helper against Node's signed executable.

Editable providers that expose IAccessible2 use its logical UTF-16 text and
selection offsets; Chromium UI Automation ranges can enumerate bidirectional
inline text in visual order. The helper discovers IA2 through standard MSAA focus
and maps that exact object to UI Automation for the same ownership, password,
page-exclusion and subtree checks. Repeated focus checks compare the two mapped
elements with `CompareElements`; native UIA and MSAA bridge identities are not
interchangeable. Missing IA2 support retains the UIA/Win32 path. No provider DLL is
bundled: `vendor/ia2` contains pinned BSD interface declarations and notices.
Electron tests compare complete text and every insertion offset against the DOM,
including mixed bidirectional text and wrapped lines.

Screen context (in `voice-screen-reader.exe`) uses a bounded UI Automation walk of the foreground window, with visible text ranges for fields, separate field-scoped caret context, password/hidden-text exclusions and Mac-compatible reading-order rendering. The walk has the Mac reference budgets of 5,000 nodes / 1.5 seconds plus an aggregate text cap. The Electron regression checks real provider visibility and field boundaries; a portable renderer test checks line/column formatting and Unicode-safe limits.

## Start and Search placement

Start and Search occupy a Windows shell z-order band above ordinary Electron windows.
The shared Electron overlay uses detected shell window bounds as exclusion areas,
with a 24-DIP gap. Foreground, visibility and geometry events refresh placement;
there is no continuous accessibility polling for this feature. Ordinary apps retain
caret placement. The overlay remains a non-activating Electron window with the
shared React UI and mouse interactions.

If no region at least 240 by 120 DIP remains, the overlay is temporarily hidden
and returns when the shell closes. This can occur on small displays or at high
scaling. It is a known limitation, not successful visible placement. The deferred work on
caret-adjacent overlays above the shell is tracked in [issue #81](https://github.com/TabMail/tabmail-voice/issues/81).
