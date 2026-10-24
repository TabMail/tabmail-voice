## ADR-DESK-052: Right Alt as an Ubuntu dictation key, held by the GNOME extension

**Context:** On Ubuntu the dictation key is F8 or F9, bound through the GlobalShortcuts portal, which
cannot bind a lone modifier, so Right Alt (the Windows default) was not offered there. The GNOME
extension (`voice-caret@tabmail.ai`) already grabs Space and Escape during a recording with Mutter
accelerators. Owner: Ubuntu's key back to Right Alt, once that is feasible. Probed on GNOME 50.1
Wayland (2026-10-05): `grab_accelerator('Alt_R')` fires once, about 2 ms after the press, with no
autorepeat; Mutter never reports the release of a modifier-only accelerator.

**Decision:** Right Alt is the dictation key by default on Ubuntu's GNOME (`["rightAlt", "F8", "F9"]`;
owner, 2026-10-05), held by the extension; other Linux desktops keep F8 and F9 only. GNOME integration is
required on GNOME: it is part of the keyboard permission, so dictation says "Setup needed" until it is
on, and Allow Keyboard Control turns it on first (owner's choice over keeping F8 until it is live):

- The helper's `configure` with `rightAlt` unbinds the portal's keys and asks the extension
  (`SetHotkey`) for `Alt_R` (dictation) and `<Shift>Alt_R` (agent mode), both without autorepeat.
  Its reply, and `hotkeyInstallationChanged`, say whether the Shell holds the key; the app's
  keyboard permission is that, as it is the portal's binding for F8 and F9.
- The release is read from the modifier state every 20 ms while the key is down, and only then.
  *(Superseded by the keyboard-hold amendment below: the release now comes from the key event.)*
  The press and release drive the shared gesture (ADR-DESK-032) as any other key does.
- Only the `Alt_R` keysym: where Right Alt is AltGr, it keeps typing characters, as on Windows.
  *(Amended below: the Shell can't hold it there, and Settings says so.)*
- The key outlives each recording, its Escape and its chat. A screen lock, the helper leaving or the
  extension being disabled lets it go (with a release if it was down); the extension broadcasts
  `ready` when it is enabled or the screen unlocks, and the helper asks for the key again.
- A recording key that cannot be grabbed is refused alone; the dictation key stays held.

**Rationale:** The extension is already the one place that holds keys for the helper; a second
mechanism (a keyboard device reader, an X11 grab) would need privileges or would not work on
Wayland. The 20 ms read runs only while the key is held, so an idle desktop pays nothing.

**Consequences:**
- After a fresh install, GNOME loads the extension only after a log-out and in; until then the
  keyboard permission is not granted, and the welcome guide and Settings say to log out and back in.
  GNOME releases the extension does not support (`unsupported`) go without it, as before.
- On GNOME, Space switches to agent mode while dictating, so the welcome guide no longer names a
  Shift shortcut there; Shift with the dictation key still starts agent mode on every platform.
- Right Alt is taken by TabMail Voice while it is the dictation key, so it no longer acts as Alt in
  other shortcuts.
- A release is noticed up to 20 ms late. *(Superseded below: the release is a key event.)*

**Amendment (owner, 2026-10-05) — the extension holds the whole keyboard while Right Alt is down.**
Review found three faults in the accelerator-only design, all reproduced on GNOME 50 in the VM: Space and
Escape during a hold reached GNOME as Alt+Space and Alt+Escape (window menu, window switch); with Sticky
Keys on, a lone Right Alt latched Alt, so the release poll saw Alt still down and no release was sent; and
on a layout where Right Alt is AltGr the grab silently failed. Owner: "grab the keyboard", like a game.

- On the `Alt_R` accelerator the extension takes a Shell modal grab (`Main.pushModal` on its own actor,
  `Shell.ActionMode.NONE`) for the hold. While it holds: Space sends `toggleMode`, Escape sends `cancel`,
  every other key is swallowed, and the release of the same physical key (whatever the layout calls it
  then: Meta_R with Shift down, another name after a layout switch) ends the hold and sends `hotkeyUp`.
  A revoked grab (the screen locks, another modal takes over) ends it the same way. The 20 ms poll is
  gone.
- The grab is a stage grab, so it takes the pointer too for the hold, and the window in front loses
  keyboard focus to the Shell until the release. The caret is read once before the grab and returned
  while it holds (`Read`).
- `Alt_R`, `<Shift>Alt_R`, `<Alt>Alt_R` and `<Shift><Alt>Alt_R` are grabbed: Sticky Keys latches Alt after
  a lone Right Alt, so the next press carries the Alt modifier.
- The helper never treats the Shell as the target. It asks the extension `Holding` (a bounded D-Bus
  call): while the Shell holds the keyboard, focus events are ignored and the window in front stays the
  target for the caret, the screen read and the field read (`Foreground::targets`); a paste still needs
  that window's real focus (`Foreground::matches`), which it has again after the release.
- Where Right Alt is AltGr, the key can't be the dictation key. Where the layout has no `Alt_R` at all,
  `SetHotkey` fails. Where the layout in use has none but Mutter finds one through its fallback US layout
  (Greek, Hebrew, Arabic), the grab succeeds and the press arrives as `ISO_Level3_Shift`: the extension
  checks the press's keysym, takes no hold, lets the key go so it types again, and sends
  `hotkeyUnavailable`. Either way the helper reports it, no longer installed, and Settings says Right
  Alt types characters with this layout and to choose F8 or F9. The report clears once a key is held
  or another key is chosen.

Rationale: a modal grab is the Shell's own way to own the keyboard for a moment, so no GNOME shortcut sees
Space or Escape and the release comes from the key itself, with or without Sticky Keys. Consequence:
during a hold no other key reaches any app, and a click goes nowhere until Right Alt is released.

**Amendment (owner, 2026-10-05) — F8 on a GNOME the extension doesn't support.** There Right Alt can
never be held, so Settings doesn't offer it: the dictation key is F8 (F9 the alternative), as on other
Linux desktops, and the welcome guide names Shift+F8 for agent mode and no GNOME integration to turn on.
A stored Right Alt choice is kept and returns once GNOME integration is supported.

---

