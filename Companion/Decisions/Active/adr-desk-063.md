## ADR-DESK-063: The knowledge base and writing style, kept on this computer, sent with agent mode

**Context:** Owner, 2026-10-17 (KB tools added 2026-10-18): Voice gets the
user's knowledge base (KB) and writing style, as Thunderbird (the reference) and iOS (the reference
for the refine) have them: sent with agent mode's requests, edited in Settings, the KB also by
`kb_add` and `kb_del` and refined when a chat window closes after at least three requests (the iOS
rule). Agent mode only; plain dictation is unchanged. Kept on this computer here; Device Sync (and
its reset when another account signs in) comes next, in the same release.

**Decision:**
- **The store.** `UserPrompts` (`src/core/personalization/prompts.ts`) keeps both texts and their
  history in `<userData>/userPrompts.json`, apart from the settings file, under Thunderbird's and iOS's
  keys (`user_prompts:user_composition.md`, `user_prompts:user_kb.md`, `prompt_history`). The texts are
  Thunderbird's: the writing style its markdown document with three sections of bullets
  ("General writing style", "Language", "Useful links to personal website and other resources", each
  under its "(DO NOT EDIT/DELETE THIS SECTION HEADER)" header), the KB a list of bullets. A text never
  written reads as Thunderbird's default (`defaults.ts`), which reading never stores. Per user of this
  computer, as memory is; not cleared at sign-out (a different account's reset comes with sync).
- **One writer.** Settings, `kb_add` / `kb_del` and the refine all write through `UserPrompts`, each
  reading the text and writing it back in one synchronous step (`updateKnowledgeBase`), so no write
  is lost to another. A write the file can't keep puts every key back and reports it; what applies
  is what is saved. The texts a write changes (both, for a restore) go in one write of the file
  (`KeyValueStore.setAll`), which replaces it whole: one key at a time, a restore whose second
  write failed left the first text changed in the file while it reported nothing changed.
- **Thunderbird's rules, ported.** `bulletMerge.ts` (bullets, sections, the three-way
  `mergeBullets` / `mergeFlatField`) and `patchApplier.ts` (`applyKBPatch`, `normalizeUnicode`) are
  ports of the add-on's files, rule for rule, with its test cases (`TB-0xx`). Their quirks are kept so
  the three apps read and merge the same texts alike: a `kb_del` must match the stored bullet
  `[Pinned]` prefix included; an ADD to an empty KB leaves a leading empty line.
- **What a request sends.** The KB and writing style are read at key-down, with the settings
  (snapshot rule); a change meanwhile applies to the next request. The agent loop's message carries
  `user_kb_content` (the KB, always) and `user_composition_prompt` (the writing style, only when the
  loop offers Compose or Edit, as Thunderbird sends it only to its writing prompts; empty otherwise).
  What is sent as the style is its three sections only, each as `# <section>` and its bullets, a
  section holding nothing left out: not Thunderbird's whole document, whose "Strictly follow these
  instructions in future responses" and BEGIN/END markers would nest inside the backend's own wrapper
  and govern the chat window's replies too. The stored document stays in Thunderbird's format, for
  sync. The backend puts each in its own turn, through the prompts Thunderbird and iOS share
  (`chat_converse_kb`, `agent_composition`; root backend ADR-023 amendment of 2026-10-27).
- **`kb_add` and `kb_del`** (`kbTools.ts`) run on this computer in the agent loop with every request
  (Answer on or off, as the memory tools: "remember that" may come with any request), with
  Thunderbird's argument, patches, results and errors: `kb_add` normalizes and trims the statement
  and makes it one line (line breaks become spaces: a statement is one bullet, so a line in it that
  reads ADD or DEL never becomes another edit, which Thunderbird's patch would run; `kb_del` alike),
  adds it `[Pinned]` (once; the refine's prompt keeps pinned bullets), and a duplicate changes nothing;
  `kb_del` removes the matching bullet, case and a final period aside. They edit only the user's own
  KB, so they ask nothing first. Called beside Compose or Edit ("remember that and write it") they
  still run: the draft waits for the loop to end (ADR-DESK-055, amendment 2026-10-19). Memory's
  bubble runs for them (ADR-DESK-036, amendment 2026-10-19). They run at
  once, so the chat window shows no activity for them
  (the plan had them shown like other tools; a progress line would never be seen); Settings shows the
  change. They are the common tools Thunderbird and iOS run, offered to Voice only when the app
  lists them in `available_tools` (ADR-DESK-064), as this version does; no prompt names them, so
  they need no protocol bump. On the flat tool registry they are `requestTools` entries with
  memory's bubble and no progress label.
- **The refine** (*removed 2026-10-27, see the amendment below; kept as history*) (`kbRefine.ts`, a port of iOS's `KBRefinementService`). When a chat window closes
  after at least `kbRefineMinUserTurns` (3) requests, its requests and replies (`[USER]:` / `[AGENT]:`,
  never the screen) go to the backend's `system_prompt_kb_refine` with the KB as it was then, the
  time, and Thunderbird's limits (14 days' reminder retention, 200 bullets), tools off. What comes back
  is merged three ways into the KB as it is now (`mergeFlatField`: before, now, refined), so an edit
  made meanwhile in Settings or by `kb_add` stays. A refine answered after the user reset or
  restored the KB is dropped: those put back a whole text the user chose, which a merge can't tell
  from the one the refine read. One at a time: a chat closed while one runs is not
  refined, as on iOS. It runs with a fresh token for the account signed in at the close and is dropped
  if another account is signed in by the time the backend answers; a chat ended by sign-out or an
  account change is not refined, nor one closed after consent was withdrawn (read at the close, with
  the settings). Nothing waits for it, nothing keeps it past a quit, and a failure is
  only logged.
- **Settings › Personalization** (`page.ts` and the Settings page): the writing style's three sections
  and the KB as editable bullet lists (add, edit in place, remove; a bullet's line breaks become spaces),
  Reset for each (asked first), and the history. An edited row is saved when focus leaves the row, not
  its field: pressing the row's own Remove focuses it first, and a save then replaced the row (keyed
  by its text) under the press, so the removal was lost. An edit carries the bullets the page showed
  (`shown`): each row is keyed by its text (and how many equal bullets come before it), not its
  position, so a change made elsewhere while the page shows leaves what is being typed in the other
  rows (a row whose own bullet changed shows the new text); the bullets shown are compared as shown,
  a leading space kept, so one `kb_add` or a refine stored that way can be removed and edited; when
  the text still holds them it is the edit as made, else it is merged three ways into
  the text as it is now, so a `kb_add` or refine since the page showed is kept. The history, as iOS's
  (`PromptHistoryEntry`): both texts recorded once edits stop for `promptHistoryQuietPeriod` (2 s), and
  before a reset or restore; at most `promptHistoryMax` (100) entries, the oldest dropped; each shows
  what restoring it would bring back and take away, and Restore (asked first) puts both texts back,
  for every entry: one that adds and removes no item can still differ (order, an item kept twice), so
  it says "No items added or removed." and can be restored too, as on iOS.
  Edits waiting for their quiet period are recorded at quit. IPC commands are checked at the boundary
  for their shape (a known section; bullets a list of strings). Their number and length are not
  capped there: `kb_add` and the refine write bullets of any length and count, and a cap would refuse
  every later edit of such a KB. The Settings fields take at most `personalizationBulletMaxLength`
  characters for a bullet the user types.
- **Consent.** The consent page's memory line now names the writing style and what agent mode learns
  about the user (*since 2026-10-27: what the user asks it to remember; see the amendment below*) (ADR-DESK-010, amended); users who consented before are told by the release's one
  what's-new tip, and are not asked again. That tip, ADR-DESK-061's what's-new under a new id (`agentKnowledgeBase`, so the count of `agentMemory`, which 0.4.0 to 0.5.2 showed, never holds it back), reads "New:
  agent mode remembers / requests and learns about you, / on this computer".

**Consequences:**
- The KB and writing style are written to disk on this computer, until edited or reset; they are the
  user's own notes and preferences, not email content (root ADR-004), and are kept as Thunderbird and
  iOS keep them.
- Every agent-mode request is larger by the KB (and a writing request by the style).
- *(Until 2026-10-27, when the refine was removed:)* The refine sends a closed chat's requests and replies to the backend once more (not kept there).
- *(Until 2026-10-27:)* The refine also writes `[Reminder]` entries for "remind me" requests, as Thunderbird's and iOS's do;
  Voice's own reminders go to `reminder_create` and Voice fires no KB reminders (owner question open,
  recorded in the backend ADR-023 amendment).
- Tests: see `TESTS.md` (the knowledge base and writing style rows).

**Amendment 2026-10-27: no refine; the knowledge base changes only through the tools and Settings.**
Owner: "the voice app just reads existing knowledge base and uses the tools to edit the knowledge base
directly itself, but it's not automated in terms of chat summarization or anything, because the memory
search deals with everything", and "we don't have to extract facts from the chat because [Voice] has
memory anyways and [it'll] search for it." Memory (ADR-DESK-061) keeps every agent-mode request and
`memory_search` finds it, so nothing a chat said is summarized into the KB.
- The refine is deleted: `kbRefine.ts` (`KBRefiner`, `refineChatHistory`, `refineTime`), the
  controller's chat-close trigger (`dropChat` no longer sends anything), `CompletionsClient.refineKB`,
  the config numbers (`kbRefinePrompt`, `kbRefineMinUserTurns`, `kbRefineReminderRetentionDays`,
  `kbRefineMaxBullets`) and `UserPrompts.knowledgeBaseReplacements`, which only the refine read. No
  backend change: the backend's refine is unchanged for Thunderbird and iOS.
- Voice's KB changes only through `kb_add`, `kb_del` and Settings (edit, Reset, Restore). The writing
  style stays edited by the user only. Once Device Sync syncs the KB, Thunderbird's and iOS's refines
  dedupe, trim and expire the shared KB, so Voice needs none of its own; their `[Pinned]`, `[Task]` and
  `[Reminder]` lines reach Voice as they wrote them.
- Copy: nothing says agent mode learns about the user any more. Settings' KB caption: "Agent mode adds
  to it when you ask it to remember something." (replaced by the #296 tab captions, below) The consent page's memory line: "Your past agent-mode
  requests, your writing style and what you ask it to remember, kept only on this computer so it can
  use them. Edit or remove them anytime in Settings, which keeps the last `promptHistoryMax` versions of
  your writing style and knowledge base." The what's-new tip (not yet shipped): "New: agent mode
  remembers / your requests and what you / ask it to, on this computer". The History caption states
  what History holds, plainly (owner: "in line with what happens right now", and not scary): the last
  `promptHistoryMax` (100) changes to the writing style and knowledge base, kept on this computer to put
  an earlier version back. (The caption doesn't say it, but an edit or removal stays in the earlier
  versions until newer changes roll them off.) Past requests have no history: Settings › Memory searches and removes them.
- Test: `controller.test.ts` › the knowledge base › "a chat … is not learned into the knowledge base"
  (closed, and closed by a follow-up written into the app, after four requests): no
  `system_prompt_kb_refine` request is sent, no request at all is sent at the close (only the follow-up
  written into the app), and the KB is unchanged; red on the code with the refine. The account-change
  tests that also checked the refine keep their account half: "signing out ends the conversation
  before the next account" and "signing into another account ends the conversation" (a direct switch,
  no sign-out: the chat closes and the next request carries no conversation).

**Amendment (2026-10-27, a file that can't be read is never written over; owner):** `JSONFileStore`,
which holds `userPrompts.json` and the settings file, used to start empty on any read or parse failure,
and its next save replaced the whole file with defaults: one passing read error at launch would have
cost the user's knowledge base, writing style and history, and once Device Sync carries them, could
spread that loss to the user's other apps. Now only a file that isn't there yet (`ENOENT`) starts
empty. One that is there but can't be read, for want of permission (`EACCES`, `EPERM`), because it is
damaged (not a JSON object), or for any other read error (`EIO`, `EBUSY`, `EMFILE`), is never written
over, reset or moved by the app (owner: no automatic reset, and no tool to clear it). The app keeps
working on defaults for that file, every save answers false, and `problem` says why:
- Once launch is done (the windows' commands wired), a dialog says which file, where it is, that the app leaves it as it is, and what to do by
  hand: give the account read and write permission (per platform), or, for a damaged file, quit, move
  it to the Trash (Recycle Bin) and reopen, which resets what it held. Show File and Close; no Relaunch button, as the app never relaunches itself through Electron (ADR-DESK-050).
- The tray icon is marked and the menu keeps "Fix Settings File…" / "Fix Knowledge Base File…",
  showing the dialog again, as a missing permission keeps its Allow item.
- Every change that can't be saved says so and names that item, each time. Settings and the welcome
  window say it above every section or step (`fileProblemLine`; the welcome window for the settings
  file, which it writes; *superseded for the welcome window by the #285 amendment below, which never
  opens it then*), and every command that keeps a choice in the file answers with it: the IPC
  command handler looks the command up in `commandWrites` (every command named, so a new one is
  decided) rather than each command checking. What such a command changed holds until quit (the store
  keeps it in memory), except an exclusion, a personalization edit, the event duration and the memory
  limit, which are put back (`saveOrPutBack`). `kb_add` /
  `kb_del` (the model is told, to tell the user) say it too. (`change_setting` would as well, but while
  the settings file can't be read the agent reaches no other app, its Settings among them; see below.)
- While the settings file can't be read, no screen is read (owner, 2026-10-27, issue #282: the user's
  own excluded apps and websites are in it): `DictationSettings.readsScreen` is false at every key-down,
  even with screen reading switched on this session, so neither the field nor the window is read, in
  dictation or agent mode. For the same reason nothing else of the user's is read either: word
  learning, which reads the field pasted into after the paste, is off (`learnsWords` false), and the
  Answer tool reaches none of the other apps (`enabledConnectors` empty), as the apps the user
  switched off are in the file too. Dictation itself works. *(Superseded by the #285 amendment below:
  with the wizard closed consent can't be given, so dictation is refused until the file is fixed.)* The
  menu says "Not reading the screen or
  other apps until the settings file is fixed" above its Fix Settings File… item, and Settings and the
  dialog say it too; it ends at the next launch that reads the file.
- While the settings file can't be read, the user's memory limit is unknown, so an agent request is not
  kept in memory (`DictationSettings.memorySizeLimit` null): keeping it within the default would
  remove what a larger limit kept.
Device Sync (PR 3): a damaged file is first restored from the user's other apps; a default never
written carries Thunderbird's epoch-zero timestamp so joining sync never overwrites a peer; nothing is
sent from a store that couldn't be read.
Tests: `main/storage/jsonFileStore.test.ts`, `jsonFileStore.readErrors.test.ts`,
`core/ui/fileProblems.test.ts`, `main/tray.test.ts`, `main/index.test.ts`, `kbTools.test.ts`,
`settings.test.ts`, `dictation/controller.test.ts`, `renderer/settings/index.test.ts`,
`renderer/welcome/index.test.ts`.

**Amendment (2026-10-27, an unreadable settings file never opens the welcome wizard; owner, issue
#285):** a settings file that can't be read reads as setup never done (consent and the finished
wizard are in it), so the wizard opened at every launch, and from the menu's Finish Setting Up and
Welcome Guide. It never opens then: `showWelcome` tells how to fix the file instead (the same dialog as
at launch and the Fix Settings File… item), and launch opens no wizard, only that dialog. Consent stays
not given inside, so nothing of the user's is read, as above. The welcome window's line about the
settings file, which it could then never show, is gone (`WelcomeState.fileProblems` deleted); Settings
still says it above every section. Consent can then be given nowhere (only the wizard sends
`setConsent`), so while the settings file can't be read every dictation is refused (with the off line
of the widening below) until a launch reads the file; before
this, a user could consent again in the wizard, unsaved, and dictate that session. Only the settings
file keeps the wizard closed: a knowledge base file that can't be read leaves it as ever. Test: `main/index.test.ts`, for each kind of read failure, at
launch and from the menu.

*Widened the same day (owner): "we don't know if consented, nor if AI disabled now", so while the
settings file can't be read its AI features are off, dictation included. "The thing to turn off is
AI": everything that isn't AI keeps working.* Off: every dictation and agent hold, refused at its start
by `DictationSettings.isAIOff` (since 2026-10-28 `aiOffLine`, shared with Opt Out of AI; ADR-DESK-010) before consent is even looked at, with `aiOffLine` ("AI features are off
until your settings file is fixed"), so no audio, transcription, warm-up, cleanup or completion and no
read of the screen, a field or another app; the transcription, warm-up and completions requests also go through one transport that refuses them
while the file can't be read, whatever asks (the web fetch and other tools run only in agent mode,
refused at its start); and memory, whose helper runs a model over what the user asked, so
Settings › Memory's commands are refused. On, as ever: signing in and the account, updates, Settings,
the menu and the fix dialog. A user switch kept in the settings file can't be read, so what it governs
is off too; Device Sync, which comes later, follows that rule. The menu shows that line above Fix
Settings File… (replacing "Not reading the screen or other apps until the settings file is fixed"),
and the fix dialog and Settings say it. The reading gates above stay as they are. Tests:
`dictation/controller.test.ts` (a dictation and an agent hold from those settings, consent given or
not, start nothing, read nothing and send nothing), `main/index.test.ts` (the warm-up, transcription
and completions reach no network while signing in does; with the file read, or only the knowledge base
file unreadable, they do; updates as ever with either file unreadable; Settings › Memory never reaches
memory, and does with only the knowledge base file unreadable), `tray.test.ts`,
`core/ui/fileProblems.test.ts`.

**Amendment (2026-10-28, the user's factory reset; owner, issue #287):** fixing the file by hand stays
the first option the fix dialog gives, and the app still never resets, moves or writes over a file
on its own. The dialog (at launch, from Fix Settings File… / Fix Knowledge Base File…, and from
`showWelcome`) now ends each kind's steps with "Or choose Reset to Defaults… to start again; the file is kept, renamed." and has three buttons: Show File, Reset to Defaults…, Close
(Close the default and cancel). Reset to Defaults… asks one confirmation (`resetConfirmation`): what
this computer loses (for the settings file its settings, the dictionary and the excluded apps and
websites among them, and the welcome guide opens again; memory's size limit goes back to the default,
so the oldest requests past it are removed, as the limit was unknown and memory untrimmed while the file
couldn't be read; for the knowledge base file the knowledge base, writing style and their history), what stays (sign-in and the other file's contents; for the knowledge base file, settings and memory), and the path the unreadable file is kept at. Cancel is its default. On Reset the file is renamed beside itself to
`<name> (before reset YYYY-MM-DD HH.MM.SS).json` (local time, `resetCopyPath`), never deleted and never
written over (`JSONFileStore.moveAside` refuses a taken name, and a store with no problem), and the
store starts empty at the defaults, written to a new file from its next change. What the session held
unsaved is dropped with it, except the Globe key's saved action (ADR-DESK-031): while fn is the hotkey
the system's Globe key is held at Do Nothing with the user's own action in this file, so the reset keeps
that one value and the hotkey's change to its default hands the key back. A confirmation answered after
another reset the file (two fix dialogs open at once; one without a window isn't modal on Windows and
Linux) does nothing. The app is not relaunched (ADR-DESK-050): `AppSettings.resetFile` /
`UserPrompts.resetFile` tell their observers, a hotkey back at its default is re-registered, the menu
loses the Fix item and the off line, and after a settings reset the welcome wizard opens as at a first
launch (consent not given, so nothing is read or sent until the user gives it there). A rename that
fails changes nothing and says so (`resetFailed`); the steps by hand still apply. Device Sync (PR 3)
adds one sentence to the confirmation, that sync can restore the knowledge base and writing style from
the user's other devices and doesn't reset them there, and its test. Tests:
`main/storage/jsonFileStore.test.ts` (a damaged file kept byte for byte as the copy and an unreadable one moved there, the
store saving afresh; refused with no problem, a taken name or a failed rename, changing nothing),
`core/ui/fileProblems.test.ts`, `settings.test.ts`, `personalization/prompts.test.ts`,
`main/index.test.ts` (nothing moved at launch, on Close or on Cancel; a confirmed settings reset keeps
the dated copy in the same folder, names it in the confirmation, opens the wizard with consent not
given and saves again; a knowledge base reset opens no wizard; a failed one changes nothing and says
so).

**Amendment (2026-10-28, owner, issue #294): a reset never trims memory.** The size limit the user chose
was in the settings file that couldn't be read, so it is unknown before the reset and after it. The
reset no longer puts it back to the default, which would remove the oldest requests if memory held more.
Instead `AppSettings.resetFile` stores the limit as null, "Not set" (`AppSettings.unsetMemorySizeLimit`).
The fix by hand (the file moved to the Trash) loses the limit the same way, so a launch that finds no
settings file (`JSONFileStore.isNew`) while memory's database is there stores it as null too. A
database exists only after agent mode ran, so the limit is unknown, not the default. The reset writes the
limit not set together with what it keeps (the Globe key's saved action) in one write
(`AppSettings.resetFile`'s `kept`): if that write fails, no file exists, and the next launch reads it as
removed by hand, so a reset can never leave a file that reads the default limit. `AppSettings.memorySizeLimit` reads
null both while the file can't be read and while it is not set, and a request is kept only within a
known limit (`DictationSettings.memorySizeLimit`), so nothing is kept or trimmed until the user picks
one. Settings › Memory shows the menu at "Not set", no usage bar, and the caption "Size limit not set:
agent mode's requests aren't kept until you choose one." Any first choice asks first ("Set the limit
to …? If memory holds more, its oldest requests are removed."), as a lower one does. The confirmation
no longer has its size-limit sentence; it now says "Your sign-in, memory, knowledge base and writing
style stay as they are." This supersedes the memory sentence of the #287 amendment above. While AI
features are off (this file unreadable, or Opt Out of AI), Settings › Memory lists, removes and clears
but neither searches nor sets the limit (ADR-DESK-010 amendment, #294). Tests: `settings.test.ts`,
`main/index.test.ts` (the reset leaves the limit null, memory is never trimmed, and the user's pick is
kept and applied), `renderer/settings/index.test.ts`, `core/ui/fileProblems.test.ts`.

**Amendment 2026-10-28 (#296) — Settings › Personalization as tabs.** Owner: the page was too long,
and the writing style's sections ("General writing style", "Language", …) were hard to see. Each block
is now a tab: Writing style, Knowledge base, History, in a segmented control under the page title
(equal segments, the chosen one raised as a control; the system's selection colors in a contrast
theme; the arrow keys move between them; the scroll bar's room is kept, so nothing shifts as a tab
that scrolls replaces one that doesn't). Settings › Personalization opens on Writing style. Each tab
opens with a short caption, a sentence to a line (owner, 2026-10-28): Writing style "How agent mode
writes for you. / Sent with its requests; TabMail doesn’t keep it." (replaced by #301, below), Knowledge base "What agent mode
knows and remembers about you. / Sent with each request; TabMail doesn’t keep it.", History "Your last
`promptHistoryMax` changes, kept on this computer so you can put one back."; and, for the two texts, its
Reset centered beside it; Reset's question, too wide to share the caption's line, goes under it
rather than squeezing the caption into a column. Each panel is a stop in the Tab order of its own, so
Tab from the chosen tab reaches it even when it holds no control (an empty History). Each writing style section is its own card
under a heading with the section's name. Every tab stays rendered while hidden, so what is being typed
in one is still there on coming back. A change that couldn't be saved is said under the tabs until the
next change, whichever tab is chosen: a field left for another tab saves as it is left, and its failure
can arrive as that tab shows, so it must still be said there. Each tab names its panel by place (an id
holds no spaces). Nothing about what is stored or sent changes. Tests:
`renderer/settings/index.test.ts` (tabs, panels and their ids, the chosen tab drawn as chosen,
headings, Reset per tab, arrow keys, typing kept, a failure still said after a change of tab), `renderer/settings/style.test.ts` (the chosen tab raised, equal segments, the contrast
theme's colors and focus ring after the rules they override, the lists' lines between rows), and the
previews (`npm run preview`), which check each tab's caption as laid out (a sentence to a line, Reset
centered beside it, its question under it) and press a real Tab key from an empty History's tab.

**Amendment, 2026-10-28 (#301, owner):** the writing style is learned from the user's email and sent
only when agent mode may write or edit text (Compose or Edit offered), so Settings says so. Its intro
reads "How agent mode writes emails and formal replies for you. / Sent only to write or edit text;
TabMail doesn’t keep it." (short enough for Reset to stay centered beside it), and the "General writing style" section is shown as "General
writing style for emails and formal replies" (`writingStyleSectionLabels` in the Settings page).
Display only: the section's heading in the style document, shared with Thunderbird and iOS and read
by Device Sync, and the section an edit names stay exactly as they were. Tested in
`renderer/settings/index.test.ts` ("the general section's label is display only").
