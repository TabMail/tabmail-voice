## ADR-DESK-012: The app is TabMail Voice (`ai.tabmail.voice`)

**Context:** Owner, 2026-09-25. The app built as `TabMail.app` (bundle id `ai.tabmail.desktop`). The
Thunderbird installer's pkg installs
`/Applications/TabMail.app` too: the launcher that starts Thunderbird, carrying `tabmail.xpi` and
the native-fts `fts_helper`, which `tabmail-native-fts` looks for at that path. Dragging this app into
`/Applications` would replace the launcher and break Thunderbird's local search. "Tabby" was ruled out
(an app by that name exists).

**Decision:** The app is **TabMail Voice**: `PRODUCT_NAME` and `CFBundleDisplayName` "TabMail Voice"
(`TabMail Voice.app`), module `TabMailVoice`, bundle id `ai.tabmail.voice` (tests
`ai.tabmail.voice.tests`). The code moves with it: `TabMailVoice/`, `TabMailVoiceTests/`,
`TabMailVoice.xcodeproj`, targets and scheme `TabMailVoice` / `TabMailVoiceTests`, `TabMailVoiceApp`.
The log subsystem, queue labels and Keychain service use the new id. Text that names the app says
"TabMail Voice"; text that means the service or the account (sign in, subscription, "sent to
TabMail") still says "TabMail". The repository stayed `tabmail-macos` at first;
renamed `tabmail-voice` on 2026-09-26 (owner), see ADR-DESK-013.

**Consequences:**
- A new bundle id is a new app to macOS: Microphone and Accessibility are asked for again (the
  welcome wizard, ADR-DESK-010, walks through them), the saved sign-in is not found (service
  `ai.tabmail.voice.session`), and settings start fresh. Grants for the old id stay in System
  Settings until removed (`tccutil reset All ai.tabmail.desktop`).
- Automatic signing covers the new id with no portal change while the app uses no capability
  that needs a provisioning profile; Developer ID distribution needs no App ID of its own.
- Earlier decisions keep the name they were written under ("TabMail Desktop", `ai.tabmail.desktop`)
  where they describe history.

