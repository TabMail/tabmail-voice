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
and the screen's terms run to 500; those in the first 100 are counted apart since a later 2026-10-29
amendment, below.* With the cleanup (Smart
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
words), so each list stops at 500 (*the screen's terms at 500 past the first 100 since 2026-10-29
(owner), see below*). The backend raised its limits first (`vocabulary.maxTerms` 1,000,
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
  terms"). *Superseded 2026-10-29 (owner): those in the first 100 are not counted, see below.* The dictionary's words past the first 100 are not sent there any more: they reach the
  cleanup in its own dictionary. Without the cleanup, only the first 100, as before.
- **`contextTerms`** returns every term on screen, most frequent first, and no longer takes a `max`:
  `dictationVocabulary` drops the cleanup's dictionary words and takes as many as it has room for, so
  the user's words on screen, however many and however often shown, take none of the screen terms'
  room.
- **Settings › Dictionary** shows how many words the user added and how many were learned, and a
  field that shows only the words containing what is typed in it, whatever the case, so a word can be
  found and removed in a list of thousands. The learning switch's note says up to 5,000 words, and the
  dictionary's caption that the ones used most are sent with each dictation. *Superseded 2026-10-29
  (owner): the caption makes no claim about which words go, see below.*
- Device Sync does not carry the dictionary, so the larger cap changes nothing there.
- Tests: `dictionary/vocabulary.test.ts` (the cleanup's first 100 equal to the list without it, then
  the screen's rest up to 500, the whole window's terms in the first 100 counted, no dictionary words
  past the first 100, a word past the cleanup's 500 on screen sent as a screen term, the cleanup's
  dictionary and the numbers within the backend's limits), `dictation/controller.test.ts` (the
  cleanup's dictionary of 500, typed first;
  500 screen terms with no dictionary; the user's words on screen taking none of the screen terms'
  room), `dictionary/contextTerms.test.ts` (every term, however many), `settings.test.ts` (5,000 words,
  a full dictionary read in one pass within a loose time bound), `renderer/settings/index.test.ts`
  (counts and the filter). *The counting tests are superseded 2026-10-29 (owner): the screen terms in the
  first 100 are not counted, see the amendment below.*

**Amendment 2026-10-29 (owner): the dictionary's caption makes no claim about which words go.**
Settings › Dictionary's caption reads "Names and terms spelled your way, kept on this computer.
They’re sent adaptively with each dictation so they come out right, and TabMail doesn’t keep them."
Test: `renderer/settings/index.test.ts` › the notes are the Swift app's.

**Amendment 2026-10-29 (owner): the cleanup's screen terms are counted apart from the first 100.**
With the cleanup, up to `cleanupScreenMaxTerms` (500) more of the screen's and the whole window's
terms follow the first 100; those already among the first 100 (up to `vocabularyScreenShare`, 30, or
more where the dictionary leaves room) no longer count toward the 500. The owner: counting separately
"creates a simpler logic and would not be a big deal". At most 600 terms go, within the backend's
`vocabulary.maxTerms` of 1,000. Tests: `dictionary/vocabulary.test.ts` › the cleanup gets the rest of
the screen after the same first 100, up to 500 more screen terms; the whole window's terms in the
first 100 don't count toward the 500; `dictation/controller.test.ts` › with no dictionary sends as many
screen terms as there is room for; dictionary words on screen take none of the screen terms' room.

**Amendment 2026-11-04 (owner, #333): screen terms are picked by the system's spelling dictionaries
of the user's languages, not by sentence positions.** The owner's dictation log showed the rule's blind
spot: a chat app's author line starts with the author's full name ("Xyvora Brevalle  [Today at 4:12
PM]"), which the rule took for a sentence's first word and dropped, so only the surname went; the speech
model then guessed the first name, and the wrong spelling, pasted back into the chat, came back from the
screen as a term on the next dictation, both spellings now competing. The owner: use a real dictionary,
not one of our own; ready for every language; skip Chinese and Japanese for now and split on spaces; keep
the capital-letter test for now; "it's okay to be imperfect". A first cut shipped permissively licensed
Hunspell dictionaries (18 languages, about 14 MB compressed, none for German, Italian or Czech, whose
dictionaries are GPL); the owner then chose the system's own dictionaries instead: macOS, Windows and
Ubuntu/GNOME all have them, for the languages the user has, and nothing ships.
- **The rule.** A word may be a term (`termCandidates`) when it has a capital letter anywhere (a
  titlecase letter counts), or is in a script without case (Hangul, Arabic: no letter changes case);
  never when it holds a digit or is part of an address. It is a term when no dictionary of the user's
  languages knows its lowercase form, so "Today" starting a sentence is not one, a name the dictionary
  keeps capitalized ("Paris") is, and so is one it lacks ("Xyvora"), wherever it stands. Runs of cased
  terms join as before, up to `dictionaryWordMaxWords`; a caseless word stands alone, since its script
  marks no name. The sentence-start rule and `correctionCommonWords` leave the term picker (the
  corrections keep the list); `correctionMinWordLength` and `dictionaryWord` still apply, so a
  two-syllable Hangul word is no term.
- **The check.** The app asks the main helper (`knownWords`, `NativeWordChecker`) once per dictation
  for the words of both reads, in lowercase, with the system's preferred languages
  (`app.getPreferredSystemLanguages()`, read at each ask), for at most `knownWordsTimeout` (500 ms); one
  that fails or doesn't answer in time sends no screen terms, as a screen read not done in time does. The
  helper answers `{"known":[word…],"unavailable":[tag…]}` with the system's dictionaries: the macOS spell
  checker (`NSSpellChecker`, asked from its own actor, off the main thread), the Windows one
  (`ISpellCheckerFactory`, on the request thread, each language's checker kept), and on Linux the
  installed Hunspell files (`/usr/share/hunspell`, then the older myspell folders; `HelperConfig`). Which
  of a system's dictionaries serves a language is the shared core's (`words::dictionaries`,
  `voice_core_dictionaries_json`; ADR-DESK-054): its language and region, else its language alone, else
  the first of its language by name; a POSIX locale's encoding and a script subtag are ignored. On Linux
  the whole answer is the core's (`words::known`, `voice_core_known_words_json`): files read in the
  encoding their `.aff` names (`encoding_rs`; Ubuntu's Greek is ISO 8859-7, Polish ISO 8859-2,
  Brazilian Portuguese names none, so ISO 8859-1), parsed with `spellbook` (MPL-2.0; its dependencies
  `hashbrown` and `foldhash`, MIT/Apache and Zlib), each loaded once per process. The app has the helper
  ready them as it starts (`warmUp`).
- **Measured** (2026-11-04): the macOS checker takes about 0.1 ms a word per language (a few hundred
  candidates, tens of ms); Ubuntu 26.04 installs English (five regions) and French, and a language's
  `hunspell-<lang>` when the user adds it; 18 of 19 Ubuntu dictionaries tried load in 1 to 122 ms each
  (Turkish fails to parse in `spellbook` 0.4.2), a check then about a microsecond. Finding the nearest
  real word to tell a typo from a name was tried and dropped: about 55 ms a word, and as many names as
  typos lie within one or two edits of a real word ("Kwan", "Zen").
- Tests: `dictionary/known-words-cases.json` (Rust: the choice rule, and the Linux answer against
  made-up Hunspell files in `dictionary/hunspell/`, one with an affix rule, one ISO 8859-7, one naming
  no encoding, two named by Hunspell's Windows-Cyrillic and Thai aliases, one an unknown encoding), the
  core's folder-order and refusal tests, `dictionary/contextTerms.test.ts`,
  `dictation/controller.test.ts` (a name starting a line goes whole, asked once; a failed or late answer
  sends no screen terms; a window read landing during the ask adds no word it didn't judge; a long
  dictation canceled while its first chunk waits sends no chunk), `main/native/wordChecker.test.ts`
  (lowercase forms asked once and mapped back, reply validation, warm-up), `main/index.test.ts` (the
  controller wired to the main helper with the languages preferred at each ask, and the launch warm-up,
  on each platform), and the helpers' `knownWords` wire tests against the real system dictionaries
  (macOS `MacServiceRequestTests`, with two languages' dictionaries asked; Windows
  `system-protocol.mjs`, Linux `foreground-lifecycle.py`).

**Consequences (amendment):**
- A name that is also an everyday word ("Will", "Grace") is not biased, and a capitalized typo is.
  Owner: those need no biasing, and imperfect is fine.
- Each system judges words its own way: the macOS checker knows capitalized names from the user's
  contacts (the lowercase ask keeps them terms), Ubuntu's Ukrainian dictionary accepts every word in
  Latin letters by design, and a Linux language without its `hunspell-<lang>` installed (or one
  `spellbook` can't parse) has no dictionary: its capitalized words all count as terms, and a screen in a
  caseless script sends many of its words, the most frequent first. The helper's reply names the
  user's languages no dictionary serves (`unavailable`; a tag naming no language, as the POSIX "C",
  is not one), so the menu can tell the user how to install one from the system (#334).
- Nothing ships; the helper keeps what it loaded (Linux) or the checkers it made (Windows) for its life.
- TabMail on iOS still picks by the sentence-start rule (TabMail/tabmail-ios#383).

### Amendment 2026-11-04 (#334): the menu names a language without a spelling dictionary

**Decision:** each `knownWords` answer (the launch warm-up, then every dictation) tells the app the
user's preferred languages no system dictionary serves (`NativeWordChecker`'s third argument; the
launch warm-up runs once the main helper has started, which refuses a request before), and
the tray menu names them (`missingDictionaries` in `core/ui/missingDictionaries.ts`, `MenuState.missingDictionaries`):

- each language once, by its language alone in English ("Korean"): the helper reports a tag only
  when no dictionary of its language is there at all, so a region would mislead;
- never a language written without spaces (Chinese, Japanese, Thai, Lao, Khmer, Burmese): screen
  terms are split at spaces, so no spelling dictionary would tell their words apart, and Chinese and
  Japanese are left for now (owner);
- Windows and Linux, where one can be installed: the icon carries the attention mark (tooltip "TabMail
  Voice needs a spelling dictionary", after a file problem and a missing permission) and an "Install a
  Spelling Dictionary for Korean…" item per language opens the steps, as the menu's Fix items do:
  Windows, Settings > Time & language > Language & region; Ubuntu, Settings > System > Region &
  Language > Manage Installed
  Languages, or the `hunspell-<language>` package (`apt search`). The item goes at the next answer
  that no longer names the language;
- macOS, whose spell checker covers the languages it has and takes none added: a dimmed "No macOS
  spelling dictionary for …" line, no mark (on this Mac it has 45 languages, Korean among them; of the
  common ones it lacks mostly those written without spaces).

The menu was chosen over Settings because it is where the app already sends the user to fix
something (the file problems' Fix items). A failed or out-of-shape answer leaves the menu as it was.
The dialog has only Close: a button opening Windows' language settings was dropped in review, as the
steps already name the page (deletion over a launch path and its failure handling).

**Consequences:** the warning follows the system's languages, not what is on screen: a user who
prefers a language without a dictionary sees it even if they never read that language. Awaiting the
owner's blessing: the macOS line without the mark, and the languages never warned.

### Amendment 2026-11-05 (owner, #348): a dictionary that knows a made-up word serves no language; with none, terms by capitals

**Context:** each system judges words its own way, and one may know any word: Ubuntu's Ukrainian
dictionary takes every word in Latin letters (#344; the same shape as a dictionary of single letters
that compound), so with Ukrainian preferred no Latin-script name was ever a term. The macOS spell
checker does the same for many languages: on macOS 27.2, measured 2026-11-05, those of Arabic,
Bulgarian, Czech, Greek, Hebrew, Hindi, Hungarian, Indonesian, Lithuanian, Slovenian, Ukrainian and
others took every word, a made-up one too, while none of 45 LibreOffice dictionaries knew the made-up
word. And with no
dictionary at all for the user's languages, every capitalized word and every word in a script without
case counted as a term. Owner, as for TabMail on iOS: a dictionary counts as working only if it flags
a made-up word; with no working dictionary, use the rule from before #333.

**Decision:**
- **A word in no language.** The shared core names one (`words::MADE_UP`, in the `dictionaries` reply
  as `madeUp`). A dictionary that knows it is left out and the choice made again without it, so its
  language's next dictionary serves if there is one, else the language is `unavailable`, as one with
  no dictionary is (the menu names it, #334). On Linux the core does it all (`words::known`; a file
  that can't be read now gives way to its language's next too); the macOS and Windows helpers ask
  their spell checker about `madeUp` for each dictionary chosen and ask the core again without those
  that know it (`SpellCheck.known`; Windows `workingDictionaries`); each pass leaves one more out, so
  it ends.
- **How many answered.** Every helper's `knownWords` reply carries `dictionaries`, the number of
  dictionaries that answered; `NativeWordChecker.known` answers null when it is 0. A dictation asks
  whenever the screen was read, with no word to judge too: whether a dictionary works decides which
  words may be terms at all (a name with a digit is never asked about, and is one by capitals).
- **No dictionary: the rule from before #333.** `contextTerms(text, null)`: a word with a capital
  inside it, or at its start where no sentence starts (a line's start, or after `.` `!` `?`), not an
  everyday word (`correctionCommonWords`), no address; runs, punctuation, frequency and the backend's
  word rules as with the dictionaries. A word in a script without case is no term then.
- The menu's warning stays.

**Consequences:** a user whose only language has a dictionary that knows every word is told to
install one, though one is installed: its steps name the system's dictionaries, and the user may
add another language's. The made-up word is in Latin letters: a dictionary taking every word of
another script is not caught. A name starting a line is missed again where no dictionary works.



### Amendment 2026-11-05 (owner): screen terms by word frequency, from one word list the app ships

**Context:** the system spell checkers judged screen words three different ways and badly: on macOS
27.2 the "en" checker took every non-Latin word, made-up ones too, and "de" took "schule"; Ubuntu's
Ukrainian took every Latin word; Linux needed a package per language, hence the menu (#334) and the
made-up-word probe (#348). A spell checker also says only whether a word exists, not how rare it is,
which is what decides whether the speech model needs help: the speech-recognition literature calls a
word rare when it is outside the ~5,000 most frequent, and in our own bench (20 terms, two paid speech
models, no word list) every term the models misspelled had its rarest word absent from a frequency
list or seen at Zipf 3.1 or less. The owner chose word lists: "44 languages, frequent words is probably
okay", shipped whole ("costs nothing"), and then a simple rule: "keep things simple and stupid. Don't
try to be perfect [...] this is just word biasing", "just have it check against all 44 languages we
have and then just send what is not there". A first design (each word judged by the lists of the
user's preferred languages, runs of names kept together and trimmed, rarity tiers) was dropped for
this one before it merged.

**Decision:**
- **The word list.** `native/shared/dictionary/words.txt`: 42 language lists merged into one, each
  word with the most often any of them sees it, as Zipf in tenths. The lists are wordfreq 3.1.1's data
  (CC BY-SA 4.0), serving 44 language tags (Bosnian, Croatian and Serbian share Serbo-Croatian's), and
  FrequencyWords' OpenSubtitles 2018 counts for Korean (wordfreq splits Korean into morphemes; Korean
  is written with its particles attached). Each list keeps the words it sees at Zipf 2.5 or more (20 of
  wordfreq's lists, its "small" ones, start at 3.0), in the form wordfreq stores them in (below), only
  words in the language's scripts (CLDR 48's main exemplar letters), letters and marks only besides an
  apostrophe or Catalan's middle dot inside; words spelled with the zero-width non-joiner or joiner
  (Persian's "می‌شود", Hindi's, Bengali's) kept. `generate.py` (pinned `requirements.txt`) rebuilds it
  byte for byte; the folder's README carries the sources, the licence and what changed. It ships in the
  app's resources as `dictionary/` (2.24 million words, 35 MB on disk, about 9 MB compressed), so there
  is no download, no network and no missing-language state.
- **The lookup** is the shared core's, one for every system (`words::frequencies`,
  `voice_core_word_frequencies_json`, the helpers' `wordFrequencies`; ADR-DESK-054): `{folder, words}`
  gives each word's Zipf tenths, 0 when it isn't listed, null when no list is written in its script (or
  the word mixes scripts no language mixes in one word: a list names its writings, each the scripts
  one word may mix, Japanese's Han and kana, Serbian's Latin or its Cyrillic). No preferred languages,
  no language detection. A word is looked up in each form a list written in its script gives it, the
  form wordfreq stores that list's words in (its `preprocess_text` for the list's language, and
  `simplify_chinese` for Chinese, as `languages.json` describes each list; 7 forms among the 42 lists),
  and gets the most any of those forms is seen: NFC or NFKC (Japanese's half-width "ﾃｽﾄ" is "テスト");
  Serbian's Cyrillic letters to Latin ("Већ" is "već") and Chinese's Traditional ones to Simplified
  ("電腦" is "电脑"), through wordfreq's own tables, shipped in `languages.json`; the marks of Arabic,
  Persian, Urdu and Hebrew left out with the Arabic tatweel ("شكراً" is "شكرا"); case-folded, as
  wordfreq does, not just lowercased ("Straße" is "strasse", the ligature "ﬁ" of PDF text "fi";
  Turkish's dotted and dotless i in Turkish's form); s and t with a comma below in Romanian's, a cedilla
  in Turkish's ("şi" is "și"); a final sigma as σ, a curly apostrophe straight. Without these steps a
  word in those spellings was absent and so a term (found in review: every everyday Serbian Cyrillic
  and Traditional Chinese word was one). A word joined by a hyphen or an apostrophe that isn't listed
  is seen as its least seen part ("что-то"). The list becomes an `fst` map once per process; the first
  ask (the app's warm-up at launch, with no word) starts reading it on a background thread (about
  0.7 s; the map holds about 16 MB); a screen's ask then takes about half a millisecond for 150 words.
- **The rule** (`contextTerms`, written afresh; TabMail on iOS applies the same):
  1. Every word on screen is checked, split on spaces with the punctuation around it trimmed, as
     before; a word with a digit (`\p{N}`) or in an address (`@`, `://`) is skipped, as is one with no
     letter and one longer than a dictionary word (`dictionaryWordMaxChars`, 50: never a term)
     (`termCandidates`). The client asks about them in requests of at most
     `wordFrequenciesRequestMaxBytes` (512 KiB), asked together: a whole window's read with a word
     list open holds more words than the Windows and Linux main helpers take in one request line
     (1 MiB), and a longer line ends the helper.
  2. A word is ordinary when the word list sees it at least `screenTermCommonZipf` (Zipf 4.0) often.
  3. In a script no list is written in (null), a word with a capital letter is a term; others are not.
  4. A term is a word that is not ordinary. Each word stands alone: no runs of names, no trimming.
  5. Order: the rarer first (a word the list lacks, or in a script without a list, counts as 0), then
     the most often on screen, then the earliest. Every term goes (`dictationVocabulary` sends what
     fits); each once, the case aside, spelled as first seen; each a valid dictionary word of at least
     `correctionMinWordLength` letters. A word the answer has nothing for is no term.
- **Removed:** the macOS `SpellCheck`, Windows `spelling.h` and `dictionary_choice.h`, the Linux
  Hunspell folders, the core's `dictionaries`/`known_words` operations with `spellbook` and
  `encoding_rs`, the made-up-word probe, the capital-letter fallback for a missing dictionary, and the
  menu's missing-dictionary items and dialog (#334): every language is shipped.
- **Shared cases** in `native/shared/dictionary/cases.json`: `frequencies` (asked words and answers,
  one case per list with a word no other list sees as often) and `terms` (a screen, the answers the
  rule asks for, the terms in order, and `cutoff`), run by the Rust suite against the real list and by
  `contextTerms.test.ts`, which also checks `cases.json`'s cutoff is the app's: "kubectl" and "Xyvora"
  are terms; "today", "Today", "Paris" and "Schule" are not; a word in a script with no list is a term
  only with a capital letter; rarer words come first. TabMail on iOS copies the list and the cases.

**Validation (the cutoff):** one re-run of an earlier speech check of 618 words (spoken by the system
voice, Apple's on-device SpeechTranscriber, en_US, given no word list; two voices, each in a carrier
sentence: 159 common words and well-known names, 100 names with spelling variants, 160 made-up names,
150 names from many languages, 49 lowercase developer terms), every word judged by this rule. A word
needs help when either reading of it was misspelled: 392 of them.

| cutoff (Zipf) | needs-help words sent | words sent | sent but spelled right anyway | common words sent |
|---|---|---|---|---|
| 2.5 | 272/392 (69%) | 278 | 6 | 0 |
| 3.0 | 303/392 (77%) | 317 | 14 | 0 |
| 3.5 | 329/392 (84%) | 362 | 33 | 2 |
| 3.8 | 345/392 (88%) | 395 | 50 | 6 |
| **4.0** | **352/392 (90%)** | **414** | **62** | **12** |
| 4.2 | 358/392 (91%) | 443 | 85 | 30 |
| 4.5 | 373/392 (95%) | 493 | 120 | 63 |

The cutoff stays at **Zipf 4.0** (`screenTermCommonZipf` 40): past it each step gains a few names
and sends far more common words (4.5 gains 21 and sends 51 more). The 40 needs-help words it misses
are names that some language's list sees often ("Seoul" and "Kathryn" 4.2, "Intel" 4.3, "Steven" 4.4,
"Delhi" 4.5, "Ryan" and "Jon" 4.6, "Samsung" 4.7, "Marc" 5.0, "May" 6.8; first and family names of
many languages); judged by the user's languages alone the same cutoff caught 98%, the cost of one
list the owner accepted. The common words it sends are city, company and first names, which cost a
slot and nothing else, since the rarest go first.

**Consequences:**
- A name that is a common word in any of the 44 languages ("Paris", "Grace", "Drake") is not sent, nor
  is a common word of a language the user doesn't speak; a capitalized typo is. Accepted (owner).
- A rarely seen lowercase word ("pods", Zipf 3.6) is a term too, and lowercase jargon (`kubectl`) is.
- A Korean word with a particle the list lacks still looks rare (#356, P4). Chinese and Japanese are
  judged by space-split tokens, so an unspaced sentence is one token: a term unless the list has it,
  dropped only when longer than a dictionary word (`dictionaryWordMaxChars`).
- Simplifying Traditional Chinese letter by letter is wordfreq's own approximation; a word used only in
  Traditional-script regions may be judged by its Simplified look-alike.
- The app grows by the list's size. The list is CC BY-SA 4.0 (attributed in the folder's README and
  the repository README); the rest of the repository stays MPL 2.0.
- The launch warm-up reads the list even while screen reading is off.
- Blessed by the owner (2026-11-06): the list's size ("fine"), the menu's removal ("missing
  dictionary is no longer a thing"), the cutoff ("fine, we'll revisit if we need later"; the cutoff is
  re-chosen for the new data in the next amendment), the list read at launch with screen reading off
  ("fine"), and a word longer than a dictionary word not asked about ("50char+ is nonsense"). The
  owner's words, as typed: "list size is fiun neson main app only. yes, missing dictionary is no
  longer a thing. cutoff is fine, we'll reivsit if we need later. Yes, list being read is fine.
  nothing is a problem. yes, 50char+ is nonsense." The size again, asked with iOS's copy of the list
  (2026-11-06): "bundle yes. 35 MB old, probably larger is still fine as long as it is reasonable
  size to fit in main app. i mean, we bundle large network weights already. this is tiny".

### Amendment 2026-11-06 (owner): the word list is FrequencyWords' counts, the cutoff Zipf 3.5, and an Acknowledgements page

**Context:** the list above was wordfreq's data, which merges many corpora, some under terms of their
own (it asks that SUBTLEX's authors be credited), and TabMail on iOS ships the same list. The owner
wanted a source whose licence is plain for both apps and asked for a measurement first. FrequencyWords
(Hermit Dave's counts of OpenSubtitles 2018, one corpus, CC BY-SA 4.0) was measured on the same speech
check: at Zipf 3.5 it catches about what wordfreq caught at 4.0 (catching more foreign names and fewer
English spelling variants). The owner chose it ("let's do CC-BY and have ack page that shows we use
it. ios already has one, and voice should also have a similar page in settings") and asked that every
other third-party work Voice ships be credited too.

**Decision:**
- **The data.** `generate.py` now counts FrequencyWords' lists (pinned commit `525f9b5`) for every
  language: Filipino from its Tagalog list, Norwegian Bokmål from its Norwegian, Portuguese from its
  Portuguese and Brazilian Portuguese, Serbo-Croatian from its Croatian, Serbian and Bosnian, Chinese
  from its Simplified and Traditional lists. Each word is put in its list's form by wordfreq's code
  (`preprocess_text`, and its Traditional-to-Simplified table for Chinese; its word frequencies are
  not used), the counts of words sharing a form added up, and the Zipf taken against the list's total.
  The rest is unchanged: Zipf 2.5 or more, the language's scripts, letters and marks, merged with
  each word's highest Zipf. 41 lists, 2.55 million words, 38 MB on disk (about 10 MB compressed).
  `languages.json` is the same apart from Japanese.
- **No Japanese list.** FrequencyWords' Japanese list holds word stems without their kana (no "その",
  "東京" seen 378 times), so every Japanese word would have looked rare and become a term. With no
  list, a word with kana gets no answer (null) and, having no capital, is no term; a word in Han alone
  is judged by Chinese's list ("会議" as "会议"). Japanese screens send no terms but the Han words
  Chinese doesn't see often.
- **A word in parts.** FrequencyWords split words at the zero-width non-joiner and at Catalan's middle
  dot, so Persian's "می‌شود" is listed only as "می" and "شود", and "col·legi" only as "col" and
  "legi". The joiners a word missing whole is split at (`JOINERS`, the least seen part) now include
  the middle dot and the zero-width non-joiner and joiner beside the hyphen and the apostrophes
  (`cases.json` has both). Without the middle dot, everyday Catalan words such as "col·legi" read as
  never seen and became terms (found in review, 2026-11-06).
- **The cutoff** is Zipf 3.5 (`screenTermCommonZipf` 35; `cases.json`'s `cutoff`), re-measured on the
  shipped list with the speech check above (392 words that need help):

| cutoff (Zipf) | needs-help words sent | words sent | sent but spelled right anyway | common words sent |
|---|---|---|---|---|
| 2.5 | 266/392 (68%) | 274 | 8 | 2 |
| 3.0 | 308/392 (79%) | 329 | 21 | 5 |
| **3.5** | **348/392 (89%)** | **390** | **42** | **11** |
| 3.8 | 356/392 (91%) | 429 | 73 | 26 |
| 4.0 | 365/392 (93%) | 458 | 93 | 38 |
| 4.5 | 374/392 (95%) | 522 | 148 | 80 |

  Subtitles count names and spoken words more often than wordfreq's mix of text, so the same rarity
  sits lower: 3.5 sends about what wordfreq's 4.0 sent (414 words, 12 common). The needs-help words it
  misses are names subtitles say often ("Kathryn" 3.6, "Steven" 4.5, "Seoul" 4.6, "Ryan" 4.8, "Intel"
  5.1, "May" 6.7).
- **Cases** (`cases.json`): every answer re-measured; the Japanese cases removed (kana now answers
  null), Bulgarian's everyday word "защото", the Ukrainian everyday word "дякую" in place of "Київ", which the Ukrainian list barely sees,
  Persian's joined words seen through their parts, and the ordering case given a second unseen word so
  the earliest still wins a tie.
- **Acknowledgements.** Settings has an Acknowledgements section (`src/core/ui/acknowledgements.ts`,
  as TabMail on iOS's): an intro line, then each project and data set Voice ships or is built from,
  its name a link to its page, over its licence and what of it is used. The main process opens only
  those pages (beside the terms and the privacy policy). `THIRD_PARTY_LICENSES.md` at the repository's
  root says the same at length, with copyrights and the licence texts, and ships in every package;
  the word list's README (the sources, the licence, what changed) ships beside the list. A test fails
  when a package the app ships or a crate the shared core links has no credit. The page ends with the
  line that Voice is open source under the MPL 2.0, linking its source.
- **Licences of the list.** `words.txt` adapts FrequencyWords (CC BY-SA 4.0, Hermit Dave, from
  OpenSubtitles 2018 through OPUS, cited as OPUS asks). `languages.json` keeps wordfreq's letter
  tables, so it stays CC BY-SA 4.0 too and the wordfreq and SUBTLEX credits stay; its scripts come from
  CLDR, whose Unicode License v3 notice the README carries. Both files are licensed CC BY-SA 4.0 with
  the licence's disclaimer; the code stays MPL 2.0.

**Consequences:**
- TabMail on iOS copies the new list, the cases and the cutoff, and credits FrequencyWords the same way.
- English spelling variants are caught a little less often, foreign names a little more.
- The credits name direct dependencies and the memory helper's main components, as iOS's do; the
  packages and crates those pull in are one grouped entry, and their notices are generated at build
  time in a follow-up (issue #366, with Electron's and Chromium's licence files on macOS).
- Blessed by the owner (2026-11-06): no Japanese list ("Drop Japanese. And file a mission tracker if
  it doesn't exist already. No priority because it's an announcement."; issue #367, no priority), the
  cutoff 3.5 for the new data ("Frequency cutoff 3.5 is fine."), the page's place as the last section
  of Settings' sidebar ("Yes, last item like ios, yes."), and the hand-written notices file until #366
  generates it ("bless the license thing").
