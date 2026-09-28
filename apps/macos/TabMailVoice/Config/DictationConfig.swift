// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AVFoundation
import CoreGraphics
import Foundation

/// Every tunable number for the dictation flow lives here (no hardcoded values at call sites).
enum DictationConfig {
    // MARK: Push-to-talk

    /// The microphone starts booting at key-down, but the overlay appears only once the key has
    /// been held this long. A shorter hold is an accidental tap: discarded, never shown.
    static let minimumHoldDuration: Duration = .milliseconds(250)
    /// A tap (released within `minimumHoldDuration`) followed by another press this soon after its
    /// release starts a hands-free dictation.
    static let doubleTapWindow: Duration = .milliseconds(400)

    // MARK: Audio

    /// Frames per microphone tap callback (~85 ms at 48 kHz).
    static let audioTapBufferSize: AVAudioFrameCount = 4096
    /// Fixed loudness → 0…1 scale for the recording's peak-level diagnostics.
    static let levelQuietDecibels: Float = -50
    static let levelLoudDecibels: Float = -30
    /// Waveform (`LevelEnvelope`): per-buffer EMA weights. The floor and peak envelopes move this
    /// fraction toward a reading on their fast side (floor down, peak up)…
    static let envelopeFastAlpha: Float = 0.5
    /// …and this fraction on their slow side (≈ 4 s time constant at ~12 buffers/s).
    static let envelopeSlowAlpha: Float = 0.02
    /// The envelopes are at least this many dB apart, so a steady hum doesn't swing the bars
    /// full height. Small: a quiet mic's speech can sit only 2–5 dB above its room noise.
    static let envelopeMinimumRange: Float = 4
    /// Quieter than this is digital silence (the device starting): not yet hearing anything.
    static let silenceDecibels: Float = -80
    /// The overlay level moves this fraction of the way to a louder reading per buffer
    /// (0 = frozen, 1 = no smoothing)…
    static let levelAttack: Float = 0.7
    /// …and this much when it falls, so the waveform jumps with the voice and settles gently.
    static let levelRelease: Float = 0.25
    /// Upload format: 16 kHz mono 16-bit PCM WAV — what Whisper-class models consume natively,
    /// at ~32 KB per second of speech.
    static let recordingSampleRate: Double = 16_000
    /// Recording continues this long after the key is released, so the last word isn't clipped:
    /// people tend to let go while still finishing it.
    static let releaseTailDuration: Duration = .milliseconds(300)
    #if DEBUG
    /// Debug builds only: the log file (`LogFile`) moves aside past this size, keeping one earlier file.
    /// Sized for full content logging (ADR-DESK-015): a dictation logs its screen read several times.
    static let logFileMaxBytes = 50_000_000
    /// Debug builds only: the latest recording, overwritten each time ("Play Last Recording").
    static let debugLastRecordingURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("TabMail-last-dictation.wav")
    #endif
    /// Recording stops and is sent automatically at this length. Must stay under the backend's
    /// upload limit (10 MiB): 5 minutes of 16 kHz 16-bit mono is ~9.6 MB.
    static let maxRecordingDuration: Duration = .seconds(300)

    // MARK: Insertion

    /// How long the target app gets to read the pasteboard before the user's clipboard is restored.
    static let clipboardRestoreDelay: Duration = .milliseconds(500)
    /// Pause between posting the paste keystroke's key-down and key-up events.
    static let pasteKeystrokeGap: Duration = .milliseconds(10)

    // MARK: Screen context

    /// Accessibility messaging timeout for the target app's own element while reading the screen
    /// context (seconds). macOS applies it to that element only; the elements reached from it
    /// (focused field, window, children) wait up to the system-wide timeout.
    static let contextLookupTimeout: Float = 0.25
    /// The walk of the focused window stops after this many elements…
    static let contextNodeBudget = 5_000
    /// …or after this long (seconds). It runs in the background while the user speaks.
    static let contextTimeBudget: Double = 1.5
    /// How long the cleanup waits for the screen read once the transcript is ready (seconds). The
    /// read is best effort: not done by then, the cleanup runs without it (ADR-DESK-008).
    static let contextWait: TimeInterval = 0.5
    /// Longest a helper command (tmux, ps) may run while reading the context (seconds); they
    /// normally answer in milliseconds.
    static let contextCommandTimeout: Double = 0.5
    /// Most parents followed from the focused element up to its window (deep web pages ≈ 40).
    static let contextMaxFocusDepth = 200
    /// Characters kept on each side of the caret.
    static let contextCaretWindowChars = 2_000
    /// Longest visible text kept from one text field or terminal.
    static let contextMaxFieldChars = 20_000
    /// Longest text gathered for one heading, link or table row.
    static let contextMaxBlockChars = 1_000
    /// Roles whose text is interface chrome, not content: skipped with their subtree.
    static let contextSkippedRoles: Set<String> = [
        "AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXMenuBar",
        "AXMenu", "AXMenuItem", "AXToolbar", "AXImage", "AXScrollBar", "AXSlider", "AXIncrementor",
    ]
    /// Controls read in web content, where the text drawn in them is content (a chat message's
    /// author is a button); native apps title their icon buttons, so there they stay skipped.
    static let contextWebControlRoles: Set<String> = [
        "AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton",
    ]
    /// Skipped roles read after all in web content: its controls, and toolbars, which there hold
    /// content (a chat's header with the conversation's name).
    static let contextWebReadRoles: Set<String> = contextWebControlRoles.union(["AXToolbar"])
    /// Elements at most this thin (points) show nothing: web apps keep screen-reader-only text,
    /// list items scrolled out of view and hover-only actions in 1-point boxes.
    static let contextHiddenMaxThickness: CGFloat = 1
    /// Two pieces of text are on one line when they overlap by this share of the shorter's height.
    static let contextSameLineOverlap: CGFloat = 0.5
    /// Terminal apps: their foreground program is looked up through tmux.
    static let terminalBundleIDs: Set<String> = [
        "com.googlecode.iterm2", "com.apple.Terminal", "com.mitchellh.ghostty", "com.github.wez.wezterm",
        "net.kovidgoyal.kitty", "org.alacritty",
    ]
    /// A tmux pane counts as the terminal in front when this share of its last non-blank lines
    /// (up to `tmuxPaneSampleLines`) appears in the front terminal's text.
    static let tmuxPaneSampleLines = 12
    static let tmuxPaneRequiredShare = 0.75
    /// How much of the front terminal's text (from the end) the pane lines are looked for in.
    static let tmuxScreenTailChars = 60_000
    /// Where tmux is installed (Homebrew on Apple silicon, Homebrew on Intel, system).
    static let tmuxPaths = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]


    static let productionBackendURL = URL(string: "https://api.tabmail.ai")!
    static let developmentBackendURL = URL(string: "https://dev.tabmail.ai")!
    static let transcribePath = "dictation/transcribe"
    static let completionsPath = "completions/chat"
    /// The backend prompt that fixes recognition errors in a transcript using the screen context.
    static let cleanupPrompt = "system_prompt_dictate_cleanup"
    /// Sent as `X-Client-Type` to identify this client to the backend. Usage is recorded under it,
    /// and the admin panel shows it as the macOS device.
    static let clientType = "macos"
    static let transcriptionRequestTimeout: TimeInterval = 45
    /// Longest pause in the cleanup's response stream (the backend sends keepalives while the
    /// model works).
    static let completionsRequestTimeout: TimeInterval = 30
    /// Longest the cleanup may take (seconds); past it the transcript is pasted as heard
    /// (ADR-DESK-008).
    static let cleanupTimeout: TimeInterval = 3

    // MARK: Agent mode (Space during the hold)

    /// The backend prompt that chooses the tool for a spoken request.
    static let agentPrompt = "system_prompt_desktop_agent"
    /// The backend prompts behind the agent's tools.
    static let agentEditPrompt = "system_prompt_desktop_edit"
    static let agentComposePrompt = "system_prompt_desktop_compose"
    static let agentThunderbirdPrompt = "system_prompt_desktop_thunderbird"

    // MARK: Thunderbird connector (spike: drives TabMail's chat window from outside)

    /// The email apps the Thunderbird tool can drive (TabMail's add-on runs in them), in the order
    /// Settings lists them: Thunderbird (release and ESR) and Thunderbird Beta.
    static let thunderbirdBundleIdentifiers = ["org.mozilla.thunderbird", "org.mozilla.thunderbirdbeta"]
    /// Where Thunderbird (release, ESR and Beta alike) keeps `profiles.ini` and its profiles.
    static let thunderbirdDataDirectory = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Thunderbird")
    /// TabMail's add-on (`browser_specific_settings.gecko.id` in its manifest).
    static let tabMailAddonID = "thunderbird@tabmail.ai"
    /// Asked for the app that opens it, to find the user's default email app.
    static let mailtoURL = URL(string: "mailto:")!
    /// The TabMail chat window's title (`chat/chat.html`). On macOS Thunderbird titles an add-on's
    /// popup window with the page title alone (`extension-popup-title`, `popup.ftl`).
    static let thunderbirdChatWindowTitle = "TabMail Chat"
    /// Longest a Thunderbird that was not running may take to show its first window (seconds).
    static let thunderbirdLaunchTimeout: TimeInterval = 20
    /// After that first window, the add-on still has to load and register its shortcut (seconds).
    static let thunderbirdAddonSettle: TimeInterval = 3
    /// Longest Thunderbird may take to come to the front (seconds).
    static let thunderbirdActivateTimeout: TimeInterval = 3
    /// The chat's input, a contenteditable that Gecko reports as a text area. The chat focuses it
    /// only once it is ready for a message (`awaitUserInput` in `chat/modules/converse.js`), after
    /// loading its history and building its context; its window has its title long before that.
    static let thunderbirdChatInputRole = "AXTextArea"
    /// Longest the chat may take, after the shortcut, to open and be ready for a message: a chat
    /// just opened builds its inbox context and prompt first (seconds).
    static let thunderbirdChatTimeout: TimeInterval = 15
    /// How often those waits check (seconds).
    static let thunderbirdPollInterval: TimeInterval = 0.1
    /// Accessibility calls into Thunderbird give up after this long (seconds).
    static let thunderbirdAccessibilityTimeout: Float = 0.5

    // MARK: Account (Supabase auth at auth.tabmail.ai)

    static let authBaseURL = URL(string: "https://auth.tabmail.ai")!
    /// Supabase publishable key: public by design, shipped in every TabMail client.
    static let authPublishableKey = "sb_publishable_1mtT87g-94P0yxFgM19Itw_P3ih9PUD"
    static let authRequestTimeout: TimeInterval = 15
    /// Refresh the access token when it expires within this many seconds.
    static let tokenRefreshLeewaySeconds = 60
    static let keychainService = "ai.tabmail.voice.session"

    // MARK: Permissions

    /// While Accessibility is not yet granted, how often to re-check (the grant happens in System Settings).
    static let accessibilityPollInterval: Duration = .seconds(1)

    // MARK: Welcome wizard

    static let termsURL = URL(string: "https://tabmail.ai/terms")!
    static let privacyURL = URL(string: "https://tabmail.ai/privacy")!
    static let welcomeWindowSize = CGSize(width: 560, height: 500)
    /// Top rail, as in the Thunderbird welcome wizard: category labels over one bubble per step.
    static let welcomeRailBubbleSize: CGFloat = 8
    /// The current step's bubble is drawn this much larger.
    static let welcomeRailActiveBubbleScale: CGFloat = 1.4
    static let welcomeRailCategorySpacing: CGFloat = 32
    static let welcomeRailBubbleSpacing: CGFloat = 6
    /// A category not being shown is drawn at this opacity.
    static let welcomeRailInactiveOpacity: Double = 0.35
    static let welcomeIconSize: CGFloat = 56

    // MARK: Overlay

    /// Transparent canvas the overlay draws in; the pill sizes itself inside it. The pill sits vertically
    /// centred, with room on each side for a tip (and its shadow) past agent mode's bubbles: a tip goes
    /// under the pill, or over the bubbles above it (`OverlayPanelController.tipGoesAbove`).
    static let overlayCanvasSize = CGSize(
        width: 440,
        height: pillHeight + 2 * (agentBubbleGap + agentBubbleDiameter + tipFootprint + tipShadowRadius + tipShadowOffsetY)
    )
    /// Gap between the caret's line and the top of the pill.
    static let overlayCaretGap: CGFloat = 4
    /// A "caret" rect wider than this is a line or text box; the caret is its leading edge.
    static let caretMaxWidth: CGFloat = 4
    /// Without a caret, the focused element's frame anchors the overlay if it's at most this tall
    /// (a text field); taller elements (a whole editor or web view) fall back to the mouse pointer.
    static let focusedElementMaxAnchorHeight: CGFloat = 120
    /// Per-call cap on Accessibility calls into the frontmost app when locating the caret (seconds).
    static let caretLookupTimeout: Float = 0.1
    /// Cap on asking an app to build its accessibility tree (seconds). Off the main thread, and Gecko
    /// may be slow to answer while it starts its accessibility service.
    static let accessibilityActivationTimeout: Float = 1
    static let overlayFontSize: CGFloat = 13
    static let pillHeight: CGFloat = 26
    static let pillHorizontalPadding: CGFloat = 14
    /// Keeps text off the pill's rounded top and bottom when a message wraps.
    static let pillVerticalPadding: CGFloat = 5
    static let pillContentSpacing: CGFloat = 8
    static let pillMaxTextWidth: CGFloat = 360
    static let pillMaxTextLines = 3
    static let pillBorderWidth: CGFloat = 1
    static let pillGlowOpacity: Double = 0.35
    static let pillGlowRadius: CGFloat = 8
    /// The pill grows out of the swirl from this fraction of its size.
    static let pillAppearScale: CGFloat = 0.2
    static let pillSpringResponse: Double = 0.25
    static let pillSpringDamping: Double = 0.75
    /// Warm-up swirl: particles spiral from `swirlStartRadius` to `swirlOrbitRadius`.
    static let swirlParticleCount = 14
    static let swirlStartRadius: Double = 36
    static let swirlOrbitRadius: Double = 7
    static let swirlSpiralSpread: Double = 0.6
    static let swirlGatherSeconds: Double = 0.3
    static let swirlRevolutionsPerSecond: Double = 1.4
    static let swirlParticleSize: Double = 5
    /// Number of bars in the pill's waveform.
    static let overlayMeterBarCount = 9
    static let overlayMeterBarWidth: CGFloat = 3
    static let overlayMeterBarSpacing: CGFloat = 3
    static let overlayMeterMinBarHeight: CGFloat = 3
    static let overlayMeterMaxBarHeight: CGFloat = 18
    /// The listening pill's height: the waveform between the pill's vertical padding.
    static let listeningPillHeight = max(pillHeight, overlayMeterMaxBarHeight + 2 * pillVerticalPadding)
    /// The language badge left of the waveform: a circle as tall as the waveform, so the pill keeps
    /// its height, inset so it is concentric with the pill's rounded end.
    static let languageBadgeDiameter: CGFloat = overlayMeterMaxBarHeight
    static let languageBadgeInset: CGFloat = (listeningPillHeight - languageBadgeDiameter) / 2
    static let languageBadgeFontSize: CGFloat = 8
    /// Bar height follows level^exponent (< 1 lifts quieter speech), times the gain.
    static let waveformLevelExponent: Double = 1
    static let waveformGain: Double = 1
    /// The bars always ripple this much (0…1) while listening, so the pill looks alive between words.
    static let waveformIdleLevel: Double = 0.05
    /// Each bar's ripple speed differs by up to this fraction, so the motion looks organic.
    static let waveformSpeedVariance: Double = 0.2
    /// Outer bars reach this fraction of the centre bar's height.
    static let overlayMeterEdgeBarWeight: Double = 0.45
    /// Travelling ripple across the bars (radians per second, radians per bar, share of height).
    static let waveformRippleSpeed: Double = 9
    static let waveformRipplePhase: Double = 0.7
    static let waveformRippleDepth: Double = 0.25
    /// While transcribing, the pill is a circle with a gradient arc circling its rim.
    static let thinkingRimWidth: CGFloat = 2.5
    static let thinkingArcFraction: CGFloat = 0.7
    static let thinkingRevolutionsPerSecond: Double = 1.2
    static let thinkingTrackOpacity: Double = 0.2
    /// The arc runs from blue to this point on the blue → purple gradient: the full purple end
    /// reads reddish on the spinning arc.
    static let thinkingArcEndColour: Double = 0.6
    /// Pill fill: a soft off-white (pure white glared).
    static let pillFillWhite: Double = 0.96
    /// The overlay stays up this long after the dictation ends, for the exit animation (the pill
    /// shrinks into the swirl, which disperses over `swirlGatherSeconds`).
    static let overlayDismissDuration: Duration = .milliseconds(Int(swirlGatherSeconds * 1000) + 100)
    /// Agent mode's tool bubbles in a row above the pill: icon-only circles.
    static let agentBubbleDiameter: CGFloat = 24
    /// Gap between the pill and the bubbles' row, and between neighbouring bubbles.
    static let agentBubbleGap: CGFloat = 8
    /// An app tool's icon (Thunderbird's) in its bubble.
    static let agentBubbleAppIconSize: CGFloat = 16
    /// A tool's symbol in its bubble.
    static let agentBubbleSymbolSize: CGFloat = 12
    // MARK: Tips

    /// A tip (`DictationTip`): what it says, how long it shows and how many times, all set here
    /// (owner, 2026-09-27: "the exact text and duration, or how many times we show it … at a single
    /// location"). `lines` are the tooltip's `tipLineCount` lines; any `[key]` in a line is drawn as a
    /// keycap reading `key` (`[space]`, `[esc]`), except `[hotkey]`, the dictation key's. `displayDuration` nil: shown for as long as it
    /// applies. `maxDisplays` nil: shown every time; otherwise it shows until the user does what it
    /// teaches, or at most this many times.
    struct TipSettings: Sendable {
        let lines: [String]
        let displayDuration: Duration?
        let maxDisplays: Int?
    }

    /// Space switches between dictation and agent mode: shown as a hold starts listening.
    static let switchModeTip = TipSettings(
        lines: ["Press [space] to switch", "between dictation", "and agent mode"],
        displayDuration: .milliseconds(2500),
        maxDisplays: 10
    )
    /// A double tap dictates without holding: shown once a hold passes `doubleTapTipHoldDuration`.
    static let doubleTapTip = TipSettings(
        lines: ["Double-tap [hotkey]", "to dictate", "without holding"],
        displayDuration: .seconds(4),
        maxDisplays: 5
    )
    /// How hands-free listening ends: shown the whole time it listens, every time (owner, 2026-09-27).
    static let handsFreeTip = TipSettings(
        lines: ["Tap [hotkey] to finish", "dictating, or", "tap [esc] to cancel"],
        displayDuration: nil,
        maxDisplays: nil
    )
    /// A hold this long shows the double-tap tip: this user dictates at length, and need not hold.
    static let doubleTapTipHoldDuration: Duration = .seconds(20)

    /// The tooltip a tip is drawn in: centred under the listening pill, a few words around keycaps.
    /// Dark, as macOS HUDs are, so it reads as the system's hint rather than part of the pill.
    static let tipFontSize: CGFloat = 13
    /// A tip is `tipLineCount` centred lines of a few words, each `tipLineHeight` tall.
    static let tipLineCount = 3
    static let tipLineHeight: CGFloat = 18
    static let tipLineSpacing: CGFloat = 1
    static let tipVerticalPadding: CGFloat = 6
    static let tipHeight = 2 * tipVerticalPadding + CGFloat(tipLineCount) * tipLineHeight + CGFloat(tipLineCount - 1) * tipLineSpacing
    static let tipHorizontalPadding: CGFloat = 10
    static let tipSpacing: CGFloat = 5
    static let tipCornerRadius: CGFloat = 8
    /// Near-black fill, a hairline light border, and a soft drop shadow.
    static let tipFillWhite: Double = 0.11
    static let tipFillOpacity: Double = 0.94
    static let tipBorderOpacity: Double = 0.12
    static let tipShadowOpacity: Double = 0.3
    static let tipShadowRadius: CGFloat = 5
    static let tipShadowOffsetY: CGFloat = 2
    /// White text, the keycap's word a little brighter than the action's.
    static let tipTextOpacity: Double = 0.78
    static let tipKeyTextOpacity: Double = 0.95
    /// The "space" keycap: a raised key, a lighter fill with a light border.
    static let tipKeyFontSize: CGFloat = 12
    static let tipKeyPadding: CGFloat = 5
    static let tipKeyHeight: CGFloat = 17
    static let tipKeyCornerRadius: CGFloat = 3.5
    static let tipKeyFillOpacity: Double = 0.14
    static let tipKeyBorderOpacity: Double = 0.22
    /// The tooltip's arrow, pointing up at the pill.
    static let tipArrowWidth: CGFloat = 10
    static let tipArrowHeight: CGFloat = 5
    /// Gap between the pill and the tip of the hint's arrow.
    static let tipGap: CGFloat = 4
    /// Room the hint takes under the pill: the gap, the arrow and the box.
    static let tipFootprint = tipGap + tipArrowHeight + tipHeight
    /// The running tool's icon in the pill.
    static let agentRunningSymbolSize: CGFloat = 12
    /// A bubble whose tool is not the one running fades to this opacity.
    static let agentBubbleIdleOpacity: Double = 0.45
    /// The running tool's bubble: a gradient arc circling its border.
    static let agentBubbleRimWidth: CGFloat = 2
    static let agentBubbleRevolutionsPerSecond: Double = 1
    /// The running tool's bubble grows to this scale, upward from its bottom edge, on a bouncy spring
    /// that overshoots a little (owner, 2026-09-26: "a genie effect", so the tool in use is obvious).
    /// The canvas above the pill has room for it.
    static let agentBubbleRunningScale: CGFloat = 1.4
    static let agentBubbleRunningSpringResponse: Double = 0.35
    static let agentBubbleRunningSpringDamping: Double = 0.55
    /// How long an error message stays on the overlay.
    static let overlayErrorDisplayDuration: Duration = .seconds(3)
}
