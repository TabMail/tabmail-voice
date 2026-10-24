## ADR-DESK-027: Email, a prefilled new message in the user's email app

**Context:** Owner, 2026-09-26: without TabMail, mail is prefill only: Apple Mail, Thunderbird
without the add-on and any other email app get a filled-in compose window and the user presses
Send; the agent never sends mail. One switch, on by default, in Settings and the wizard
(ADR-DESK-024). The backend defines `email_compose` (`src/tools/macos/`): `to`/`cc`/`bcc` address
lists, `subject` and `body`, passed to the app as the model wrote them. First built in the Swift
app; built here in the Electron app (ADR-DESK-032).

**Decision:**
- The `email` connector with `EmailComposeTool` (`src/core/agent/connectors/email.ts`) over an
  `EmailOpener` the main process gives it.
- One mechanism for every email app: a `mailto:` URL (RFC 6068, `mailtoURL`) opened with the app
  the system opens `mailto:` links with. Every value is percent-encoded from its UTF-8 bytes, leaving
  only the unreserved set (and `@` in an address), so an `&`, `=`, `?` or `#` the model writes stays
  in its field and cannot add a header; line breaks are CRLF; a lone surrogate becomes U+FFFD
  rather than failing the call.
- The main process asks `voice-macos` for the default email app (`emailApps`, which Settings
  already uses), names it in the result, and opens the URL with `shell.openExternal`. With none,
  the tool fails with `NoEmailAppError`, whose message the model passes on.
- Nothing is sent, so nothing is asked first. At least one recipient, a subject and a body are
  required, and every recipient must be one address (`isAddress`); a name goes back to the model
  to look up with `contacts_search`.
- Not used: Apple Mail's AppleScript (`make new outgoing message`) and Thunderbird's `-compose`.
  `mailto:` fills every app the same way with no Automation permission prompt; it gives up
  attachments and reply threading (a reply is a new message to the sender with "Re: ").
- Its icon is an open envelope with a letter, told apart from the Thunderbird tool's closed one.

**Consequences:**
- No new permission or entitlement.
- The draft goes to the email app only: nothing is stored (ADR-004).
- How long a body a `mailto:` URL carries is up to the email app; not measured.
- Offered on macOS only, with the other connectors, though the mechanism is Electron's and would
  work elsewhere once the default app can be named there.

