## ADR-DESK-045: Apps the screen is never read in, with the password managers built in

**Context:** Screen reading (ADR-DESK-008, ADR-DESK-010) was on for every app or off for all. A
password manager shows revealed passwords, one-time codes and notes as plain text, and its window
was read like any other. Owner, 2026-09-30: the password apps should be excluded from the capture,
with a Privacy section in Settings for the excluded apps: built-in exclusions, and additional apps
the user adds (issue #5).

**Decision:** An excluded app is never read. The list is the built-in password managers
(`config.builtInExcludedApps`: Passwords, Keychain Access, 1Password 8 and 7, Bitwarden, KeePassXC,
NordPass), excluded in every installation and not removable, plus the apps the user adds
(`AppSettings.excludedApps`, kept on this computer; `ExcludedApp` in `dictation/excludedApps.ts`).
Apps are known by bundle identifier, compared without regard to case.

- The dictation's key-down snapshot (ADR-DESK-017) carries the identifiers
  (`DictationSettings.excludedApps`). They go with the screen read (`readScreen`) and with every
  read of the pasted-into field for correction learning (`focusedFieldValue`, ADR-DESK-038).
- `voice-macos` refuses: `readScreen` finds the app in front and, if it is excluded, answers that it is hidden
  without reading it, the same lookup deciding both; `focusedFieldValue` answers no value for an
  excluded app's process. A request that doesn't carry the list is an error, so nothing is read by
  mistake. `ScreenAccess` is what those two requests read through, or a test's stand-ins.
- With no screen read, a dictation in an excluded app is as one with screen reading off: pasted,
  cleaned up without the screen, no screen terms in the vocabulary, no selection for agent mode's
  Edit, nothing kept for the debug window or the debug log, no correction learned.
- Agent mode is told the screen is hidden (owner, 2026-10-01). A screen that is not read for
  privacy (an excluded app, a page of an excluded website or of an unknown address: ADR-DESK-047)
  is answered by the helper as `{hidden: true}`, with nothing of the screen, not as null, which
  stays the answer for no app in front and for a read that failed. The app keeps treating it as
  no screen everywhere (`screenShown`), and agent mode's tools get `screenHiddenNote` as the
  screen's text (`screenVariables`), with the app, host, window title and selection empty. Without
  it a question asked in the kept-open chat after moving to an excluded page was answered from the
  earlier page, since an empty screen and a hidden one looked the same to the model. The note says
  only that the screen is hidden, not which app or site: naming it would send what the user chose
  to keep out. The dictation cleanup and the agent's choice of tool get no note (the first needs
  none, the second has no screen text). The note is the app's text in an existing prompt variable,
  so the backend prompts are unchanged. A helper that still answers null there is as before: no
  screen, and no note.
- Settings › Privacy (macOS, where the screen is read): the built-in ones named in a note, the user's
  apps with a Remove button each, and Add App…, which opens a picker on the Applications folder; the
  helper's `appInfo` gives the picked app's identifier and name.
- What is excluded is what is saved (owner, 2026-10-01): an exclusion or a removal that could not be
  written to the preferences file did not happen. The list is put back as it was
  (`AppSettings.saveExclusions`), `excludeApp` and `excludeSite` answer `unsaved`, and Settings says
  why. Nothing is excluded only until the app quits. *(This replaces the same day's first form, in
  which an unsaved exclusion was held for the run and saved by adding it again.)* Other settings
  still fail to save silently, logged only.
- The lists are bounded only so they can't grow without end (owner, 2026-10-01): at
  `exclusionsMax` (1,000) apps, or websites, one more is refused with the reason. Nothing is
  disabled or noted before that, and a stored list is read back whole. *(Was 100, with Add App…
  disabled and a note when full.)*

**Consequences:**
- A deny-list: every other app is read as before. Websites are excluded one by one since ADR-DESK-047
  (#77).
- A password manager not in the built-in list is read until the user adds it. Only identifiers
  checked against the app itself or its Homebrew cask are built in.
- An app without a bundle identifier (a bare process) can't be excluded.
- A secret shown in an app that isn't excluded (a key in a terminal) is still read; redacting
  secret-looking text is a follow-up (#78). Password fields are skipped in every app (ADR-DESK-007,
  amended 2026-09-30).
- "Read the screen while dictating" stays under Dictation and "Learn from my corrections" under
  Dictionary.
- The check is in the helper, not the Electron app (owner, 2026-10-01): the helper is small and
  ours, so an excluded app's text never reaches the app's main process. Every platform's helper
  takes the same list and refuses the same way.
- The Thunderbird relay's `focusedElement` (the email app's focused role and window title) is not
  gated by the list: it reads only the email app, and its tool is off (ADR-DESK-037).
- Windows and Linux get the list with their helpers' screen read.

