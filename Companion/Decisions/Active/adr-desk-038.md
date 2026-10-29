## ADR-DESK-038: A dictionary of the user's words, typed or learned from their corrections

**Context:** Owner, 2026-09-29: dictation should learn the user's vocabulary, as other dictation apps
do, with a dictionary the user also edits by hand, in its own Settings section. A live test the same
day showed the speech model spells made-up names right when given them as a word list, and that a
name in Hangul is left in Hangul, so the cleanup pass must see the words too (backend ADR-025). The
consent step is reworded, not re-asked (owner: the app has never been released, so no one has
consented to the old text). Later the same day, the owner: don't rely on the dictionary alone, but
leave half of the backend's 200 words to names and uncommon words picked from the context, "a dynamic
dictionary being constructed on the fly from the captured context", by rules on this computer, not a
model; TabMail on iOS does the same (its ADR-IOS-086).

**Decision:**
- `AppSettings.dictionary`: entries `{word, learned}`, in the order added, kept on this computer, not
  synced. Words are trimmed with their spaces collapsed, and must pass the backend's rules
  (`dictionaryWord`, in the backend's units: UTF-16 code units, JS `trim`, words split on spaces): at
  most `dictionaryWordMaxChars` characters and `dictionaryWordMaxWords` words, no control characters
  or `<` `>`, at most `dictionaryMaxEntries` (100) words, half the backend's 200, so all of them are
  always sent; the same word in another case is one entry, spelled as the user last typed it. A word
  the backend would refuse is never stored, so no dictation fails on one.
- The dictation's key-down snapshot (ADR-DESK-017) carries the words and the learning switch. Every
  transcription sends them as `vocabulary` (none when empty), and dictation's cleanup as `dictionary`,
  one per line. Agent mode's prompts don't take them.
- Screen terms (`contextTerms`): the transcription's `vocabulary` also carries up to
  `contextTermsMax` (100) names and terms from the key-down screen read (window title and rendered
  text), after the dictionary's words, when the read is already done as the recording is sent (it
  never waits for one) and screen reading is on. A term is a word with a capital letter inside it
  ("TabMail", "OKR", "iOS"), or at its start where no sentence starts (a line's start or after `.`
  `!` `?` starts one); a run of them is one term ("Kaelthorne Drake") up to `dictionaryWordMaxWords`
  words, split by punctuation after a word or before one ("Xyvora (Brevalle Labs)", a link's `[`), a longer run (a heading) counting word by word; not an everyday word
  (`correctionCommonWords`), a word under `correctionMinWordLength`, an address (`@`, `://`), or a
  word `dictionaryWord` refuses; none the same as a dictionary word; the most frequent first, then
  the earliest. The cleanup does not get them: it reads the screen itself.
- Settings › Dictionary: a field to add a word, the words with a Remove button each, a learned one
  tagged "Learned" (typing it makes it the user's own), and "Learn from my corrections" (on by
  default) where the field can be read: macOS.
- Learning (`CorrectionWatch`, `learnedCorrections`, our own implementation of the approach of
  OpenWhispr's `correctionLearner` (MIT, https://github.com/OpenWhispr/openwhispr), credited in
  `corrections.ts` and the README; no code copied): after a dictation's paste, with learning on at its key-down, `voice-macos` reads the
  focused field of the app that was in front at key-down (`focusedFieldValue`) every
  `correctionPollInterval` for `correctionWatchDuration`. The first read holding the pasted text is the
  field before any edit; each later change that stays for one interval is compared with it, and the
  words the last one teaches are learned when the watch ends (the next key-down, its duration, or a
  field it can't read), so a pause in the middle of an edit ("tabmail" on the way to "TabMail")
  teaches nothing. A change that respells something new, or has the pasted text back as it was (an
  undo), replaces what an earlier one taught: with what it teaches once it has stayed, with nothing
  before, so a spelling paused on and then changed teaches nothing though the message is sent before
  the change stays. A change that respells nothing (a field emptied by sending the message, another
  field focused, a word half retyped) keeps the correction. The
  changed span (common prefix and suffix) must lie within one copy of the pasted text; the words are
  aligned (longest common subsequence), and a run of changed words is learned when it respells rather
  than replaces: at most half the dictation's words changed, an edit distance within
  `correctionMaxEditShare` of the longer spelling, not another form of a lowercase word (only its end
  changed past `correctionMinStemShare` of its start: "report" → "reports", "send" → "sent"; a
  capitalized name or a script without case is exempt), not an everyday word or one shorter than
  `correctionMinWordLength`, and for a change of case alone, a capital inside a word or a change of
  spacing ("tabmail", "tab mail" → "TabMail"), not one at a word's start. The next key-down stops the
  watch first, so a dictation's own paste is never taken for a correction; an unreadable field ends it.
- The helper never reads a password field (`kAXSecureTextFieldSubrole`) or a field longer than
  `correctionMaxFieldLength`. The field's text stays on the computer and is never logged; the debug
  log sees only the words learned (`log.content`).
- The consent step lists the dictionary's words among what a dictation sends, and says learning reads
  the field on this computer and can be switched off.

**Consequences:**
- A word removed from the dictionary can be learned again from a later correction.
- A lowercase term the speech model gets right at its start but wrong at its end ("kubctl" for
  "kubectl") is not learned; the user adds it by hand.
- Windows and Linux have the dictionary but no learning until their helpers read the field.
- No notice when a word is learned yet: the user sees it in Settings (an overlay "Learned … Undo" is a
  follow-up), and the privacy policy's Voice Data wording is updated separately.
- Every word is sent with every dictation: the list's cap keeps that small.
- The screen terms leave the computer only as words picked from a screen the consent already covers
  sending. The picking is heuristic: a capitalized ordinary word mid-sentence ("Monday") is sent too,
  harmlessly, since the list only biases the speech model; a name only ever at a sentence's start is
  missed. At 200 words of up to 6 each, the list could pass AssemblyAI's 1,000-word total should the
  backend fall back to it (its ADR-025).

**Amendment 2026-10-02 — 150 dictionary words (100 typed at most) and 50 screen terms; a full
dictionary keeps learning, dropping the learned word used least recently.** Owner: at the cap,
auto-learned words should keep updating, the learned word *used* least recently giving way (not the
one learned first), with a count of each word's last use rather than a time; the typed words are listed on top in
Settings. Then: 50 of the 200 words sent kept for the screen's terms, 150 for the dictionary, the
typed words taking precedence up to 100 (refused past that, the user asked to remove one), the learned
words in the rest, all 150 when none is typed ("we should make use of everything"); a learned word
dropped with no notice; both lists shown alphabetically. Before, the dictionary and the screen had
100 each, and a full dictionary refused every new word, typed or learned, so learning stopped for
good, silently, once 100 words were in.
- Measured first (`Scripts/stt-compare/vocabulary_limit.py`, OpenRouter, `microsoft/mai-transcribe-2`,
  a spoken made-up name as the canary): a list of up to 200 terms is taken and 201 refused (HTTP 400);
  200 common English words, or 200 made-up Korean names, still spell the canary right wherever it is
  in the list. Lists of made-up Latin names that sound alike ("Zorvekqua") lost it from 129 terms, or
  from 60 terms of 40 characters, the transcript then exactly the one without a list: a list of
  invented, similar names can blunt itself well below 200, which no budget fixes. Real words and names
  do not, so the budget stays the backend's 200.
- `dictionaryMaxEntries` (150) + `contextTermsMax` (50) = the backend's 200, so every dictionary word
  is still sent. `dictionaryMaxTypedWords` (100) caps the typed words: `addWord` refuses a new word,
  or a learned word typed again (one more typed), at the cap; a typed word typed again takes the
  spelling typed. Settings disables Add with "You can add up to 100 words. Remove one to add
  another."
- Each entry keeps `lastUsed`, a count rather than a time (larger is more recent; a clock set back
  can't reorder it): a word's last use is its adding, its typing or learning again, or a dictation
  whose transcript or cleaned text holds it (`AppSettings.useWords`, called by the controller as the
  transcript comes back, agent mode's request included). A word counts there whatever its case, inside
  a longer word too, since a script without spaces has no word edge to look for; a word counted too
  often only stays longer. An entry stored before `lastUsed` (or with an invalid one) reads as never
  used.
- A new word at `dictionaryMaxEntries`, learned or typed (below the typed cap), takes the place of the
  learned word of the smallest `lastUsed` (the earliest added of a tie), never one learned in the
  same correction nor one the same correction respells again (marked used before any word is added).
  A typed word is never dropped.
- Settings lists the typed words first, then the learned ones, each alphabetically (`localeCompare`);
  the learning switch's note says learned words fill the room the typed ones leave, up to 150, the
  one used least recently making way. The words are sent in the order stored, all of them, as before.

**Consequences (amendment):**
- A learned word can drop out with no notice but the debug log's (`log.content`), as a learned word
  arrives with none.
- The dictionary file is rewritten after a dictation that holds a dictionary word.
- Fewer screen terms (50, was 100): the most frequent on screen are kept.

**Amendment 2026-10-02 (later) — the screen's terms fill what the dictionary leaves.** Owner: "if the
user dictionaries and the learn dictionary is less than the 150, we should definitely send more than
the 50 bound … we send basically as many phrases or words as possible." The fixed `contextTermsMax`
(50) is gone: `vocabularyMaxTerms` (200, the backend's limit) less the dictionary's words at key-down
is how many screen terms `contextTerms` may pick, so a dictation sends up to 200 words whatever the
dictionary holds: all 200 from the screen with no dictionary, at least 50 beside a full one
(`dictionaryMaxEntries` stays 150, all of it always sent, first). *Superseded 2026-10-28 (#309): the
speech model's first 100 are chosen in shares, see the amendment below.*
- Consequence: a screen read with many names sends a longer list than before; the measured 200 real
  words or names did not blunt the speech model, and fewer terms on screen send just those.

**Amendment 2026-10-07 — the words go out most important first.** Owner: the transcriber behind a
language will keep changing and each takes a different number of words, so the backend cuts the list
to what the model takes, keeping the first ones (backend ADR-025 amendment 2026-10-07; AssemblyAI
takes 100). The order sent is now: the typed words, then the learned, each most recently used first
(`prioritizedWords`; the stored order for a tie), then the screen's terms, most frequent first, as
before. This supersedes "the words are sent in the order stored" above; the cleanup's `dictionary`
gets the same order. Settings' list and the stored order are unchanged. *Superseded 2026-10-28
(#309): the order sent is the typed words, the screen's terms, the learned words, then the whole
window's, in shares; see the amendment below.*

**Amendment 2026-10-07 — a terminal's field is the box around its cursor (issue #130).** Learning did
nothing in a terminal on any platform: the field read asks for the focused field's whole text, which in
a terminal is its scrollback (`FocusedField: 52694 code units, over 20000` in iTerm2 on the Mac, then
`no field to read; stopped`), Windows refuses it as no editable field, and Linux reads VTE's whole
buffer. Owner, 2026-10-07: read the box around the cursor. In a terminal (the apps the screen read
reads as a viewport) each helper now reads the viewport as the screen read does and the shared core
cuts out the box around the cursor (`terminal_box`, ADR-DESK-054): the cursor's row and the rows above
and below it between the same borders, up to a horizontal rule (tmux's border between panes one above
the other; the rules above and below Claude Code's input), so other panes and a program's spinner or
status line are not the field. Its rows are joined by the core's own breaks (U+2029), which the core
checks for secrets with and without them, as a rich editor's (ADR-DESK-007, 2026-10-06), withholding
the field where one splits a secret. *(Superseded the same day by ADR-DESK-007's 2026-10-07 amendment: the
rows are lines as the screen shows them, redacted once, and U+2029 marks each row break only after the
redaction; a key the terminal wraps over two rows reaches this field read, which stays on this computer,
in its pieces: accepted by the owner (2026-10-07), since the read never leaves this computer
and so shows nothing the terminal itself does not, and the case is rare, the box being mostly the
line dictated into.)* `CorrectionWatch` finds the pasted text as read, else with those
breaks dropped (a shell wraps a long line inside a word), else with each break and the blanks around
it read as one space (a full-screen program wraps at a word and indents its next row), and reads the
field the same way until the watch ends; a user's own line break is never joined. A box whose other
text changes while the user edits (output in the same pane) teaches nothing that time, as any edit
outside the pasted text; without an exact caret (one iTerm2 draws on another line, after typed
spaces) the read gives none and the watch ends. Each read is a viewport read (about 0.2 s in iTerm2),
every `correctionPollInterval` for `correctionWatchDuration`. The app reads a helper's replies one
per line feed (`HelperClient`'s `onLines`): `node:readline`, which it used before, also ends a line
at U+2028 and U+2029, which JSON leaves unescaped, and cut the box's reply apart (found in the
Windows VM's terminal run); the same held for any screen text holding either character. Such a read
runs in the helper, which also places the caret and pastes, not in voice-screen-reader (ADR-DESK-053),
so it has a field read's time limit: 1 s on Windows (`terminalFieldReadMs`, under the 2.5 s
watchdog), 1.5 s on Linux (`fieldReadMilliseconds`); out of time, there is no field. (Later the same
day the field read moved to `voice-field-reader`, a program of its own, on every platform; the
limits stand, and the Windows watchdog no longer applies to it: ADR-DESK-053, amended 2026-10-07.) A shell rewraps
its line after an edit that changes a word's length, so rows joined the way the pasted text was found
can run two words together or split one in a later read: while the field has rows, only a word read
whole on one of them is learned (a corrected word the terminal split across rows is not).

**Amendment 2026-10-25 (owner): terms from the whole window fill the room left.** The owner: *"for
dictation, first create keywords from shown screen content and add more from off screen if needed"*,
and *"for off screen keywords, i meant if there is room"*. The screen's terms (`contextTerms`) come
from what the window shows first, as before, in the room the dictionary leaves of
`vocabularyMaxTerms`; then the whole window's (ADR-DESK-016's second read, 2026-10-25), none the same
word as the dictionary's or the shown ones, in the room still left, only if that read is done by the
upload. It is never waited for, so a long page never holds up a dictation. *Amended 2026-10-28
(#309): the whole window's terms take the room left in the first 100, and with the cleanup follow
the rest; see below.*

**Amendment 2026-10-28 (#309, owner): the 100 most important words first; the rest only for the
cleanup.** The backend gives a speech model only the first terms it takes (AssemblyAI 100, Whisper
about 200 bytes, some 20 terms; its ADR-025) and the cleanup every term. Sending the whole dictionary
first, up to 150, left a full dictionary no room for the screen's terms within what the model reads.
`dictationVocabulary` (`dictionary/vocabulary.ts`) now chooses the first `vocabularyModelMaxTerms`
(100) in shares:
- the screen's terms (what the window shows) keep up to `vocabularyScreenShare` (30);
- of the dictionary's room, the typed words take at most `vocabularyTypedShare` (50) and the learned
  words the rest;
- a share a group can't fill passes on: no learned words lets the typed take the dictionary's whole
  room, no screen terms gives the dictionary all 100, a small dictionary leaves the screen and then
  the whole window all the room left.
In order: the typed words, the screen's terms, the learned words, the whole window's terms. When the
dictionary holds more than its share, the words used most recently go (the order the app keeps, most
recently used first; Settings' order and the stored order are unchanged). For example, 100 typed, 50
learned and 80 screen terms send 50 typed, 30 screen and 20 learned; 100 typed, no learned and 80
screen terms send 70 typed and 30 screen.

Owner, the same day: only the speech model is limited to 100, not the cleanup. *Amended 2026-10-29
(#310), below: the dictionary's words past the first 100 now go only in the cleanup's own dictionary,
and the screen's terms run to 500.* With the cleanup (Smart
Dictation on, in dictation mode or for a long dictation's chunks, whatever mode it ends in), the words that didn't fit follow the first 100, up to
`vocabularyMaxTerms` (200, the backend's limit): the rest of the dictionary (typed, then learned, each
most recently used first), the rest of the screen's terms, the rest of the whole window's. Without it
(Smart Dictation off, an agent request, a spoken answer) only the first 100 go. The cleanup's `dictionary`
still holds every typed and learned word. No term goes twice, whatever its case. The screen's terms
leave out every dictionary word, so the shares are computed once: an on-screen dictionary word past
its share reaches the cleanup in its dictionary, not the speech model as a screen term. The cleanup
setting is read from the dictation's settings snapshot taken at key-down.
- Tests: `dictionary/vocabulary.test.ts` (50/30/20, 70/30, no screen, room passed on, the cleanup's
  first 100 equal to the list without it, then the rest up to 200, no term twice), `dictation/
  controller.test.ts` ("dictation with the cleanup / without the cleanup / agent mode sends the most
  important terms first", the whole window's terms, the spoken answer's first 100), `settings.test.ts`
  (typed and learned apart, each most recently used first).

**Amendment 2026-10-29 — a far larger learned dictionary, and more for the cleanup (owner, #310).** The
cleanup can take far more than the speech model's 100 terms. Measured 2026-10-28: the cleanup gets
slower and fixes fewer words as its lists grow (several seconds per cleanup past 2,000 dictionary
words), so each list stops at 500. The backend raised its limits first (`vocabulary.maxTerms` 1,000,
`cleanup.maxFieldChars` 30,000, live in production 2026-10-29); the app never sends more than it takes.
- **Storage:** `dictionaryMaxEntries` 150 → 5,000. Typed words keep their cap (100); learned words fill
  the rest, and a full dictionary still drops the learned word used least recently. Reading the stored
  list looks each word up once in a set of those kept (`storedDictionary`), one pass however long: a
  pairwise comparison took about 400 ms at 5,000 words, read several times a dictation.
- **The cleanup's dictionary** (`cleanupDictionary`): at most `cleanupDictionaryMaxWords` (500) of the
  user's words, typed first, then learned, each most recently used first. Every typed word fits (at
  most 100), and so does every dictionary word in the first 100. The screen's terms now leave out only
  these words, not the whole dictionary: an on-screen word among them reaches the cleanup in its
  dictionary, and one past them (a learned word long unused) is sent as a screen term like any other,
  so it reaches the cleanup in one list or the other. The backend's `cleanupScreenTerms` (the
  vocabulary less the cleanup's dictionary) stays the screen's terms alone.
- **The vocabulary:** the first 100 chosen as #309 does (with more than 500 dictionary words, a
  long-unused learned word on screen is a screen term there, as below). With the cleanup, the rest of the
  screen's terms follow, then the rest of the whole window's, up to `cleanupScreenMaxTerms` (500) of
  theirs in all, those in the first 100 counted (the owner's "at most 500 screen and whole-window
  terms"). The dictionary's words past the first 100 are not sent there any more: they reach the
  cleanup in its own dictionary. Without the cleanup, only the first 100, as before.
- **`contextTerms`** returns every term on screen, most frequent first, and no longer takes a `max`:
  `dictationVocabulary` drops the cleanup's dictionary words and takes as many as it has room for, so
  the user's words on screen, however many and however often shown, take none of the screen terms'
  room.
- **Settings › Dictionary** shows how many words the user added and how many were learned, and a
  field that shows only the words containing what is typed in it, whatever the case, so a word can be
  found and removed in a list of thousands. The learning switch's note says up to 5,000 words, and the
  dictionary's caption that the ones used most are sent with each dictation.
- Device Sync does not carry the dictionary, so the larger cap changes nothing there.
- Tests: `dictionary/vocabulary.test.ts` (the cleanup's first 100 equal to the list without it, then
  the screen's rest up to 500, the whole window's terms in the first 100 counted, no dictionary words
  past the first 100, a word past the cleanup's 500 on screen sent as a screen term, the cleanup's
  dictionary and the numbers within the backend's limits), `dictation/controller.test.ts` (the
  cleanup's dictionary of 500, typed first;
  500 screen terms with no dictionary; the user's words on screen taking none of the screen terms'
  room), `dictionary/contextTerms.test.ts` (every term, however many), `settings.test.ts` (5,000 words,
  a full dictionary read in one pass within a loose time bound), `renderer/settings/index.test.ts`
  (counts and the filter).
