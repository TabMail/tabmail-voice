## ADR-DESK-008: Clean up every transcript with the screen context, on the backend

**Context:** Owner, 2026-09-25: after transcription, a language-model pass should fix dictation
errors using what is on screen, with the smallest possible changes. The instructions and the
model choice live on the backend, so they can be edited and switched there without an app release.

**Decision:** The screen context (ADR-DESK-007) is captured at key-down in every build. When the
transcript arrives, the app waits up to `contextWait` (0.5 s) for that capture and sends the transcript with the app name,
web host, terminal program, window title and the visible text (caret marked) to the backend's
`POST /completions/chat` as the prompt `system_prompt_dictate_cleanup`, then pastes the reply.
*(Amended 2026-09-26, owner: the cleanup also removes filler words and accidentally repeated
words and corrects grammar, still changing nothing else. It is a backend prompt change, edited in
place in `v0.1.0` because the app's version line is `0.1.0`; no app change.)*
Request shape and server-sent-events parsing follow iOS `BackendClient`, with two deliberate
differences: the app fails the cleanup on an `event: error` (iOS logs it and waits for `final`),
and it accepts only HTTP 200 (iOS accepts any 2xx). The backend never sends both `error` and
`final`, and answers 200, so neither changes an outcome today.

**Consequences:**
- What is on screen while dictating is sent to the TabMail backend with each dictation; like every
  TabMail AI request it is not retained (root ADR-004), and the app logs sizes only. *(Amended by
  ADR-DESK-015, 2026-09-26: debug builds log the text in full to the local debug log file.)*
- Every dictation gains one model round trip; its duration is logged (debug) for tuning. Owner,
  2026-09-25: the cleanup is capped at `cleanupTimeout` (3 s; the owner asked for 2–3 s); past it
  the request is canceled and the transcript is pasted as heard, like any other failed cleanup.
- ~~A failed or empty cleanup fails the dictation with an error; the raw transcript is not pasted
  instead (no fallback without an owner decision).~~ Owner, 2026-09-25: when the cleanup fails
  for any reason (error, refusal, empty reply, offline, signed out), the transcript is pasted as
  heard. A failed cleanup never costs the user the dictation; the failure is logged (type only).
- The app sends its own version (`0.x`) as `X-Client-Version`; a backend prompt it uses must be
  versioned to resolve at that version.
- A dictation's transcription and cleanup go under the account signed in when its upload starts.
  If the user signs out and into another account meanwhile, the cleanup is skipped and the
  transcript pasted as heard (`DictationController.withFreshToken` refuses a token for another
  account).
- ~~The cleanup waits for the capture, so the capture must finish.~~ Owner, 2026-09-25: the
  capture runs in parallel and is best effort. If it is not done within `contextWait` of the
  transcript arriving, the cleanup runs without it and the capture is forgotten (an Accessibility
  read of an unresponsive app can take seconds). Each helper command (tmux, ps) still gets
  `contextCommandTimeout` and is stopped after it, so an abandoned capture does not leave a
  process behind: a stopped tmux server keeps its client's output open, so waiting for the end of
  the output alone could hang.
- Owner, 2026-09-25: screen reading is switchable (ADR-DESK-010). With it off, nothing is read
  and the cleanup runs without screen context.
- The screen text is untrusted input to the model: text on screen, such as terminal output someone
  else wrote, can steer the reply that gets pasted (prompt injection into the paste), including a
  reply with a line break that a terminal without bracketed paste would run as a command. Owner,
  2026-09-25: not a risk for dictation; no guard. The reply is only trimmed of surrounding blank
  space before it is pasted.

**Amendment 2026-09-28 — only the text around the caret, and a 1.5 s cap.** Owner: the cleanup
"doesn't really need to be that heavy"; "8K characters is useless ... only a brief capture text
should go for the cleanup. The full screen content should only be available for the agent". Measured
over 133 dictations in a debug log: release to paste took a median 1.7 s, of which the cleanup's round
trip was a median 0.75 s (0.97 s with more than 8k characters of screen text), and one timed out at
3 s with about 4k characters. The cleanup now gets, as `screen_text`, only the rendered screen within
`cleanupContextBefore` (500) code units before the caret and `cleanupContextAfter` (200) after it,
cut between characters, markers as rendered (`textAroundCaret`). The caret is the marker on the
focused field's `» ` lines; with no field holding the caret, the cleanup gets no screen text. Agent
mode's tools still get the whole screen. `cleanupTimeout` is 1.5 s (was 3 s); past it the transcript
is pasted as heard, as before. The backend prompt's wording ("the window's visible text") is
unchanged; the excerpt keeps its markers.

**Amendment 2026-09-29 — the cleanup runs in the transcription request.** Owner: the cleanup
"is always done", so the app sends "all the cleanup related information" with the recording and the
backend "calls the transcriber and the cleanup all together on one go"; the cleanup deadline stays and
"it should be the backend that enforces it". A dictation now makes one request,
`POST /dictation/transcribe` with a `cleanup` block (`DictationCleanup.variables`: app name, web host,
terminal program, window title, the text around the caret and the dictionary, one word per line), and
gets `{ text, cleaned_text }` back (backend ADR-027). The second authorization, quota and throttle pass
the cleanup's own request paid, and its round trip, are gone. The app pastes `cleaned_text`, or the
transcript as heard when it is empty (the backend's cleanup failed, was refused or ran past its 1.5 s
deadline) or absent (a backend from before this change) (`DictationCleanup.pasted`). The app's own
`cleanupTimeout` is gone; the request's `transcriptionRequestTimeout` covers both. Consequences:
- The screen read must be done by the upload, since its text goes with the recording: the upload
  waits up to `contextWait` for it (it was the transcript's arrival). The read starts at key-down, so
  it is usually done; one that is not goes out empty, as before. The recording's screen terms
  (ADR-DESK-038) see a read done in that wait too.
- Transcription and cleanup share one token: an account switch during the request sends nothing
  under the other account and pastes that request's cleanup (both ran under the account signed in at
  the upload, as this ADR required).
- Agent mode's transcription sends no `cleanup` and is unchanged.
- Every field is cut to the backend's per-field limit (`config.cleanupFieldMaxLength`, 20,000 UTF-16
  code units, its `cleanup.maxFieldChars`), its start kept, between characters. Over the limit the
  backend refuses the whole request, the transcription included, and a window title is whatever the
  app or web page sets. The cut bounds the cleanup model's input only.

**Amendment 2026-09-28 (later) — never no screen for want of the marker; no selection.** Owner: "we
should not have empty screen just because we can't find the correct character"; "if we are able to
find the line where the character is ... including that line in the context"; and "when simply
dictating i think that selected text should not even go through". In the owner's debug log the helper
placed no marker in almost every terminal capture without tmux (the terminal's lines are kept as a plain
field) and in about half the captures of one chat app (the walk hit its time budget before the field). `placeCaret` now puts one caret
marker in the screen text, in order: the helper's marker on the `» ` lines; else on the caret's line as
the helper read it around the caret (`textBeforeCaret` to its last line break, the selection as the
screen still shows it, `textAfterCaret` to its first line break, trailing blanks dropped), found as
whole `> ` field lines, the last such on screen, the selection then cut from the screen (a terminal
without tmux renders its lines so; the caret's text inside a word, a longer line or a page line is not
its line); else after the screen, the helper's text
around the caret rendered as a focused field (`» ` lines). The excerpt is then cut around that marker as
before; the screen text is empty only without a screen read. A selection is left out wherever the caret
is placed: the dictation replaces it, so the cleanup gets the caret alone, and the reach before and after
counts no selected text. A caret line that is also another whole field line lower on screen places
the marker there; the owner asked for the line search.

**Amendment 2026-10-05 — Smart dictation, a setting, off by default (owner).** The cleanup costs about
a second per dictation (0.4–1.8 s measured on 2026-10-05). Owner: "default off, but an option to have
that cleanup on"; in Settings › Dictation, a switch noting it delays each dictation by a second or more.
`smartDictation` (stored, default false) is part of the dictation's settings snapshot taken at key-down.
Off, the recording carries no `cleanup`, so the backend runs none, the screen read is not waited for,
the transcript is pasted as heard, and a long dictation is not polished (ADR-DESK-049). On, everything is
as before. Released builds keep sending the cleanup; the backend has it switched off (backend ADR-027
amendment, 2026-10-05) until clients with this switch ship, then turns it back on. As the iOS app's
Smart Dictation (ADR-IOS-085 amendment).

**Amendment 2026-10-05 — a space after a delimiter.** Owner: dictating with the caret right after a
delimiter ("Note:") pasted the text flush against it. The pasted text is still trimmed, so the space
is the app's to add: when the focused field's text before the caret, as read at key-down, ends with
`,` `;` `:` `.` `…` `!` or `?`, or a closing bracket or quote, and the text starts with a letter, a digit, a currency sign or an opening
bracket, `¿` `¡`, or quotes followed by one of those (a quote at the dictation's start, too, is told by
what is next to it, not how it is drawn: `”Hej”` and `»Hallo«` open, `" and left` closes), and neither the last letter before the caret
nor the dictation's first is in a script written without spaces (as where a long dictation's chunks
meet: a bracket, a quote or a digit belongs to no script), the
dictation is pasted with one space ahead (`spacedFromCaret`). Only the paste gets it (and so the
clipboard the paste leaves behind): the paste history, the clipboard when the user switched apps, and
agent mode's text are as written. Owner: after an opening quote "we want no space because we're going
to be saying something inside the quote", after a closed one we do; a straight `"` or `'` is told
apart by what is before it (a run of them, `'no'"`, by what is before the run): after a space, a
line's start or an opening bracket it opens (no space), after anything else it closes (a space), so an apostrophe (`students'`) reads as closing too, and a
caret inside a word after one (`don'│t`) is not dictated at (owner: "very unlikely"). The read is
the helper's, secrets already taken out: a secret right before the caret reads as its placeholder,
which ends in `]`, and is spaced from. Owner: curly quotes follow the same rule, whichever way they
are drawn ("isn't it all just working fine if somebody just mistakenly does it the other way?"), so
German `„Hallo“│` is spaced and `sagte „│` is not; brackets go by their shape (`foo(│` is not spaced).
No field read (screen reading off, an excluded app or
site, a read not done by the paste, a terminal read as a viewport) adds no space; nothing is read
again at the paste, which would cost it time.

**Amendment 2026-10-06 — a space before a word after the caret.** Owner: a dictation dropped in
front of existing text ("Done." with the caret before "Next") should be spaced from it too. The same
rule, mirrored: when the dictation ends with a delimiter or a closing bracket or quote and the
field's text after the caret, as read at key-down, starts with a letter, a digit, a currency sign,
an opening bracket, `¿` `¡` or opening quotes, and neither side is in a script written without
spaces, one space is pasted after it (`spacedFromCaret`, both sides at once). Nothing is added
after a dictation that ends with a word (a caret inside a word is the user's to space), before a
space, a line break, punctuation or the field's end. As before the caret, a secret right after it
reads as its placeholder, which starts with `[`, and is spaced from. Only the paste gets it.
Chromium rich-text fields read the caret's line ends right since the restored paragraph breaks
(ADR-DESK-007 amendment, 2026-10-06), so a caret at the end of a line is followed by its break,
not the next paragraph's first word, and gets no trailing space.

**Amendment 2026-10-07 — a terminal is spaced from its cursor's row (issue #162).** A terminal is read
as its viewport, and its caret window was left empty, so no dictation there was spaced ("a terminal
read as a viewport adds no space" above). Its cursor is placed exactly in the viewport, though, so the
shared core (`terminal_box`, ADR-DESK-054) now gives the caret window the cursor's row: the text before
and after the cursor, between the nearest borders on each side of it (box-drawing characters: tmux's
pane borders, the sides a full-screen program draws around its input), so a pane beside the cursor's
never reaches it. Owner, 2026-10-07: the rule is the fields' rule, unchanged (a space after a delimiter
or a closing mark, before a word after a closing one), not a space after any character. The row is cut
from the viewport's text after it was redacted, so nothing is put into text the redactor sees. Without
an exact caret (a caret iTerm2 draws on another line than its offset's, VTE's at a text's ends), or
while text is selected (a terminal's selection is not at its cursor), the window stays empty and no
space is added, as before. The cut was by character column at first, so a row holding a double-width
character had its borders a column early and ended the box. Owner, 2026-10-07: fix that. The cut is now
by the column on screen, each character (a grapheme) as wide as Unicode says (`unicode-width`: two for
CJK and emoji), and the cursor's column is taken from the same graphemes, so a ligature Unicode
gives one width for two graphemes (Arabic lam-alef), which a terminal draws in two columns, moves
neither. A terminal set to draw a character otherwise (iTerm2's ambiguous-width letters, some emoji
sequences) still has that row's borders a column off: a row whose borders are not at the cursor's
border columns ends the box.


**Amendment 2026-10-26 — agent writing uses the same paste spacing.** Compose and Edit pass
their captured screen context to the controller's shared paste function, just as dictation does.
The existing `spacedFromCaret` rule applies on both sides of their output too; Edit still preserves
the selection's boundary whitespace, so existing blanks and line breaks are not doubled. History
and text copied from an unpasted note remain as written. No additional screen read is made.
