## ADR-DESK-035: Agent mode sends the user's name, set in the wizard or Settings

**Context:** Owner, 2026-09-28. In a direct-message chat the user asked agent mode to relay a message
to the other person ("tell him…"); Compose wrote the reply as the other person, greeting the user by name. The request
carried the window title, the screen (messages under both people's names) and the request, but
nothing said who the user is, so the backend's model could not tell the user's own messages on screen
from the other person's. Thunderbird's compose prompt has always had the user's name. The owner:
"send the macOS full name or the username, but a more natural way is to have it in the setup wizard",
and, when it is not set, a tip in "a neutral, inviting way"; "if it's not set, it's fine, but it's a
sort of nag to set it in the wizard and settings".

**Decision:**
- A stored setting, `AppSettings.userName`: null until the welcome wizard or Settings stores one,
  empty when the user cleared it, kept as typed and sent trimmed (`sentUserName`). It is part of the
  dictation's settings snapshot (`DictationSettings.userName`).
- The welcome wizard has an "About You" step after consent, with a name field offering the computer
  account's name (`suggestedUserName`): on macOS the account's full name from `voice-macos`
  (`fullUserName`, `NSFullUserName()`), else its short name (`os.userInfo().username`), the only name
  elsewhere. Next without editing keeps the offered name; a name typed, or one cleared, stays as the
  user left it. Nothing else stores the offered name.
- Settings › Agent mode has the same field, empty with the offered name as its placeholder while none
  is set, and a note inviting one; the section is marked for attention until a name is set.
- While no name is set, switching to agent mode shows a tip by the pill (`setName`: "Add your name in
  Settings so agent mode knows which messages are yours"), every time, until a name is set; switching
  back to dictation takes it away. Hands-free, it takes the hands-free tip's place for its display
  duration, and the hands-free tip returns after it. A follow-up in the chat window shows no tips, as before.
- Every tool's request (edit, compose, thunderbird, answer) sends `user_name`, empty when none is set
  (the backend leaves a missing variable in the prompt as written). The choice of tool sends none. The
  backend's prompts say text on screen under that name is the user's own, and Compose that a relayed
  request ("tell him…") is a message from the user to that person (backend ADR-023 amendment).

**Consequences:**
- The name leaves the computer only with agent mode's requests, and the backend does not store it.
  Dictation's cleanup does not send it.
- A user who finished the wizard before this step (the app has not shipped) has no name set, sees the
  tip in agent mode and the mark in Settings until they set one.
- A name that matches none of the names on screen (a nickname, another spelling) helps less; the
  prompt reads "that name, or part of it".

