## ADR-DESK-014: Thunderbird connector spike: drive TabMail's chat from outside

**Context:** Owner, 2026-09-25: agent mode's bubbles become the supported apps, starting with
Thunderbird; any mail or calendar request goes to TabMail's chat in Thunderbird. Nothing outside
Thunderbird can reach the add-on today (no external messaging, no URL scheme, native messaging is
request/response). The owner chose a spike with no Thunderbird change before building a bridge,
the agent restating the request as a chat message, and sending being enough (no reply back).

**Decision:**
- A third tool, `thunderbird` (backend `system_prompt_desktop_thunderbird`, ADR-023), offered, and
  shown as a bubble with the email app's own icon, only when there is an email app for it. The agent's
  prompt always names it; the app fails a request given to a tool it did not offer ("Mail and
  calendar requests need Thunderbird with TabMail"). *(2026-09-26, ADR-DESK-011 amendment: without an
  email app the agent is not asked at all, so that failure no longer exists.)*
- `ThunderbirdRelay` sends the chat message: launch Thunderbird if it isn't running (then wait for a
  window and `thunderbirdAddonSettle` for the add-on), bring it to the front through Accessibility
  (`AXFrontmost`: the app is never active, so cooperative activation would ignore
  `NSRunningApplication.activate`), post the add-on's ⌥⌘L unless the focused window is already
  the chat, wait for a window titled "TabMail Chat", paste, press Return.
- The email app (owner, 2026-09-26: "configurable in settings (which email client) default to user
  default email client") is the one chosen in Settings › Agent mode, else the default email app
  (the `mailto:` handler) if it is a Thunderbird TabMail runs in: Thunderbird (release and ESR share
  `org.mozilla.thunderbird`) or Thunderbird Beta (`org.mozilla.thunderbirdbeta`, the add-on's dev
  instance). Any other default email app leaves the tool out until a Thunderbird is chosen.
  `EmailClient` resolves it at every call, so a change applies to the next request.
- Nothing is typed outside the chat: the shortcut is posted only while Thunderbird is in front, the
  paste only while the chat window has focus (checked again after the input settles), and Return
  only if it still has focus after the paste. Any failure shows a message.

**Consequences:**
- Known weak points, for the spike to measure: a chat that is mid-reply ignores Enter (the message
  stays in the input); the add-on registers ⌥⌘L lazily, so a suspended background page may miss
  it; a remapped shortcut breaks it; the app cannot tell whether the add-on is installed (the chat
  just never opens); cold-launch timing is a guess.
- The native-messaging bridge (plan option B, installed by this app only) replaces the shortcut,
  focus and timing guesses if the spike shows they matter.

**Amendment 2026-09-26 (review):**
- The chat is recognized by its exact title, "TabMail Chat". On macOS Thunderbird titles an add-on's
  popup window with the page title alone (`extension-popup-title` in `popup.ftl`, every locale), so no
  other title is the chat. A substring match also took a draft replying to a message about the chat
  ("Write: Re: TabMail Chat feedback"), or the main window showing a message whose subject starts with
  it, which would have got the message pasted in and Return pressed. A message whose subject is
  exactly "TabMail Chat" still passes for the chat: matching by title can't tell them apart.
- The relay's Accessibility calls into Thunderbird (window, focus, title, bring to front) run off the
  main thread, where the hotkey's event tap runs, and every element asked gets the
  `thunderbirdAccessibilityTimeout`, the focused window included (a timeout set on the application
  element does not carry over to the elements read from it). A hung Thunderbird then holds up only
  the relay, not the keyboard. Since those reads now suspend, the check that Thunderbird is in front
  comes after the title read (the user may switch away during it, and Accessibility still reports
  the chat as Thunderbird's focused window), and a cancel is honored before the paste and before
  Return. When that first read finds no chat, Thunderbird is checked to be in front again, and a
  cancel honored, before the shortcut: a false read can mean the user switched away, and ⌥⌘L
  would go to the app they switched to (Finder, Safari and Chrome bind it to Downloads).
- The chat is ready for a message only once its input has focus (Accessibility role `AXTextArea` in
  the "TabMail Chat" window), not as soon as the window has its title. A chat just opened has its title
  at once but focuses its input only after loading its history and building its context
  (`awaitUserInput`); pasting on the title plus a fixed 0.3 s settle lost the message on a cold open
  (owner, 2026-09-26: "it opens and then the message doesn't get through"). The relay waits up to
  `thunderbirdChatTimeout` (15 s, was 5) for the input, and the settle is gone. Measured on the owner's
  Thunderbird: a ready chat's focused element is the input, an `AXTextArea`.
- The relay is given the email app (a bundle identifier) with each send and asks every question
  (running, in front, focused window's title) of that app; it never reads Settings. The dictation
  takes the app from its key-down settings snapshot (ADR-DESK-017). Resolving the app from Settings
  at each check let a Settings change mid-send pair one app's chat title with another app in front,
  or press Return in the other app after the paste went to the first, submitting whatever draft its
  chat held.

**Amendment 2026-09-26 (add-on probe):** owner: "make sure that the tool doesn't show up if
Thunderbird does not have [TabMail] installed … sort of a probe?" There is an email app only while a
Thunderbird profile has TabMail's add-on (`thunderbird@tabmail.ai`) installed and enabled, which
closes the "cannot tell whether the add-on is installed" weak point above. `EmailClient.hasTabMail`
reads the profiles `~/Library/Thunderbird/profiles.ini` lists and each one's `extensions.json`; an
entry the user disabled (`userDisabled`) or Thunderbird disabled (`appDisabled`) does not count.
`active` is not used: Thunderbird leaves it `true` on an add-on the user has disabled (measured on
the owner's profiles). It is read at key-down with the rest of the settings snapshot (ADR-DESK-017),
so installing or enabling the add-on applies to the next dictation. Settings › Agent mode says when
the add-on is missing.
- Any profile counts. Thunderbird and Thunderbird Beta share the folder, and nothing in it says which
  profile a given installation opens, so the add-on in one profile turns the tool on even when the
  chosen Thunderbird opens another; the chat then never opens, as before.

