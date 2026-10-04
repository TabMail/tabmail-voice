# Windows native helpers

These helpers use Win32 rather than Chromium for global key capture and microphone sessions. `voice-hotkey.exe` runs the push-to-talk gesture on a dedicated keyboard-hook thread. `voice-windows.exe` runs WASAPI microphone sessions, UI Automation context/caret queries, and target-checked clipboard insertion. Both speak the same newline JSON request/event protocol as the Mac helpers.

Install Node.js 24 and Visual Studio Build Tools 2022 with the C++ workload, Windows 11 SDK, CMake tools, and compiler tools for the target architecture. Run from a developer shell where `node` and `cmake` are on PATH:

```powershell
cmake -S apps/desktop/native/windows -B apps/desktop/native/windows/build -G "Visual Studio 17 2022" -A ARM64
cmake --build apps/desktop/native/windows/build --config Release --parallel 2
ctest --test-dir apps/desktop/native/windows/build -C Release --output-on-failure
```

Use `-A x64` and a separate build directory for an x64 target. The app build dispatcher uses the current Node architecture. `npm run compile:native` copies the two release executables into `dist/helpers`.

The JSON dependency is fetched from its official versioned release with a pinned SHA-256. Gesture tests are portable; native helper protocol tests must run on the Windows desktop as a normal user. Running them as SYSTEM does not validate access to the user's foreground windows or keyboard. Launch focus-dependent tests from a visible foreground terminal; a hidden background launcher may not have permission to give its fixtures foreground focus.

Windows offers Right Alt by default (the MacBook right Option key), with Right Control as the alternative. Control+Right Alt / AltGr input is passed through for ordinary typing, including its synthesized Control events; injected input never starts dictation. Space and Escape are swallowed only while the gesture owns them. Input/output queues are bounded, and EOF ends each helper and releases its native resources. The microphone opens a fresh WASAPI client for each recording and closes it when that session ends; preparation does not capture audio. UI Automation runs separately from microphone control and has a provider deadline.

Current helper tests cover gesture timing and emitted action names, both Control-key chords, stale activation completions after returning to the same window, the documented zero-duration WASAPI event-driven initialization contract, protocol refusal/recovery, foreground identity shape, inactive caret queries, EOF, synthetic editable/password/read-only/non-text fields, real insertion, text and registered binary clipboard restoration, cancellation before insertion, expired deadlines, privacy flags, and preservation of a newer user copy. Correction learning reads the complete focused editable field only while its original window remains foreground, refuses password/read-only/non-text fields and fields beyond 20,000 UTF-16 units, and keeps the field text local. Tests exercise empty, Unicode, exact-limit and over-limit fields. Classic Win32 Edit controls use bounded system messages when they expose no UI Automation text range. They do not demonstrate live microphone recording, packaging, or complete app operation. Clipboard insertion captures all clonable formats before replacing anything, refuses owner-display/private-handle formats it cannot preserve, and restores only while its sequence and owner still match. The clipboard owner pumps messages during its restore delay so intervening copies can finish. UIA validates the editable field before mutation; final nonblocking window/focus, deadline, cancellation and modifier checks precede SendInput. Higher-integrity targets are refused. The app must construct the Windows helper client with `cancelRequests: true`; the fire-and-forget cancel message carries the request id. Cancellation after input has already committed cannot undo that insertion. Apple Notes, iMessage, Apple Calendar and Apple Contacts integration requires platform-specific alternatives; the Mac adapters remain in `macos` folders.

The synthetic UIA provider suite crosses the real COM boundary into the shipped helper and counts protected name, value, pattern and subtree reads. It covers password fields inside windows, rows, links and web controls; excluded pages at focus, below focus, elsewhere in the window and inside frames/rows; failed page-address reads; genuinely addressless pages; and address-bar correction learning. A failed address read remains unknown even when UIA substitutes an empty default value, so host exclusions fail closed. Portable policy tests also cover malformed host lists and absent foreground windows.

The Chromium integration test requires the desktop app's npm dependencies and a normal Windows desktop session. CMake registers it automatically when Electron is installed before configuration, and reports a warning when it is unavailable. Foreground accessibility, paste and Electron tests run serially even with parallel CTest. From `apps/desktop`, after building the helper, run:

```powershell
node_modules/electron/dist/electron.exe native/windows/tests/electron.mjs native/windows/build/Release/voice-windows.exe
```

It checks real textarea and contenteditable providers: field-scoped context beside unrelated page text, selected and collapsed anchors, caret movement at the beginning/middle/end of a Unicode field, actual clipboard paste, empty-field anchoring, and refusal of password/read-only/non-text fields. The helper uses an active text-range caret, a Win32 edit caret, or the standard MSAA caret object before falling back to range-selection geometry and a field-sized focus frame. This avoids treating a Chromium field rectangle as its insertion point. Classic Win32 controls retain their system caret fallback. Each helper request has a four-second limit. The complete caret matrix has a two-minute budget to accommodate x64 emulation on ARM64 development VMs, with case/request diagnostics on timeout. This test does not establish authenticated dictation or service connectivity.

Windows Terminal exposes its cursor through a collapsed `TextPattern` selection,
without the editable-field patterns. Caret lookup uses the focused control’s accessibility capabilities, independently
of its editable-value capabilities: active `TextPattern2` carets or collapsed
`TextPattern` selections can provide geometry without enabling field learning.
No application name or control-class allowlist is used for the caret (the screen
read knows a terminal by `HelperConfig::terminalApps`). Disabled, hidden, password
and explicitly read-only value controls are refused. Selected output alone does
not establish a caret, and terminal output remains excluded from correction learning. Validate the real
Terminal provider from a focused Windows Terminal tab, with the app quit and no
output redirection (from `apps/desktop`):

```powershell
node native/windows/tests/terminal-caret.mjs native/windows/build/Release/voice-windows.exe
```

Keep that tab focused until `TERMINAL_CARET_PASS`. The test writes synthetic output
and verifies horizontal cursor movement, a new line, unchanged foreground identity
and refusal of field learning. It does not capture terminal text, use the clipboard
or inject input. This interactive check is separate from CTest, whose redirected
output cannot establish the terminal cursor contract.

## Calendar, contacts and reminders

Calendar and contacts use the bundled `voice-productivity` WinRT adapter. Reads cover locally accessible Windows stores; they do not establish Outlook/To Do cloud-account integration. Writes use a local app-owned “TabMail Voice” calendar/address book, disclosed in confirmation and tool descriptions. They do not write to an inferred user default. A named mutex serializes container discovery/creation and saves; multiple matching containers refuse writes. Provider errors and timeouts propagate as refusals, and writes are never automatically retried.

The calendar provider expands recurrence and returns saved values, including native second precision. Shared wire all-day dates are inclusive local dates; the adapter converts to WinRT's exclusive end using historical Windows time-zone rules. Reminders remain unavailable after task write/deletion probes were denied. Notes have no Windows provider.

Real-provider tests are opt-in, outside CTest. Build `voice-calendar-provider-tests` or `voice-provider-identity-tests`, then run the executable with `--synthetic-store <absolute-evidence-path>` in a disposable logged-in VM. They create uniquely named synthetic containers and delete only their exact owned IDs. The identity test additionally launches a copied executable from a new directory to check upgrade-path store visibility; preserve its local evidence if cleanup fails. These tests do not prove full installed-app acceptance or all provider failure/concurrency paths. The unpackaged provider can omit newly created app-owned containers from enumeration even in the creating process. Direct lookup by provider ID succeeds in both a new process at the same path and a relocated executable. The helper therefore persists exact destination IDs in the current user’s registry and reuses them under its write lock; an unavailable saved destination is refused rather than silently replaced. Actual installed-app replacement/upgrade acceptance remains pending.

## Development packaging

Run `npm run dist -- --win --publish never` in the Windows guest after building for its Node architecture. The per-user NSIS installer contains the matching Windows executables outside ASAR; it runs the app at normal user integrity. Use a separate native build for each architecture. Mac helper resources and release settings remain under the Mac configuration.

NSIS uses a ZIP payload with differential packages disabled. The bundled NSIS 7-Zip decoder can silently omit ARM64 executables and DLLs compressed with the newer ARM64 branch filter ([upstream issue #9983](https://github.com/electron-userland/electron-builder/issues/9983)); ZIP avoids that filter. Verify the installed executable and native helpers, not only a successful installer build.

Windows production signing and a dedicated update feed are release gates. Local development builds do not inherit the Mac feed or Squirrel.Mac installer. Automatic updates stay disabled on Windows and Linux until their signed release pipelines are configured; no signature verification is weakened. A local unsigned installer is for development validation and is not a production release.

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

Screen context uses a bounded UI Automation walk of the foreground window, with visible text ranges for fields, separate field-scoped caret context, password/hidden-text exclusions and Mac-compatible reading-order rendering. The walk has the Mac reference budgets of 5,000 nodes / 1.5 seconds plus an aggregate text cap. The Electron regression checks real provider visibility and field boundaries; a portable renderer test checks line/column formatting and Unicode-safe limits.

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
