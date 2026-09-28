// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Every tunable number for the dictation flow lives here (no hardcoded values at call sites).
 * Durations are milliseconds unless a name says otherwise.
 */

// MARK: Push-to-talk

/** The microphone starts booting at key-down, but the overlay appears only once the key has been
 * held this long. A shorter hold is an accidental tap: discarded, never shown. */
export const minimumHoldDuration = 250;
/** A tap (released within `minimumHoldDuration`) followed by another press this soon after its
 * release starts a hands-free dictation. */
export const doubleTapWindow = 400;

// MARK: Audio

/** Upload format: 16 kHz mono 16-bit PCM WAV — what Whisper-class models consume natively, at
 * ~32 KB per second of speech. The microphone is captured at this rate directly. */
export const recordingSampleRate = 16_000;
/** Frames per microphone chunk sent from the audio window (~85 ms at 16 kHz), the rate the level
 * envelope below is tuned for (~12 chunks a second). */
export const audioChunkFrames = 1_365;
/** Fixed loudness → 0…1 scale for the recording's peak-level diagnostics. */
export const levelQuietDecibels = -50;
export const levelLoudDecibels = -30;
/** Waveform (`LevelEnvelope`): per-chunk EMA weights. The floor and peak envelopes move this
 * fraction toward a reading on their fast side (floor down, peak up)… */
export const envelopeFastAlpha = 0.5;
/** …and this fraction on their slow side (≈ 4 s time constant at ~12 chunks/s). */
export const envelopeSlowAlpha = 0.02;
/** The envelopes are at least this many dB apart, so a steady hum doesn't swing the bars full
 * height. Small: a quiet mic's speech can sit only 2–5 dB above its room noise. */
export const envelopeMinimumRange = 4;
/** Quieter than this is digital silence (the device starting): not yet hearing anything. */
export const silenceDecibels = -80;
/** The overlay level moves this fraction of the way to a louder reading per chunk
 * (0 = frozen, 1 = no smoothing)… */
export const levelAttack = 0.7;
/** …and this much when it falls, so the waveform jumps with the voice and settles gently. */
export const levelRelease = 0.25;
/** Recording continues this long after the key is released, so the last word isn't clipped:
 * people tend to let go while still finishing it. */
export const releaseTailDuration = 300;
/** Debug builds only: the log file moves aside past this size, keeping one earlier file. Sized for
 * full content logging (ADR-DESK-015): a dictation logs its screen read several times. */
export const logFileMaxBytes = 50_000_000;
/** Debug builds only: the latest recording's file name in the temporary directory, overwritten each
 * time ("Play Last Recording"). */
export const debugLastRecordingFileName = "TabMail-last-dictation.wav";
/** Recording stops and is sent automatically at this length: the backend transcribes at most
 * 120 s of audio, until chunking arrives (issue #1). */
export const maxRecordingDuration = 120_000;
/** Longest the audio window may take to open the microphone before the dictation fails. */
export const microphoneStartTimeout = 5_000;

// MARK: Insertion

/** How long the target app gets to read the pasteboard before the user's clipboard is restored. */
export const clipboardRestoreDelay = 500;

// MARK: Screen context

/** How long the cleanup waits for the screen read once the transcript is ready. The read is best
 * effort: not done by then, the cleanup runs without it (ADR-DESK-008). */
export const contextWait = 500;

// MARK: Backend

export const productionBackendURL = "https://api.tabmail.ai";
export const developmentBackendURL = "https://dev.tabmail.ai";
export const transcribePath = "dictation/transcribe";
export const completionsPath = "completions/chat";
/** The backend prompt that fixes recognition errors in a transcript using the screen context. */
export const cleanupPrompt = "system_prompt_dictate_cleanup";
/** Sent as `X-Client-Type` to identify this client to the backend. Usage is recorded under it, and
 * the admin panel shows it as the macOS device. */
export const clientType = "macos";
export const transcriptionRequestTimeout = 45_000;
/** Longest pause in the cleanup's response stream (the backend sends keepalives while the model
 * works). */
export const completionsRequestTimeout = 30_000;
/** Longest the cleanup may take; past it the transcript is pasted as heard (ADR-DESK-008). */
export const cleanupTimeout = 3_000;

// MARK: Agent mode (Space during the hold)

/** The backend prompt that chooses the tool for a spoken request. */
export const agentPrompt = "system_prompt_desktop_agent";
/** The backend prompts behind the agent's tools. */
export const agentEditPrompt = "system_prompt_desktop_edit";
export const agentComposePrompt = "system_prompt_desktop_compose";
export const agentThunderbirdPrompt = "system_prompt_desktop_thunderbird";
export const agentAnswerPrompt = "system_prompt_desktop_answer";
/** The backend's own tools the Answer prompt may call, always listed in its `available_tools`: they
 * run on the server, read nothing of the user's, and answer "what day is next Friday" right. */
export const answerServerTools: readonly string[] = ["date_to_day", "time_delta"];
/** What the model reads for a tool call the user declined in the chat window. */
export const loopToolDeclined = "The user declined, so nothing was done.";
/** The longest range `calendar_read` reads at once, in days: EventKit reads at most four years of
 * events for one request and silently drops the rest, so a longer range is refused, not cut short. */
export const calendarReadMaxDays = 4 * 365;

/** How long an event the user gave no end or duration for lasts, as Calendar's own default. */
export const calendarEventDefaultDuration = 60 * 60 * 1_000;
/** The most contacts one search returns to the model; more say so, for a narrower search. */
export const contactsSearchMaxResults = 10;
/** The most items one file search returns to the model, newest first; more say so. */
export const filesSearchMaxResults = 10;
/** The most notes one search returns to the model, each in full, newest first; more say so. */
export const notesSearchMaxResults = 5;
/** Longest a Notes or Messages script waits for the app to answer one command, in seconds
 * (AppleScript's `with timeout`): past it the request fails rather than hangs. A whole run has no
 * deadline; the user ends it by cancelling. */
export const appleScriptTimeoutSeconds = 60;
/** The most a Notes or Messages script may return, in bytes: every note a search matches comes back
 * in full, and more than this fails the search rather than cutting a note short. */
export const appleScriptMaxOutputBytes = 64 * 1024 * 1024;
/** The fewest digits a phone number `messages_send` sends to has. */
export const phoneNumberMinDigits = 5;
/** The most shortcut names one `shortcuts_list` returns to the model; more say so. */
export const shortcutsListMaxResults = 50;
/** The most a `shortcuts` command may print, in bytes (every shortcut's name, or a run's text output):
 * more fails the request rather than cutting the output short. */
export const shortcutsMaxOutputBytes = 64 * 1024 * 1024;
/** The backend's web search, which the Web switch lists (`connectorServerTools`); while it is listed
 * the request says `web_search_enabled`, without which the backend refuses `web_read` and `web_open`. */
export const webSearchTool = "search_web";
/** `web_read`, as the Thunderbird add-on reads a page: the page's and robots.txt's timeouts, the most
 * characters of a page the model gets, and the User-Agent both are asked with. */
export const webReadTimeoutMs = 30_000;
export const webReadRobotsTimeoutMs = 5_000;
export const webReadMaxCharacters = 500_000;
export const webUserAgent = "TabMail/1.0 (macOS; +https://tabmail.app)";
/** The most of a page's body `web_read` reads, in bytes: enough for `webReadMaxCharacters` in any
 * encoding (at most 4 bytes a character), so an endless page never fills the memory. */
export const webReadMaxBytes = webReadMaxCharacters * 4;

// MARK: Thunderbird connector (drives TabMail's chat window from outside)

/** The email apps the Thunderbird tool can drive (TabMail's add-on runs in them), in the order
 * Settings lists them: Thunderbird (release and ESR) and Thunderbird Beta. */
export const thunderbirdBundleIdentifiers: readonly string[] = ["org.mozilla.thunderbird", "org.mozilla.thunderbirdbeta"];
/** Where Thunderbird keeps `profiles.ini` and its profiles, relative to the home directory. */
export const thunderbirdDataDirectory = "Library/Thunderbird";
/** TabMail's add-on (`browser_specific_settings.gecko.id` in its manifest). */
export const tabMailAddonID = "thunderbird@tabmail.ai";
/** The TabMail chat window's title (`chat/chat.html`). */
export const thunderbirdChatWindowTitle = "TabMail Chat";
/** Longest a Thunderbird that was not running may take to show its first window. */
export const thunderbirdLaunchTimeout = 20_000;
/** After that first window, the add-on still has to load and register its shortcut. */
export const thunderbirdAddonSettle = 3_000;
/** Longest Thunderbird may take to come to the front. */
export const thunderbirdActivateTimeout = 3_000;
/** The chat's input, a contenteditable that Gecko reports as a text area. The chat focuses it only
 * once it is ready for a message (`awaitUserInput` in `chat/modules/converse.js`). */
export const thunderbirdChatInputRole = "AXTextArea";
/** Longest the chat may take, after the shortcut, to open and be ready for a message. */
export const thunderbirdChatTimeout = 15_000;
/** How often those waits check. */
export const thunderbirdPollInterval = 100;

// MARK: Account (Supabase auth at auth.tabmail.ai)

export const authBaseURL = "https://auth.tabmail.ai";
/** Supabase publishable key: public by design, shipped in every TabMail client. */
export const authPublishableKey = "sb_publishable_1mtT87g-94P0yxFgM19Itw_P3ih9PUD";
export const authRequestTimeout = 15_000;
/** Refresh the access token when it expires within this many seconds. */
export const tokenRefreshLeewaySeconds = 60;
export const keychainService = "ai.tabmail.voice.session";
export const keychainAccount = "session";

// MARK: Permissions

/** While Accessibility is not yet granted, how often to re-check (the grant happens in System
 * Settings). */
export const accessibilityPollInterval = 1_000;

// MARK: Native helpers

/** Longest a request to the macOS helper may take before it counts as failed. The screen read has
 * its own, longer budget (the helper's `HelperConfig.contextTimeBudget`) on top of this. */
export const helperRequestTimeout = 3_000;
/** Longest the helper's screen read may take: its own time budget for the Accessibility walk
 * (`HelperConfig.contextTimeBudget`, 1.5 s) and then some for a busy app's replies. */
export const screenReadTimeout = 5_000;
/** Longest a Calendar or Reminders request to the helper may take: the first one waits while
 * macOS asks the user for access. */
export const eventStoreRequestTimeout = 120_000;
/** Longest a Contacts request to the helper may take: the first one waits while macOS asks the user
 * for access, as for Calendar. */
export const contactStoreRequestTimeout = eventStoreRequestTimeout;
/** Longest a Spotlight search or an open may take in the helper: a search over the whole home
 * folder, or an app launching to open a document. */
export const fileStoreRequestTimeout = 30_000;
/** A crashed helper is restarted after this long. */
export const helperRestartDelay = 1_000;

// MARK: Welcome wizard

export const termsURL = "https://tabmail.ai/terms";
export const privacyURL = "https://tabmail.ai/privacy";
export const welcomeWindowSize = { width: 560, height: 660 };
/** An agent tool's icon beside its switch in Settings and the welcome wizard. */
export const settingsToolIconSize = 14;
/** Top rail, as in the Thunderbird welcome wizard: category labels over one bubble per step. */
export const welcomeRailBubbleSize = 8;
/** The current step's bubble is drawn this much larger. */
export const welcomeRailActiveBubbleScale = 1.4;
export const welcomeRailCategorySpacing = 32;
export const welcomeRailBubbleSpacing = 6;
/** A category not being shown is drawn at this opacity. */
export const welcomeRailInactiveOpacity = 0.35;
export const welcomeIconSize = 56;
/** The icon beside each of the consent page's points, as SwiftUI draws a label's beside body text. */
export const welcomeLabelIconSize = 16;
/** Settings: a sidebar of sections (frosted on macOS) beside the chosen section's cards (owner,
 * 2026-09-27: "themed and look professional", not the bland grey; chose the branded sidebar). */
export const settingsWindowSize = { width: 700, height: 500 };
export const settingsSidebarWidth = 200;
export const settingsAppIconSize = 36;
export const settingsSectionIconSize = 16;
/** The window's own colour where macOS's frosted material is not drawn (Windows, Linux). */
export const settingsWindowColour = { light: "#f4f3f8", dark: "#1f1e24" };
export const contextDebugWindowSize = { width: 720, height: 560 };

// MARK: Overlay

/** Gap between the caret's line and the top of the pill. */
export const overlayCaretGap = 4;
export const overlayFontSize = 13;
export const pillHeight = 26;
export const pillHorizontalPadding = 14;
/** Keeps text off the pill's rounded top and bottom when a message wraps. */
export const pillVerticalPadding = 5;
export const pillContentSpacing = 8;
export const pillMaxTextWidth = 360;
export const pillMaxTextLines = 3;
export const pillBorderWidth = 1;
export const pillGlowOpacity = 0.35;
export const pillGlowRadius = 8;
/** The pill grows out of the swirl from this fraction of its size. */
export const pillAppearScale = 0.2;
export const pillSpringResponse = 0.25;
/** CSS's stand-in for that spring: a little overshoot. */
export const pillSpringEasing = "cubic-bezier(0.3, 1.25, 0.5, 1)";
/** Warm-up swirl: particles spiral from `swirlStartRadius` to `swirlOrbitRadius`. */
export const swirlParticleCount = 14;
export const swirlStartRadius = 36;
export const swirlOrbitRadius = 7;
export const swirlSpiralSpread = 0.6;
export const swirlGatherSeconds = 0.3;
export const swirlRevolutionsPerSecond = 1.4;
export const swirlParticleSize = 5;
/** Number of bars in the pill's waveform. */
export const overlayMeterBarCount = 9;
export const overlayMeterBarWidth = 3;
export const overlayMeterBarSpacing = 3;
export const overlayMeterMinBarHeight = 3;
export const overlayMeterMaxBarHeight = 18;
/** The listening pill's height: the waveform between the pill's vertical padding. */
export const listeningPillHeight = Math.max(pillHeight, overlayMeterMaxBarHeight + 2 * pillVerticalPadding);
/** The language badge left of the waveform: a circle as tall as the waveform, inset so it is
 * concentric with the pill's rounded end. */
export const languageBadgeDiameter = overlayMeterMaxBarHeight;
export const languageBadgeInset = (listeningPillHeight - languageBadgeDiameter) / 2;
export const languageBadgeFontSize = 8;
/** Bar height follows level^exponent (< 1 lifts quieter speech), times the gain. */
export const waveformLevelExponent = 1;
export const waveformGain = 1;
/** The bars always ripple this much (0…1) while listening, so the pill looks alive between words. */
export const waveformIdleLevel = 0.05;
/** Each bar's ripple speed differs by up to this fraction, so the motion looks organic. */
export const waveformSpeedVariance = 0.2;
/** Outer bars reach this fraction of the centre bar's height. */
export const overlayMeterEdgeBarWeight = 0.45;
/** Travelling ripple across the bars (radians per second, radians per bar, share of height). */
export const waveformRippleSpeed = 9;
export const waveformRipplePhase = 0.7;
export const waveformRippleDepth = 0.25;
/** While transcribing, the pill is a circle with a gradient arc circling its rim. */
export const thinkingRimWidth = 2.5;
export const thinkingArcFraction = 0.7;
export const thinkingRevolutionsPerSecond = 1.2;
export const thinkingTrackOpacity = 0.2;
/** The arc runs from blue to this point on the blue → purple gradient. */
export const thinkingArcEndColour = 0.6;
/** Pill fill: a soft off-white (pure white glared). */
export const pillFillWhite = 0.96;
/** The overlay stays up this long after the dictation ends, for the exit animation. */
export const overlayDismissDuration = Math.round(swirlGatherSeconds * 1000) + 100;
/** Agent mode's bubbles around the pill, one per tool and connector: icon-only circles. */
export const agentBubbleDiameter = 24;
/** Gap between the pill and the bubbles, and between neighbouring bubbles. */
export const agentBubbleGap = 8;
/** The most bubbles in a row over or under the pill (`bubbleCentres`): with every tool offered at
 * once (three) and every connector (nine), a row over it, one bubble each side, and a row under it
 * (or a second over it). */
export const agentBubbleRowCapacity = 5;
/** Rows of bubbles over the pill at most: the first, and the one that goes over it when none fits
 * under it (`bubblesFitUnder`). */
export const agentBubbleRowsAbove = 2;
/** An app tool's icon (Thunderbird's) in its bubble. */
export const agentBubbleAppIconSize = 16;
/** A tool's symbol in its bubble. */
export const agentBubbleSymbolSize = 12;

// MARK: Tips

/** A tip (`DictationTip`): what it says, how long it shows and how many times, all set here
 * (owner, 2026-09-27: "the exact text and duration, or how many times we show it … at a single
 * location"). `lines` are the tooltip's `tipLineCount` lines; any `[key]` in a line is drawn as a
 * keycap reading `key` (`[space]`, `[esc]`), except `[hotkey]`, the dictation key's.
 * `displayDuration` null: shown for as long as it applies. `maxDisplays` null: shown every time;
 * otherwise it shows until the user does what it teaches, or at most this many times. */
export interface TipSettings {
  readonly lines: readonly string[];
  readonly displayDuration: number | null;
  readonly maxDisplays: number | null;
}

/** Space switches between dictation and agent mode: shown as a hold starts listening. */
export const switchModeTip: TipSettings = {
  lines: ["Press [space] to switch", "between dictation", "and agent mode"],
  displayDuration: 2_500,
  maxDisplays: 10,
};
/** A double tap dictates without holding: shown once a hold passes `doubleTapTipHoldDuration`. */
export const doubleTapTip: TipSettings = {
  lines: ["Double-tap [hotkey]", "to dictate", "without holding"],
  displayDuration: 4_000,
  maxDisplays: 5,
};
/** How hands-free listening ends: shown the whole time it listens, every time (owner, 2026-09-27). */
export const handsFreeTip: TipSettings = {
  lines: ["Tap [hotkey] to finish", "dictating, or", "tap [esc] to cancel"],
  displayDuration: null,
  maxDisplays: null,
};
/** A hold this long shows the double-tap tip: this user dictates at length, and need not hold. */
export const doubleTapTipHoldDuration = 20_000;

/** The tooltip a tip is drawn in: centred under the listening pill (or over it, `tipGoesAbove`), a
 * few words around keycaps. Dark, as macOS HUDs are, so it reads as the system's hint rather than
 * part of the pill. */
export const tipFontSize = 13;
/** A tip is `tipLineCount` centred lines of a few words, each `tipLineHeight` tall. */
export const tipLineCount = 3;
export const tipLineHeight = 18;
export const tipLineSpacing = 1;
export const tipVerticalPadding = 6;
export const tipHeight = 2 * tipVerticalPadding + tipLineCount * tipLineHeight + (tipLineCount - 1) * tipLineSpacing;
export const tipHorizontalPadding = 10;
export const tipSpacing = 5;
export const tipCornerRadius = 8;
/** Near-black fill, a hairline light border, and a soft drop shadow. */
export const tipFillWhite = 0.11;
export const tipFillOpacity = 0.94;
export const tipBorderOpacity = 0.12;
export const tipShadowOpacity = 0.3;
export const tipShadowRadius = 5;
export const tipShadowOffsetY = 2;
/** White text, the keycap's word a little brighter than the action's. */
export const tipTextOpacity = 0.78;
export const tipKeyTextOpacity = 0.95;
/** The keycap: a raised key, a lighter fill with a light border. */
export const tipKeyFontSize = 12;
export const tipKeyPadding = 5;
export const tipKeyHeight = 17;
export const tipKeyCornerRadius = 3.5;
export const tipKeyFillOpacity = 0.14;
export const tipKeyBorderOpacity = 0.22;
/** The tooltip's arrow, pointing at the pill. */
export const tipArrowWidth = 10;
export const tipArrowHeight = 5;
/** Gap between the pill (or the bubbles over it) and the tip of the hint's arrow. */
export const tipGap = 4;
/** Room the hint takes beside the pill: the gap, the arrow and the box. */
export const tipFootprint = tipGap + tipArrowHeight + tipHeight;
/** Transparent canvas the overlay draws in; the pill sizes itself inside it. The pill sits
 * vertically centred, with room on each side for a tip (and its shadow) past agent mode's bubbles:
 * two rows of them and a tip over the pill (`tipGoesAbove`), or one row and a tip under it. */
export const overlayCanvasSize = {
  width: 440,
  height: pillHeight + 2 * (agentBubbleRowsAbove * (agentBubbleGap + agentBubbleDiameter) + tipFootprint + tipShadowRadius + tipShadowOffsetY),
};
/** The running tool's icon in the pill. */
export const agentRunningSymbolSize = 12;
/** A bubble whose tool is not the one running fades to this opacity. */
export const agentBubbleIdleOpacity = 0.45;
/** The running tool's bubble: a gradient arc circling its border. */
export const agentBubbleRimWidth = 2;
export const agentBubbleRevolutionsPerSecond = 1;
/** The running tool's bubble grows to this scale, upward from its bottom edge, on a bouncy spring
 * that overshoots a little ("a genie effect", so the tool in use is obvious). */
export const agentBubbleRunningScale = 1.4;
export const agentBubbleRunningSpringResponse = 0.35;
/** CSS's stand-in for that spring: a bouncier overshoot than the pill's. */
export const agentBubbleRunningSpringEasing = "cubic-bezier(0.3, 1.7, 0.5, 1)";
/** How long an error message stays on the overlay. */
export const overlayErrorDisplayDuration = 3_000;

// MARK: Chat window (the Answer tool's replies; the pill grows into it)

/** Left untouched, the chat window closes after this long; a hover, click or scroll, or a follow-up,
 * keeps it open until closed (owner, 2026-09-26). */
export const chatTimeout = 30_000;
/** How long the chat window's question shows before an answer to it counts: a double-click on the
 * last question's Confirm, or a click aimed at its card as the next question replaces it, never
 * answers the next one, which the user has not seen (a double-click's two clicks come within about
 * half a second on macOS by default). */
export const chatConfirmationMinimumDisplay = 500;
export const chatWidth = 380;
/** The chat grows with its conversation up to this height, then scrolls. */
export const chatMaxHeight = 320;
/** Room around the chat window in the overlay window, for its shadow. */
export const chatShadowMargin = 16;
export const chatCornerRadius = 14;
export const chatPadding = 12;
export const chatTurnSpacing = 10;
export const chatBubblePadding = 8;
export const chatBubbleCornerRadius = 10;
/** The user's words, in a tinted bubble on the right, as far as this share of the chat's width. */
export const chatRequestMaxWidthFraction = 0.8;
export const chatRequestFillOpacity = 0.12;
export const chatFontSize = 13;
export const chatCaptionFontSize = 11;
export const chatCloseButtonSize = 18;
/** The spinner beside what a tool the answer's model called is doing, while it runs. */
export const chatActivitySpinnerRevolutionsPerSecond = 1;
export const chatActivitySpinnerLineWidth = 1.5;
/** The timeout bar along the chat's bottom edge, shrinking from right to left as the time runs out
 * (like the iOS app's `PendingSendToast`). */
export const chatTimeoutBarHeight = 2;
export const chatTimeoutBarOpacity = 0.7;
