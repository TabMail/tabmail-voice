## ADR-DESK-010: A welcome wizard for consent, permissions and features; screen reading switchable

**Context:** Owner, 2026-09-25: the Mac app needs an onboarding wizard like the Thunderbird
one, covering (1) consent, (2) permissions and (3) feature toggles, starting with screen
reading. Until now, screen reading ran on every dictation whenever Accessibility was granted,
with no setting. At every launch the app asked for any missing Microphone and Accessibility
grants. The privacy policy tells users they can switch screen reading off.

**Decision:**
- **Layout.** The wizard copies the Thunderbird welcome wizard's layout:
  - a top rail of category labels, with one bubble per step;
  - Back and Next buttons, with Finish on the last step;
  - bubbles that return only to steps already reached.
- **Steps.** Consent → About You (the user's name, ADR-DESK-035) → Permissions (Microphone,
  Accessibility) → Features (screen reading).
- **Consent step.** It says what dictation sends: the voice, and the text in the front window
  while screen reading is on. It says where that goes (TabMail and its AI providers, not stored)
  and links the Terms of Service and the Privacy Policy. Next stays disabled until the user
  ticks the agreement.
- **Consent gates dictation.** A key-down without consent records nothing, reads no screen,
  sends nothing and says why. Consent is checked at key-down only: a dictation started with
  consent is still sent if the user withdraws consent before it ends, and the next key-down is
  refused. The owner chose this over re-checking before each request because it is the simpler
  code (2026-09-25). The menu's Stop stays enabled while recording, so a recording can always
  be stopped.
- **Permission and feature steps** never block Next.
- **Screen reading** (`AppSettings.readsScreen`) is on by default, since the consent step
  discloses it. It is read at every key-down with the other settings (ADR-DESK-017), so a change
  applies from the next dictation. It can also be switched in Settings.
- **When the wizard opens.** It opens at every launch until the user presses Finish; closing the
  window doesn't count. It can be reopened from the menu (Welcome Guide…).
- **Replaces the launch-time permission prompts.** The app no longer asks for permissions at
  launch; it only polls for the Accessibility grant, so a grant made in System Settings takes
  effect without a relaunch.

**Consequences:**
- Existing installs see the wizard at their next launch. They can't dictate until they consent.
- Consent, the screen-reading choice and "finished" are stored on this Mac (UserDefaults), not
  on the account. The consent isn't versioned; changing what dictation sends means re-asking,
  which is a new decision.
- A grant made from the wizard is announced by `PermissionsModel`. The Microphone grant is
  announced once the model already reports it. A Microphone grant prepares the microphone for
  the first dictation. An Accessibility grant re-installs the hotkey.
- **Open (owner):** per-app exclusion. It could be a denylist in the Features step or a built-in
  skip list. Web search and web reading get their own toggles in Features once they exist.
  *(Superseded by ADR-DESK-030, owner 2026-09-26: one Web switch, on by default, in the Features
  step and Settings, covers searching, reading and opening pages.)*

**Amendment 2026-10-07 (owner, #170): the consent step covers agent mode.** It listed only what
plain dictation sends. It now also lists what agent mode sends: the request and the selected text,
what the apps switched on return (events, contacts, notes, files), and the text of the web pages it
reads; and it says a web search also goes to a search provider (ADR-DESK-030). The page is
reworded, not re-asked, and no tip is shown: the app has no existing users (owner).
Later the same day, the owner: cover what the tools send too, and keep it short, with no legal
wording; the details are in the Terms of Service and the Privacy Policy. The item is one line, "In
agent mode, your request, the text you've selected, and whatever its tools need to do it.", which
new tools fit without another change; the closing item is back to its original wording, without
the search-provider sentence.
Later again (owner): the wording should invite, showing the value rather than a privacy scare, and
reassure with "may use" language (nothing is grabbed and sent all the time; secrets are redacted);
nothing sent this way is stored. The consent page now opens "To get your words right, TabMail
Voice may use:", one short line per item: the voice only while the key is held; the text in the
window being dictated into, with passwords and secrets left out and a switch to turn it off; the
dictionary, learned from corrections on this computer; agent mode's request, selection and
whatever its tools need to help; and "Only when you dictate, and only to help with it. Nothing it
sends is stored." The screen-reading captions in the Features step and Settings, and the
recording note in Settings, take the same tone. Dropped from the page, left to the Terms of Service
and the Privacy Policy: the app name, window title and website address the screen read carries,
that a long dictation is sent in parts (ADR-DESK-049's consent-page line), and that the data goes
to TabMail and its AI providers.


**Amendment 2026-10-18 — memory (ADR-DESK-061).** The consent page gains a line after agent mode's:
"Your past agent-mode requests, kept only on this computer so it can recall them. Remove them
anytime in Settings." The closing "Nothing it sends is stored" stays true: it is about what is sent;
memory is kept on this computer only. Users who consented before are told once, by the what's-new tip
(ADR-DESK-049's way, its amendment of this date), and are not asked again.

