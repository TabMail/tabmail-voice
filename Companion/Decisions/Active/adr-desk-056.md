## ADR-DESK-056: On GNOME, the extension says which window is in front

**Context:** The Linux helpers named the dictation's target window from AT-SPI focus events, and each
dictation on Ubuntu kept tripping over them (2026-10-09 to 10 smoke): Firefox's snap shows as two
accessible apps and moves the focus through the second and back as the Shell lets the keyboard go, so
the window got a new token and every paste was "another app is in front"; activating a large page's
window (Gmail) walked the page for its focused element, ran out of its budget and dropped the target
just as the paste asked for it; the extension's `Holding` call, which says the Shell holds the keyboard
for the dictation key, timed out under load and the focus events of the hold then moved the target;
and GTK 4 apps (GNOME Text Editor) deactivate their window and drop their field's focused state for
the whole hold, so the screen read, made during the hold, found the field unfocused and withheld it:
the selection came back as the placeholder, which agent mode took for a secret. The Shell knows all of
this directly: its focus window does not change while it holds the keyboard. Owner: "we should
definitely move almost all the probing things to the extension, honestly, because it knows exactly all
these things."

**Decision:** The extension (version 3) answers `Focus`: the Meta window with the keyboard focus, by
its id, and its process (none while the screen is locked). Where it answers, the helpers name the
target window by that id (`Foreground::target`, `front`, `matches`, `targets`), and the AT-SPI focus is
taken only as the element in it, and only when it is that window's process's, or, for a sandboxed app,
came while that window was in front: a Flatpak app reaches the accessibility bus through its bus proxy
(xdg-dbus-proxy), so the bus names the proxy's process, never the one the Shell names. A window's deactivation
no longer drops the target, and an element read while the Shell holds the key over the same window and
focus counts as focused (`LiveScreenTree::focusKept`). Without the extension (another desktop, a GNOME
it does not support, or before the log-in that loads it) the AT-SPI path stays, with one fix of its
own: the target's own window activated again keeps the target, the walk for its focus waiting for the
focus to come back by itself. A paste still needs accessibility to name what has the focus in the
window the Shell names (`Foreground::matches`): a window it can't see (a terminal without it) has no
known paste keys, and is not the target (`front` names none, so the dictation ends in the not-pasted
note, ADR-DESK-042), and the Shell's own interface over the window (the overview, the window switcher, a
menu or a dialog) leaves the Shell's focus window as it was; there `Focus` answers none too. Direction: further probing (which field has the focus, the caret, the selection)
moves to the extension as it can answer it.

**Consequences:** each check is a synchronous D-Bus call to the Shell, bounded at 250 ms
(`focusTimeoutMilliseconds`); an extension updated in place runs its old version until the next log-in,
during which the helper reports GNOME integration not ready and Settings asks for a log-out and back in
(the existing `restart` state). Two paths now name the target, the Shell's and AT-SPI's, until the
extension can answer everything the helpers ask.


