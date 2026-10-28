# The dictation flow: start, finish, cancel, hands-free and agent mode

Routed verbatim from `PROJECT_STRUCTURE.md` (lines 121-182 at 45d9c585).

## Flow

`voice-hotkey` (`HotkeyMonitor` → `PushToTalkGesture`) sends each gesture action to the main
process, which hands it to `DictationController` (`src/core/dictation/controller.ts`):

1. **start** (key-down; the settings file read at launch, else the app is off (ADR-DESK-063, #285); consent given in the welcome wizard, signed in, both permissions): phase `arming`, nothing shown.
   The microphone starts (`SessionAudioCapture` → `voice-microphone`'s `MicrophoneCapture`, its engine
   prepared ahead) and streams samples into `AudioRecorder`; `voice-macos` finds the caret; the
   keyboard's language is read once, for the overlay's badge and the transcription request; the app in
   front is kept (`targetApp`), the only app the text may be pasted into (ADR-DESK-042). After
   `minimumHoldDuration` the phase becomes `listening` and the overlay appears at the caret (swirl
   until audio arrives, then the waveform pill). Releasing earlier discards everything unseen.
2. **finish**: the mic keeps recording `releaseTailDuration`, then stops. No audio, or an empty
   transcript, shows "Didn't catch that". Otherwise the WAV is uploaded via
   `TranscriptionClient` (one forced-refresh retry on 401) with the cleanup's variables: the screen
   context read at key-down (`ScreenContextProbe`, waited for up to `contextWait`) and the
   dictionary. The backend transcribes it and runs the cleanup prompt in the same request, under its
   own deadline (backend ADR-027), and `voice-macos` pastes the cleaned text into the focused field
   (`TextInserter`), then, once the target has read the text (or `readWait` passes), puts back the newest
   clipboard it saved, asked for every
   `clipboardSaveInterval` from key-down until the paste writes (`clipboardSave`, `ClipboardKeeper`:
   ADR-DESK-002, amended 2026-10-08, 2026-10-09 and 2026-10-20); with another app in front
   than at key-down (`focusChanged`), nothing is pasted or copied, and a note at the mouse pointer
   offers to copy it for 10 s (phase `notPasted`, carrying the text: a card showing it in a box with a copy sign; a click anywhere on it copies it and the note goes, its x dismisses it). Either way the text joins
   the paste history. If the cleanup failed for any reason, the transcript
   is pasted as heard (`DictationCleanup`). A long dictation (up to `maxRecordingDuration`, 10 min) is
   cut into chunks of up to 105 s, each overlapping the one before, as it is recorded (`Chunker`; cuts at pauses are off since 2026-10-07), each sent with its cleanup while the user
   goes on and retried in the background; at the release the last chunk is sent and the texts are
   joined in order (`joinChunkTexts`), up to the first chunk that gave up (ADR-DESK-049).
3. **cancel** (another key pressed during the hold): recording or upload is discarded; nothing
   is inserted.

A `generation` counter makes callbacks from a superseded dictation no-ops.

**Hands-free** (a tap, then a press within `doubleTapWindow`; ADR-DESK-021): the overlay shows at
once and the dictation goes on without the key until the hotkey is tapped again (finish) or Escape
(cancel); Space still switches the mode. A third press within `doubleTapWindow` (a triple tap)
opens the paste history instead, where the chat window opens, by the pill (ADR-DESK-043). **Tips** (`DictationTip`, under the listening pill): the Space
tip as a hold starts listening, the double-tap tip once a hold passes 20 s; each shows until learned
or shown its maximum number of times (`TipBook`, kept in the settings file). The hands-free tip ("tap the hotkey to
finish, or Escape to cancel") shows once the second press is released as a tap and stays up while
listening, over the pill when the overlay opened above the caret's line; it is never learned.

**Agent mode** (Space pressed during the hold, again to switch back; ADR-DESK-011): the same
recording and transcription, with the tool bubbles around the pill (ADR-DESK-033): Edit when text is selected,
Compose when not, and Answer (Thunderbird's tool, for when an email app is set up, is off until its
native connector: ADR-DESK-037); Edit and Compose only while switched on in Settings, Answer always
(ADR-DESK-022, amended 2026-10-27), and beside them a bubble for each app switched on. The transcript is a request,
carried out by one tool loop (`DesktopAgent.run`, the backend's `system_prompt_desktop_agent_loop`, from 0.2.0;
ADR-DESK-055): the backend's date tools and web search run there, and tools that run on this computer
(`ConnectorTool`) run in the app, shown in the chat window, asking first before sending or creating.
The selection's writing tool, Edit or Compose, takes the final text and ends the request: the chat
window closes and the text is pasted (Edit over the selection, Compose at the caret). A plain reply
opens a chat window over the pill, which rests there (ADR-DESK-036), and while it is open the hotkey
asks a follow-up carrying the conversation, until Escape, its X or 30 untouched seconds close it. The
phase is `running(null)` while the loop thinks (no bubble circles; the pill's rim does), then
`running(tool)` once the agent answers or writes (that bubble moves to the front of the row under the
pill and its border circles, as the pill's does; while one of Answer's apps runs a tool, that app's
bubble is the one in front and circling: one bubble runs at a time). The chat window opens only for a
reply or a tool's question (ADR-DESK-055 amendment 2026-10-07). A failure shows a
message and pastes nothing. No agent call has a deadline.

