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
- **The refine** (`kbRefine.ts`, a port of iOS's `KBRefinementService`). When a chat window closes
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
  about the user (ADR-DESK-010, amended); users who consented before are told by the release's one
  what's-new tip, and are not asked again. That tip, ADR-DESK-061's what's-new under a new id (`agentKnowledgeBase`, so the count of `agentMemory`, which 0.4.0 to 0.5.2 showed, never holds it back), reads "New:
  agent mode remembers / requests and learns about you, / on this computer".

**Consequences:**
- The KB and writing style are written to disk on this computer, until edited or reset; they are the
  user's own notes and preferences, not email content (root ADR-004), and are kept as Thunderbird and
  iOS keep them.
- Every agent-mode request is larger by the KB (and a writing request by the style).
- The refine sends a closed chat's requests and replies to the backend once more (not kept there).
- The refine also writes `[Reminder]` entries for "remind me" requests, as Thunderbird's and iOS's do;
  Voice's own reminders go to `reminder_create` and Voice fires no KB reminders (owner question open,
  recorded in the backend ADR-023 amendment).
- Tests: see `TESTS.md` (the knowledge base and writing style rows).
