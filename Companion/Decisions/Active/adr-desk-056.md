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

**Amended 2026-11-06 (owner, standing rule for every Linux problem): extension first.** When a Linux problem
comes from the desktop being less uniform than macOS or Windows (an app that can't be named, a missing or
misleading accessibility attribute, an environment variable a launcher drops, a focus or caret the
accessibility tree reports wrongly), first check whether the GNOME extension can answer it directly from the
Shell (for example `Shell.WindowTracker` for which app owns a window) and fix it there. A helper-side
workaround (AT-SPI heuristics, launcher or desktop-file guessing, per-app special cases) is the path only for
what the extension can't see, or for desktops and GNOME versions without it, and the issue or PR says why
the extension could not do it. Example: #370, snap Chromium can't be named from its process, so its window's
app comes from the extension. Counter-example: #371, the caret in a browser's rich editor. The Shell knows the
caret only as the input method's cursor rectangle, which Chromium places right and Firefox does not (measured
2026-11-06 in the test machine, Firefox 157 and Chromium 156), so the caret anchor stays the helper's: the editor's
accessible caret sits on the object character of the line holding it, and the helper follows it into that
line (`caretInWindow`, at most `caretObjectDepth` elements deep) before asking where it is drawn. Only in a line
followed into is a caret at the end read where the last character ends (browsers give no rectangle past a line's
text); a field with no objects keeps its provider's rectangle, and a password field's text is never read for it.

**Amended 2026-11-06 (#370): the extension names a window's app (version 5).** The helpers named an app by
its process's launcher (`desktopIdentity`: the `GIO_LAUNCHED_DESKTOP_FILE` the launcher set, else a launcher
whose `Exec` is the process's program). Snap Chromium, the only Chromium Ubuntu ships, fails both: it drops
the variable, and its program (`/snap/chromium/<revision>/usr/lib/chromium-browser/chrome`) is no launcher's
(`/snap/bin/chromium`). Unnamed, it was read even where the user excluded it. The Shell knows each window's
app (`Shell.WindowTracker`, as the dock and the window switcher name it; measured on GNOME 50.1:
`chromium_chromium.desktop` for snap Chromium, `firefox_firefox.desktop`, `org.gnome.TextEditor.desktop`).
The extension's `App(window)` answers the live window's desktop file id and name, or empty strings where the
Shell names the app by its window alone (no desktop file); an id no live window has (0, a closed window's, or
a token of a helper's own) is the error `ai.tabmail.Voice.Caret.Error.NoWindow`, never an empty answer. The
helpers (`Foreground::identity`) name the window in front, and the window captured at key-down, by the Shell's
app where it names one, and ask also where they hold no Shell id for the window (a focus the Shell named no
window for, a capture from the helper's own token); the launcher lookup stays for desktops without the
extension and for a live window the Shell knows no desktop file for, which the Shell can't name, and for an
extension older than `App` (until the next log-in). A window the Shell has no live window for is not one the
launcher may name: an empty answer there let the launcher stand in, and an excluded snap Chromium captured
under a helper token was read. The app is asked at each read, each answer bounded at 1 s (`HelperConfig::shellAppTimeoutMs`,
owner 2026-11-07: longer than `Focus`'s 250 ms, since a read the Shell misses gives nothing). A Shell that
was asked and gave no answer (no reply in time, any other failure) names no app, and the launcher does
not stand in for it: that read gives nothing, since the window may be an app the user excluded, and the
next read asks again; the miss is logged as an error (no content), so an extension that stays stuck until the next
log-in shows in the app's log. Nothing is cached per focus, so a stall touches only the read it overlaps. Helpers require version 5, so a
Shell still running version 4 until the next log-in is not ready, and Settings asks for one, as before.
