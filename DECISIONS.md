# TabMail Desktop — Decisions

Compact index of architectural decisions for `tabmail-desktop`. Cross-cutting decisions live in the
root `DECISIONS.md` (notably ADR-004 zero content retention, which dictation audio and transcripts
fall under).

---

## ADR-DESK-001: Native Swift menu-bar app, on-device speech recognition

> ⛔ **Speech-recognition half SUPERSEDED by ADR-DESK-005 (owner 2026-09-24).** The native Swift menu-bar app stands; on-device `SpeechAnalyzer` was removed in favour of backend STT so all platforms share one engine. Kept for history.

**Context:** Phase 1 replaces Wispr Flow for basic system-wide dictation. Options: Electron/Tauri
(cross-platform) or native Swift; cloud STT (Groq Whisper via the backend) or on-device.

**Decision:** Native Swift/SwiftUI menu-bar app (`LSUIElement`), macOS 26+. Speech is transcribed
on-device with `SpeechAnalyzer` + `DictationTranscriber` (`.progressiveLongDictation`, punctuated).

**Rationale:** Global hotkeys, Accessibility, keystroke posting and audio are all first-class in
AppKit; the team already ships Swift (iOS) and can share code in phase 4. On-device STT costs
nothing per minute, needs no account, sends no audio anywhere (ADR-004 by construction), and
`AnalysisContext.contextualStrings` gives phase 2 a private way to bias recognition towards names
from mail and calendar. Verified end-to-end by `SpeechTranscriptionSessionTests`.

**Consequences:**
- macOS only; Windows would be a separate client.
- Accuracy is Apple's model's. If it proves insufficient against Wispr Flow, a server STT
  endpoint (Groq `whisper-large-v3-turbo` through the TabMail backend) is the escalation. That
  sends audio off-device, so it's the owner's call.
- First use of a language downloads its model (`AssetInventory`); the app does this at launch.

## ADR-DESK-002: Insert by pasting, then restore the clipboard

**Context:** Dictated text must land in any focused field: native, Electron, browser, terminal.

**Decision:** Write the text to the general pasteboard (marked `org.nspasteboard.TransientType` /
`ConcealedType`), post ⌘V, wait `DictationConfig.clipboardRestoreDelay`, then restore every item
and type of the prior clipboard, unless the pasteboard changed meanwhile.

**Rationale:** Setting `kAXSelectedTextAttribute` silently fails in most web views and Electron
apps; synthesising per-character key events is slow and breaks on non-ASCII text. Pasting is what
Wispr Flow and similar tools do.

**Consequences:** A clipboard manager that ignores the transient markers may record the text.
Apps that read the pasteboard lazily after the restore delay would paste the old clipboard; the
delay is a config value to tune if that's seen.

## ADR-DESK-003: Not sandboxed; Developer ID distribution

**Context:** The global hotkey (`NSEvent` global monitors) and ⌘V posting both need Accessibility,
which the App Sandbox forbids.

**Decision:** No App Sandbox; hardened runtime with the `audio-input` entitlement. Distribute as a
Developer ID-signed, notarized app outside the Mac App Store.

**Consequences:** No Mac App Store listing. TCC grants are bound to the code signature, so
development builds must be signed with a stable team (`DEVELOPMENT_TEAM` in the gitignored `Secrets.xcconfig`, as in tabmail-ios), or Accessibility
is lost on every rebuild.

## ADR-DESK-004: Phase 1 needs no account and no backend

> ⛔ **SUPERSEDED by ADR-DESK-005 (2026-09-24):** server STT makes sign-in a phase-1 requirement. Kept for history.

**Context:** Phase 1 is "dictation anywhere, nothing complicated".

**Decision:** Phase 1 ships without TabMail sign-in or backend calls. Sign-in (Supabase, mirroring
iOS `TabMailAuthService`) arrives with the first backend feature: AI cleanup in phase 1b or phase 2.

**Consequences:** Adding backend features later requires the backend to recognise a `desktop`
client type.

## ADR-DESK-005: Speech-to-text on the TabMail backend (OpenRouter), shared by all platforms

**Context:** Owner, 2026-09-24: dictation should use an OpenRouter speech-to-text model via our
backend, so the same engine serves desktop, iOS and Thunderbird later.

**Decision:** The app records 16 kHz mono 16-bit PCM (`AudioRecorder`), wraps it in WAV
(`WAVEncoder`) and posts it as base64 JSON to the TabMail backend's `POST /dictation/transcribe`,
which relays it to an OpenRouter speech-to-text model. Requires TabMail sign-in (email one-time
code, same flow as iOS) and an active subscription; dictation counts toward the account's usage.

**Rationale:** One engine and one model switch (backend config) for every client; far better
multilingual accuracy than Apple's on-device model.

**Consequences:**
- Audio leaves the Mac. The TabMail backend stores and logs neither audio nor text.
- No live transcript while speaking (batch upload on release); latency ≈ upload + model time.
- Every held recording is uploaded; an empty transcript shows "Didn't catch that." There is no
  loudness gate: on a Studio Display mic, speech measured only 3–10 dB above the room noise
  (−30 to −40 dB RMS against about −45 dB), so the earlier fixed −32 dB gate rejected nearly
  all real speech, and a gate relative to the noise floor couldn't separate a quiet sentence
  from silence either. The model, chosen by comparison with `Scripts/stt-compare/`, handles
  that input. Recording continues `releaseTailDuration` after the key is released so the last
  word isn't clipped.
- Recording auto-stops at `maxRecordingDuration` (5 min ≈ 9.6 MB, under the backend's 10 MiB upload limit).
- A failed transcription loses that recording (no retry queue yet).
- macOS 15+ (the macOS 26 floor existed only for `SpeechAnalyzer`).

## ADR-DESK-006: Boot the microphone at key-down, reveal the overlay at the caret after the hold

**Context:** Owner, 2026-09-24: the app must feel instant. Measured on a Studio Display mic:
opening the input node ≈ 0.5 s and starting the device ≈ 0.5 s, and both ran on the main thread,
so the overlay appeared only after about a second or more.

**Decision:** Key-down starts the microphone on a serial queue (`.arming`, nothing shown). The
overlay appears at the text cursor once the hold reaches `minimumHoldDuration`; a shorter tap is
discarded unseen. The microphone-off half (engine, input node, tap, `prepare()`) is done ahead of
time and again after every dictation, and rebuilt when the system default input changes. The
overlay shows a gathering swirl until the first audio arrives, then a waveform pill that follows
the voice (`LevelMeter`, adaptive to the mic and room), then a circle with a spinning rim while
transcribing; the pill is
the surface for status now and agent responses later (as on iOS).

**Consequences:**
- The ≈ 0.5 s device start can't be hidden without keeping the mic running; speech in that
  window is lost. The swirl → pill change tells the user when audio is live. A hot-mic window is
  an owner decision (privacy indicator stays on).
- The overlay anchors to the caret, else to the focused element when it's field-sized
  (`focusedElementMaxAnchorHeight`), else to the mouse pointer. The lookup asks the frontmost app
  directly and must finish before the overlay shows, so it never appears at the pointer and then
  jumps; placeholder rects (zero origin, off every screen) are ignored. The text-marker API is
  tried before the index range (Chromium/Electron keep markers current), and a line-sized
  "caret" box (Chromium at the start of a field, terminals at a wrapped line) anchors at its
  leading edge.
- Terminals report the terminal's own cursor. Full-screen TUIs (e.g. under tmux) hide it and
  draw their own caret, so the overlay follows the hidden cursor, typically a bottom-row edge.

