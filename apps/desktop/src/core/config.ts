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

/** Recording format: 16 kHz mono 16-bit PCM (~32 KB per second of speech), uploaded as FLAC at about
 * half that. The microphone is captured at this rate directly. */
export const recordingSampleRate = 16_000;
/** The upload's FLAC encoding (`FLACEncoder`): samples per frame, and the most Rice partitions a
 * frame's residual is split into (2^order), as libFLAC's defaults. */
export const flacBlockSize = 4_096;
export const flacMaxPartitionOrder = 6;
/** Frames per live-meter interval (~85 ms at 16 kHz). LevelSampler groups native packets at this
 * shared cadence; the audio window also sends chunks this size. The envelope below is tuned for
 * ~12 readings a second. */
export const audioChunkFrames = 1_365;
/** Before upload the recording is scaled so its loudest sample sits this far below full scale (peak
 * normalization, `normalizePeak`), leaving headroom so nothing clips. Quiet microphones deliver
 * speech peaking 20–30 dB below full scale. Measured 2026-09-29 (`Scripts/stt-compare`, 10
 * recordings peaking at −22 to −29 dBFS, 3 runs each): at −3 dBFS the backend's model
 * (MAI-Transcribe-2) made 9.5 % word errors against 11.0 % unscaled, and a Whisper Large V3 host
 * that dropped most of the quiet speech (79 %) came down to 19 %. */
export const normalizedPeakDecibels = -3;
/** The most `normalizePeak` boosts (dB), so a recording of near-silence isn't raised into loud
 * noise. The quietest measured recording needed +26 dB. It never cuts a louder recording. */
export const maxNormalizationGainDecibels = 30;
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
 * people tend to let go while still finishing it. It adds to every dictation's wait: owner,
 * 2026-09-29, 150 ms (was 300). */
export const releaseTailDuration = 150;
/** The debug log file (`isDebugLogging`) moves aside past this size, keeping one earlier file. Sized for
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
/** The paste history a triple tap shows (ADR-DESK-043): the texts dictation and agent mode pasted, or
 * copied when they could not paste, the newest first, at most this many. In memory only, for the
 * app's life: no user content is saved. */
export const pasteHistoryLimit = 20;
/** The paste history window, opened where the chat window does (by the pill): this wide, as tall as its entries up to
 * `pasteHistoryMaxHeight`, then it scrolls; each entry shows at most `pasteHistoryEntryLines` lines
 * (the whole text is copied). */
export const pasteHistoryWindowWidth = 380;
export const pasteHistoryMaxHeight = 440;
export const pasteHistoryEntryLines = 3;
/** The window's padding and title, over its list: the list scrolls within the rest. */
export const pasteHistoryChromeHeight = 44;

// MARK: Screen context

/** How long a dictation's upload waits for the screen read, which the cleanup's variables travel with.
 * The read is best effort: not done by then, the cleanup runs without it (ADR-DESK-008). The read
 * started at key-down, so it is usually done. */
export const contextWait = 500;
/** The cleanup gets only the screen text around the caret, not the whole screen: this much before
 * the caret (about a paragraph) and after it, in UTF-16 code units, rounded to whole characters.
 * Owner, 2026-09-28: the whole screen (often 4k–13k characters) made the cleanup slow; agent mode
 * still gets all of it. */
export const cleanupContextBefore = 500;
export const cleanupContextAfter = 200;
/** The backend's limit on each cleanup field (its `transcription.json` `cleanup.maxFieldChars`,
 * ADR-027), in UTF-16 code units. Over it the backend refuses the whole request, the transcription
 * included, so every field is cut to it (`DictationCleanup.variables`): a window title is whatever
 * the app or web page sets. */
export const cleanupFieldMaxLength = 20_000;

// MARK: Backend

export const productionBackendURL = "https://api.tabmail.ai";
export const developmentBackendURL = "https://dev.tabmail.ai";
export const transcribePath = "dictation/transcribe";
export const completionsPath = "completions/chat";
/** The key-down warm-up's request (`TranscriptionClient.warmUp`), and the longest it may take. */
export const warmUpPath = "whoami";
export const warmUpRequestTimeout = 10_000;
/** Sent as `X-Client-Type` to identify this client to the backend. Usage is recorded under it, and
 * the admin panel shows it as the macOS device. */
export const clientType = "macos";
/** Longest the transcription request may take, the backend's cleanup included (the backend gives the
 * cleanup 1.5 s, owner 2026-09-28; backend ADR-027). */
export const transcriptionRequestTimeout = 45_000;
/** A transcription that failed on the server's side (a 5xx: the speech model behind the backend was
 * rate limited or failed) or lost its connection is tried again after each of these waits, in
 * milliseconds, before the dictation fails: owner, 2026-09-29, rather than make the user say it
 * again. */
export const transcriptionRetryDelays: readonly number[] = [500, 1_500];
/** Longest pause in an agent-mode completions response stream (the backend sends keepalives while
 * the model works). */
export const completionsRequestTimeout = 30_000;

// MARK: Dictionary (ADR-DESK-038)

/** The words sent with each dictation: the backend takes at most 200 (its ADR-025), half for the
 * user's dictionary, all of it sent, and half for the names and terms picked from the screen
 * (`contextTerms`). Each word is at most this many characters and this many space-separated words,
 * the backend's limits. */
export const dictionaryMaxEntries = 100;
export const contextTermsMax = 100;
export const dictionaryWordMaxChars = 50;
export const dictionaryWordMaxWords = 6;
/** After a dictation's paste, the field is read this often, for this long, to learn the user's
 * corrections to it. A correction counts once the field has not changed for one interval. */
export const correctionPollInterval = 500;
export const correctionWatchDuration = 30_000;
/** A field longer than this (UTF-16 code units) is not read: a whole document, not a message. */
export const correctionMaxFieldLength = 20_000;
/** A correction is learned only if it changed at most this share of the dictation's words (more is a
 * rewrite), and it respells a word rather than replacing it: the edit distance between the heard and
 * the corrected spelling is at most this share of the longer ("Zivora" → "Xyvora" is 2 of 6). */
export const correctionMaxChangedShare = 0.5;
export const correctionMaxEditShare = 0.65;
/** A lowercase correction that keeps at least this share of the shorter spelling's start, changing
 * only its end, is another form of the same word ("report" → "reports", "send" → "sent"), not
 * learned. */
export const correctionMinStemShare = 0.5;
/** A corrected word shorter than this (characters) is not learned. */
export const correctionMinWordLength = 3;
/** Everyday English words, never learned: replacing one with another ("then" → "than") is a change
 * of wording, not a name or term to spell. */
export const correctionCommonWords: ReadonlySet<string> = new Set(
  `about after again also always another any are around back because been before being best better
  between both but came can come could day did does done down each even every few find first for from
  get give going good got great had has have her here him his how into its just keep know last left
  like little long look made make many may might more most much must never new next not now off okay
  old once one only other our out over own put said same saw say see she should since some still
  such take than that the their them then there these they thing think this those though thought
  through too two under until upon use very want was way well went were what when where which while
  who why will with work would yes yet you your`.split(/\s+/),
);

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
export const connectorToolDeclined = "The user declined, so nothing was done.";
/** What the model reads when the user left a tool's question unanswered (`chatConfirmationTimeout`). */
export const connectorToolUnanswered = "The user didn't confirm in time, so nothing was done.";
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
 * deadline; the user ends it by canceling. */
export const appleScriptTimeoutSeconds = 60;
/** The most a Notes or Messages script may return, in bytes: every note a search matches comes back
 * in full, and more than this fails the search rather than cutting a note short. */
export const appleScriptMaxOutputBytes = 64 * 1024 * 1024;
/** The fewest digits a phone number `messages_send` sends to has. */
export const phoneNumberMinDigits = 5;
/** The backend's web search, which the Web switch lists (`Connector.serverTools`); while it is listed
 * the request says `web_search_enabled`, without which the backend refuses `web_read` and `web_open`. */
export const webSearchTool = "search_web";
/** `web_read`, as the Thunderbird add-on reads a page: the page's and robots.txt's timeouts, the most
 * characters of a page the model gets, and the User-Agent both are asked with. */
export const webReadTimeout = 30_000;
export const webReadRobotsTimeout = 5_000;
export const webReadMaxCharacters = 500_000;
export const webUserAgent = "TabMail/1.0 (macOS; +https://tabmail.app)";
/** The most of a page's body `web_read` reads, in bytes: enough for `webReadMaxCharacters` in any
 * encoding (at most 4 bytes a character), so an endless page never fills the memory. */
export const webReadMaxBytes = webReadMaxCharacters * 4;

// MARK: Apps excluded from screen reading

/** The password managers the screen is never read in, in every installation (owner, 2026-09-30), by
 * bundle identifier, in the order Settings names them. The user adds any other app in Settings ›
 * Privacy. */
export const builtInExcludedApps: readonly { bundleIdentifier: string; name: string }[] = [
  { bundleIdentifier: "com.apple.Passwords", name: "Passwords" },
  { bundleIdentifier: "com.apple.keychainaccess", name: "Keychain Access" },
  { bundleIdentifier: "com.1password.1password", name: "1Password" },
  { bundleIdentifier: "com.agilebits.onepassword7", name: "1Password 7" },
  { bundleIdentifier: "com.bitwarden.desktop", name: "Bitwarden" },
  { bundleIdentifier: "org.keepassxc.keepassxc", name: "KeePassXC" },
  { bundleIdentifier: "com.nordsec.nordpass", name: "NordPass" },
];
/** Windows executable identities, verified with the installed vendor package. */
export const windowsBuiltInExcludedApps: readonly { bundleIdentifier: string; name: string }[] = [
  { bundleIdentifier: "1Password.exe", name: "1Password" },
  { bundleIdentifier: "Bitwarden.exe", name: "Bitwarden" },
  { bundleIdentifier: "KeePassXC.exe", name: "KeePassXC" },
];
/** The most apps, and the most websites, the user can exclude: a bound far past any real list, so a
 * list never grows without end (owner, 2026-10-01). One more is refused with the reason. */
export const exclusionsMax = 1_000;
/** The longest bundle identifier and name kept for an excluded app. */
export const bundleIdentifierMaxLength = 255;
export const excludedAppNameMaxLength = 255;
/** The password managers' web vaults excluded from screen reading in every installation, by host;
 * a host covers its subdomains. */
export const builtInExcludedSites: readonly string[] = [
  "1password.com",
  "1password.ca",
  "1password.eu",
  "vault.bitwarden.com",
  "vault.bitwarden.eu",
  "passwords.google.com",
  "lastpass.com",
  "lastpass.eu",
  "app.dashlane.com",
  "pass.proton.me",
  "app.nordpass.com",
];
/** The longest a host name can be (DNS). */
export const hostMaxLength = 253;
/** The longest text taken as a website to exclude: an address pasted whole. */
export const excludedSiteInputMaxLength = 2_000;
/** Where the app picker for an excluded app opens (macOS). */
export const applicationsDirectory = "/Applications";

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

// MARK: Updates

/** Packaged builds look for an update this long after launch, once the helpers and the welcome
 * wizard are up, and then this often (ADR-DESK-041). "Check for Updates…" in the menu looks at once. */
export const updateFirstCheckDelay = 10_000;
export const updateCheckInterval = 4 * 60 * 60 * 1_000;

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
/** The indent of a setting the wizard adds to a VS Code settings file with none to copy: VS
 * Code's own. */
export const vscodeSettingsIndent = 4;
/** Settings: a sidebar of sections (frosted on macOS) beside the chosen section's cards (owner,
 * 2026-09-27: "themed and look professional", not the bland gray; chose the branded sidebar). */
export const settingsWindowSize = { width: 700, height: 500 };
export const settingsSidebarWidth = 200;
export const settingsAppIconSize = 36;
export const settingsSectionIconSize = 16;
/** The window's own color where macOS's frosted material is not drawn (Windows, Linux). */
export const settingsWindowColor = { light: "#f4f3f8", dark: "#1f1e24" };
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
/** In agent mode the pill glows as neon, a sign of the mode (owner, 2026-09-28: "make the sort of the
 * neon glow very apparent for the pills"): a tight bright glow in a wide one. Red-pink rather than the
 * brand's blue and purple, so it stands apart from dictation's pill (owner, 2026-09-29: "right now it's
 * not as apparent"; chosen from eight colors tried). The bubbles keep the plain glow. */
export const agentPillGlowInnerRadius = 4;
/** The glows' colors, red, green and blue (0–255). */
export const agentPillGlowInnerColor: readonly [number, number, number] = [0xff, 0x2d, 0x55];
export const agentPillGlowOuterColor: readonly [number, number, number] = [0xff, 0, 0x6e];
export const agentPillGlowInnerOpacity = 0.9;
export const agentPillGlowOuterRadius = 16;
export const agentPillGlowOuterOpacity = 0.75;
/** The pill grows out of the swirl from this fraction of its size. */
export const pillAppearScale = 0.2;
export const pillSpringResponseSeconds = 0.25;
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
/** Outer bars reach this fraction of the center bar's height. */
export const overlayMeterEdgeBarWeight = 0.45;
/** Traveling ripple across the bars (radians per second, radians per bar, share of height). */
export const waveformRippleSpeed = 9;
export const waveformRipplePhase = 0.7;
export const waveformRippleDepth = 0.25;
/** While transcribing, the pill is a circle with a gradient arc circling its rim. */
export const thinkingRimWidth = 2.5;
export const thinkingArcFraction = 0.7;
export const thinkingRevolutionsPerSecond = 1.2;
export const thinkingTrackOpacity = 0.2;
/** The arc runs from blue to this point on the blue → purple gradient. */
export const thinkingArcEndColor = 0.6;
/** Pill fill: a soft off-white (pure white glared). */
export const pillFillWhite = 0.96;
/** The overlay stays up this long after the dictation ends, for the exit animation. */
export const overlayDismissDuration = Math.round(swirlGatherSeconds * 1000) + 100;
/** Agent mode's bubbles in a row under the pill, one per tool and connector: icon-only circles,
 * slightly smaller than the pill at rest (owner, 2026-09-28), grown to `agentBubbleRunningDiameter`
 * or `agentBubbleHoverDiameter`. */
export const agentBubbleDiameter = 20;
/** Gap between the pill and the bubbles: clear of the pill with one grown about its center. */
export const agentBubbleGap = 10;
/** Gap between neighboring bubbles: wide enough that two running side by side, grown, don't touch. */
export const agentBubbleSpacing = 16;
/** The row shows this many bubbles in full, centered under the pill (`bubbleRow`), and the next
 * `agentBubbleRowFadeCount` fading away to the right: four at most (owner, 2026-09-28: "only show like
 * three or so, and it just fades away to the right"; "we should show 4 entries tops"). */
export const agentBubbleRowVisibleCount = 3;
export const agentBubbleRowFadeCount = 1;
/** A bubble's move along the row as the one that ran moves to its front. */
export const agentBubbleMoveDurationSeconds = 0.35;
/** A bubble under the mouse pointer grows to this size (about its center, as a running one does),
 * and a tooltip says what it is (owner, 2026-09-28: "when mouse hovers over them, make them sort of
 * enlarged and also show tooltips on what this tool is"). */
export const agentBubbleHoverDiameter = 31;
export const agentBubbleHoverScale = agentBubbleHoverDiameter / agentBubbleDiameter;
/** The hovered bubble's tooltip: its name over what it does, at most this wide, `bubbleTooltipGap`
 * clear of the bubble, drawn as the tips are (`tip…`). */
export const bubbleTooltipMaxWidth = 240;
export const bubbleTooltipGap = 6;
export const bubbleTooltipPadding = 8;
export const bubbleTooltipNameFontSize = 13;
export const bubbleTooltipFontSize = 12;
export const bubbleTooltipLineSpacing = 2;
/** An app tool's icon (Thunderbird's) in its bubble. */
export const agentBubbleAppIconSize = 13;
/** A tool's symbol in its bubble. */
export const agentBubbleSymbolSize = 10;

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

/** Space switches to agent mode, and a triple tap shows the paste history: shown as a hold starts
 * listening (owner, 2026-09-30: "press space to enter agent mode or triple tap to see history"),
 * longer than one hint needs, as it has two. */
export const agentAndHistoryTip: TipSettings = {
  lines: ["Press [space] for agent mode,", "triple-tap [hotkey] for history"],
  displayDuration: 4_000,
  maxDisplays: 10,
};
/** A double tap dictates without holding: shown once a hold passes `doubleTapTipHoldDuration`. */
export const doubleTapTip: TipSettings = {
  lines: ["Double-tap [hotkey]", "to dictate", "without holding"],
  displayDuration: 4_000,
  maxDisplays: 5,
};
/** How hands-free listening ends: shown the whole time it listens, every time (owner, 2026-09-27), in
 * two wider lines (owner, 2026-09-30: three "looks so bad"). */
export const handsFreeTip: TipSettings = {
  lines: ["Tap [hotkey] to finish dictating,", "or tap [esc] to cancel"],
  displayDuration: null,
  maxDisplays: null,
};
/** No name set for agent mode: shown as agent mode is switched on, every time until one is set (owner,
 * 2026-09-28: a neutral, inviting nag; unset is fine). */
export const setNameTip: TipSettings = {
  lines: ["Add your name in Settings", "so agent mode knows", "which messages are yours"],
  displayDuration: 4_000,
  maxDisplays: null,
};
/** The longest name the welcome wizard and Settings take for the user. */
export const userNameMaxLength = 100;
/** A hold this long shows the double-tap tip: this user dictates at length, and need not hold. */
export const doubleTapTipHoldDuration = 20_000;

/** The tooltip a tip is drawn in: centered under the listening pill (or over it, `tipGoesAbove`), a
 * few words around keycaps. Dark, as macOS HUDs are, so it reads as the system's hint rather than
 * part of the pill. */
export const tipFontSize = 13;
/** A tip is at most `tipLineCount` centered lines of a few words, each `tipLineHeight` tall; its box is
 * as tall as its lines (`tipBoxHeight`), and the overlay leaves room for the tallest (`tipHeight`). */
export const tipLineCount = 3;
export const tipLineHeight = 18;
export const tipLineSpacing = 1;
export const tipVerticalPadding = 6;
export function tipBoxHeight(lines: number): number {
  return 2 * tipVerticalPadding + lines * tipLineHeight + (lines - 1) * tipLineSpacing;
}
export const tipHeight = tipBoxHeight(tipLineCount);
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
/** Transparent canvas the overlay draws in; the pill sizes itself inside it. The one-line pill sits
 * vertically centered, with room on each side for the listening pill's growth downward, agent mode's
 * row of bubbles (under the pill or over it, `bubblesFitUnder`) and a tip (and its shadow) past it. */
export const overlayCanvasSize = {
  width: 440,
  height: pillHeight + 2 * (listeningPillHeight - pillHeight + agentBubbleGap + agentBubbleDiameter + tipFootprint + tipShadowRadius + tipShadowOffsetY),
};
/** The running tool's icon in the pill, which rests with it, fainter, under the chat window while
 * nothing runs. */
export const agentRunningSymbolSize = 12;
export const agentRestingSymbolOpacity = 0.6;
/** A bubble whose tool is not the one running fades to this opacity. */
export const agentBubbleIdleOpacity = 0.45;
/** The running tool's bubble: a gradient arc circling its border. */
export const agentBubbleRimWidth = 2;
export const agentBubbleRevolutionsPerSecond = 1;
/** The running tool's bubble grows to this size, about its center, on a bouncy spring that overshoots
 * a little ("a genie effect", so the tool in use is obvious). */
export const agentBubbleRunningDiameter = 34;
export const agentBubbleRunningScale = agentBubbleRunningDiameter / agentBubbleDiameter;
export const agentBubbleRunningSpringResponseSeconds = 0.35;
/** CSS's stand-in for that spring: a bouncier overshoot than the pill's. */
export const agentBubbleRunningSpringEasing = "cubic-bezier(0.3, 1.7, 0.5, 1)";
/** How long an error message stays on the overlay. */
export const overlayErrorDisplayDuration = 3_000;

// MARK: Chat window (the Answer tool's replies, over the pill)

/** Left untouched, the chat window closes after this long; a hover, click or scroll, or a follow-up,
 * keeps it open until closed (owner, 2026-09-26). */
export const chatTimeout = 30_000;
/** How long the chat window's question shows before an answer to it counts: a double-click on the
 * last question's Confirm, or a click aimed at its card as the next question replaces it, never
 * answers the next one, which the user has not seen (a double-click's two clicks come within about
 * half a second on macOS by default). */
export const chatConfirmationMinimumDisplay = 500;
/** The chat window's question is declined when left unanswered this long, a bar under it showing the
 * time left, as the chat window's own (owner, 2026-09-28: "Confirmation should get a time limit of 30
 * seconds max, and it should show a timer ticking, similar to the undo toast"). A touch doesn't stop it. */
export const chatConfirmationTimeout = 30_000;
export const chatWidth = 380;
/** The chat grows with its conversation up to this height, then scrolls. */
export const chatMaxHeight = 320;
/** Room around the chat window in the overlay window, for its shadow. */
export const chatShadowMargin = 16;
/** The chat window sits this far over the pill (or under its bubbles, `chatSide`), which stays
 * where it was (owner, 2026-09-28: the answer box "appears smoothly above in a subtle way"). */
export const chatPillGap = 10;
/** The pill, as tall as it gets listening, and its row of bubbles under it: what the chat window
 * leaves room for beside it. */
export const chatStripHeight = listeningPillHeight + agentBubbleGap + agentBubbleDiameter;
/** Room over the pill's side of the window for a hovered bubble's tooltip (`bubbleTooltipCenter`). */
export const chatBubbleTooltipRoom = 80;
/** The chat window appears rising this far, from this scale, fading in. */
export const chatAppearDurationSeconds = 0.25;
export const chatAppearRise = 8;
export const chatAppearScale = 0.98;
export const chatCornerRadius = 14;
export const chatPadding = 12;
export const chatTurnSpacing = 10;
export const chatBubblePadding = 8;
export const chatBubbleCornerRadius = 8;
/** The user's words, in a lightly tinted bubble with a hairline border on the right, as far as this
 * share of the chat's width; the reply in plain text under it, as TabMail's chat in Thunderbird shows
 * them (`chat.css`: `.user-message`, `.agent-message`). */
export const chatRequestMaxWidthFraction = 0.72;
export const chatRequestFillOpacity = 0.1;
export const chatRequestBorderOpacity = 0.3;
export const chatFontSize = 13;
/** Line height, in ems; space between a reply's paragraphs; a list's indent, as Thunderbird's. */
export const chatLineHeight = 1.4;
export const chatParagraphSpacing = 6;
export const chatListIndent = 18;
/** A reply shows one line or list item at a time, this many milliseconds apart, each fading in as it
 * rises this far over `chatRevealFadeDuration` (Thunderbird's `streamDelayMs` and `tm-fade-down`). */
export const chatRevealStepInterval = 100;
export const chatRevealFadeDuration = 180;
export const chatRevealRise = 4;
/** What the chat window says while the answer is worked out and no tool runs, as Thunderbird's. */
export const chatThinkingLabel = "Thinking…";
export const chatCaptionFontSize = 11;
export const chatCloseButtonSize = 18;
/** The spinner beside what a tool the answer's model called is doing, while it runs. */
export const chatActivitySpinnerRevolutionsPerSecond = 1;
export const chatActivitySpinnerLineWidth = 1.5;
/** The timeout bar along the chat's bottom edge, shrinking from right to left as the time runs out
 * (like the iOS app's `PendingSendToast`). */
export const chatTimeoutBarHeight = 2;
export const chatTimeoutBarOpacity = 0.7;
