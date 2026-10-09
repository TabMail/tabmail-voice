# Ubuntu / GNOME native helpers

The first Linux target is Ubuntu 26.04 with GNOME 50, on ARM64 or x64. Build on
that target architecture: the helpers link to its system AT-SPI, GLib, PulseAudio
and ICU libraries. KDE support is deferred to [issue #100](https://github.com/TabMail/tabmail-voice/issues/100).

`voice-hotkey` uses the GlobalShortcuts portal and the shared gesture state machine.
On GNOME, Right Alt is the default, held through the GNOME extension (see `gnome/README.md`); elsewhere,
and on a GNOME the extension doesn't support, F8 is, with F9 available as an alternative. Hold to dictate, double-tap
for hands-free, or triple-tap for history. Shift plus the selected key starts agent
mode or switches mode during hands-free listening; Ctrl+Shift plus the key cancels
or closes chat. Startup binds the selected shortcuts; GNOME restores previously
approved IDs without a dialog and requests approval when bindings are new.
The helper reports installation only after the portal accepts every binding.
GNOME's AT-SPI keyboard monitor is restricted, so no raw keyboard watcher is used.
Unrelated typing does not cancel a held dictation on this portal backend.
`voice-linux`
provides focused-window identity and clipboard
insertion through the common newline JSON helper protocol. `voice-microphone`, a program of its
own as on macOS and Windows, captures the microphone through PulseAudio and nothing else
(ADR-DESK-032), so no AT-SPI call can hold up a recording. It captures once: it ends itself with
the shared restart code once its session stops, its start fails, a newer start comes or the
running capture fails, and the app starts it afresh; which session runs is the shared core's
decision (`../shared/microphone`). `voice-screen-reader`, a program of
its own, reads the screen and nothing else, and `voice-field-reader`, another, reads the focused
field that correction learning watches after a paste and nothing else; each keeps its own record of
what has focus, so its window tokens are its own (ADR-DESK-053). The field reader is therefore asked
for the field by the process of the window pasted into (`pid`, which `voice-linux`'s `frontmostApp`
gives beside the window's token) and reads it only while the window in front is that process's.

Install Node.js 24, CMake, Ninja, a C++20 compiler and the development packages for
AT-SPI (2.56 or later), GLib/GIO, PulseAudio, IBus (`libibus-1.0-dev`), ICU and nlohmann-json. From the app:

```sh
npm run build
npx electron-builder --linux deb --publish never
```

For a source run, use `npm run start:linux`. Direct executable launches must include
`--ozone-platform=x11`; Electron selects the backend before the app's main script.
The packaged desktop launcher and login launcher include this option. A late
`app.commandLine.appendSwitch` does not reliably select XWayland.

Native tests additionally need Python GObject introspection with the TinySPARQL
3.0 typelib (`python3-gi`, `gir1.2-tinysparql-3.0`) and `pulseaudio-utils`.
The microphone test creates a temporary null sink, feeds it a synthetic tone,
and selects its monitor only for `voice-microphone`, which it runs through the shared
protocol checks (`../shared/microphone/protocol.mjs`), then checks that a start with no sound
server, and a capture whose connection to the sound server is cut (through a relay to a TCP
listener the test loads), each end it with the restart code. It removes the sink and the listener afterward;
it does not change the desktop's default audio devices.

For native tests, from the repository root:

```sh
cmake -S apps/desktop/native/linux -B apps/desktop/native/linux/build/test -G Ninja -DBUILD_TESTING=ON
cmake --build apps/desktop/native/linux/build/test --parallel 2
ctest --test-dir apps/desktop/native/linux/build/test --output-on-failure
```

Run desktop tests as the normal signed-in user with the session's D-Bus and display
environment, including `XDG_CURRENT_DESKTOP`. Prefer the installed desktop entry;
a guest-agent shell does not inherit the graphical session. Omitting its desktop
identity makes panel-theme detection fall back to the application theme, which
can produce black lettering on GNOME's dark panel even in light mode.
The accessibility fixture opens a GTK window and takes focus; omit
`voice-accessibility` when the desktop is being used. The private D-Bus portal
fixture exercises the real asynchronous helper code without requesting desktop
permissions. Passing that fixture does not prove a live compositor permission,
hotkey or paste interaction. The file-search fixture uses an in-memory TinySPARQL
index on its own D-Bus session, so it neither reads nor changes the user's index.

The real terminal viewport fixture additionally needs GTK3 and VTE 2.91 Python
introspection typelibs. Run it only in a disposable GNOME session with the Voice
caret extension enabled; it creates and focuses its own synthetic window:

```sh
python3 apps/desktop/native/linux/tests/terminal-viewport.py \
  --helper /path/to/voice-linux --diagnostics /tmp/voice-terminal-fixture.log
```

It checks duplicate split panes, focused-pane identity, exact Unicode caret
offsets, explicit selection with an independent caret, exclusion of hidden
panes and old scrollback, the caret window's text around the cursor, and that the
helper's field read in a terminal is the box around its cursor. Each stage emits JSON evidence. It does not prove other
terminal providers or all concurrent focus races. This test is separate from
CTest because it needs a configured desktop compositor and changes focus.

Both long-lived helpers watch the portal's D-Bus owner using GIO name notifications.
Losing an observed owner ends the helper and uses the existing client restart path
to clear permissions and establish fresh sessions and registration. Initial absence
is tolerated, preventing a restart loop while the portal is unavailable. This also
covers portal crashes that cannot emit `Session::Closed`.
See [GIO name watching](https://docs.gtk.org/gio/dbus-name-watching.html).

Insertion requires a keyboard-only RemoteDesktop session with the Clipboard
portal enabled. It takes no screen capture or pointer-control permission. The
installed desktop identity is `ai.tabmail.voice`. The helper requests persistence
and stores the opaque, single-use restore token in a private file under the user's
state directory, consuming it on restoration and saving its replacement after a
successful grant. Startup attempts restoration only when a saved token exists;
first-time authorization remains an explicit permission-button action. Revoked grants or a compositor that refuses restoration can
still require consent again. Tokens are never logged. The
paste never reads the clipboard: it publishes the text, validates the original
app/window and waits for this session to own the selection before sending the
paste chord, and releases its injected keys. `ClipboardKeeper` saved the
clipboard ahead (`clipboardSave`, asynchronous `SelectionRead`s on the event
loop, once the portal has announced the selection) and puts it back
`restoreDelay` after the paste, only while this session still owns the
selection it offered the text in; a password manager's copy
(`x-kde-passwordManagerHint`) and a file transfer are not saved (ADR-DESK-002,
amended 2026-10-08). Clipboard portal version 1 has no atomic owner check, so a copy
made between the final check and the chord has a compositor race. An uncertain
paste is never retried. The terminal paste chord uses the provider's terminal role (Ctrl+Shift+V); ordinary
fields use Ctrl+V. Live GNOME clipboard behavior still requires runtime testing.
See the [portal contract](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Clipboard.html)
and [Mutter clipboard implementation](https://gitlab.gnome.org/GNOME/mutter/-/blob/main/src/backends/meta-clipboard-session.c).
The private-bus fixture covers silent startup, explicit clears, malformed owner
events, a paste that never reads the clipboard, and the save and put-back: every
format put back, a copy after the paste or between the save and the paste kept,
two pastes, a read still held when the paste comes, password-manager copies,
file transfers, too many formats and an unannounced selection.

Foreground and focus events drive accessibility lookup. Failed window lookups
retry at most five times, a second apart, and stop when the window is left. There
is no permanent polling or accessibility warm-up at hotkey press. Screen context
uses the shared redactors and reading-order formatter; password and excluded-page
checks precede content access.
The helper enables the standard `org.a11y.Status.IsEnabled` bridge at startup;
connecting an AT-SPI client alone does not enable application accessibility.
It does not enable screen narration or disable the bridge when it exits, since
other assistive clients may depend on it.

The Debian package uses electron-builder's custom AppArmor profile option. It
uses a named profile with explicit `allow all` and Electron's user-namespace allowance, and
executes only `voice-linux`, `voice-screen-reader` and `voice-field-reader` with the ordinary unconfined desktop label
(`Ux`, with loader environment cleanup). Otherwise a helper inherits the Electron label,
which Snap's AT-SPI peer rules reject even though the parent profile itself is
unconfined. The explicit allow-all form honors this transition on the target kernel; its
`unconfined` and `default_allow` modes retained the inherited label in guest testing.
The profile does not change Firefox's confinement or disable AppArmor. It also lets `/usr/bin/pkexec` leave it (`Ux`): an update installs as root
through `pkexec`, and dpkg under the inherited profile couldn't make its backup links to the files it
replaces (found in the Ubuntu VM's installed upgrade).
See [electron-builder's profile rationale](https://github.com/electron-userland/electron-builder/issues/8635),
[Ubuntu's execution-mode documentation](https://manpages.ubuntu.com/manpages/resolute/man5/apparmor.d.5.html),
and [Snap's accessibility peer rules](https://github.com/canonical/snapd/blob/master/interfaces/builtin/desktop_legacy.go).

The app uses the shared Electron UI under XWayland. Until reliable global caret
coordinates are available, the overlay uses a stable position in the display work
area rather than surface-local provider coordinates; see
[issue #89](https://github.com/TabMail/tabmail-voice/issues/89). The tray uses the
existing text glyph with light lettering on GNOME's dark panel. This is not a KDE
runtime compatibility claim.

The development Debian package includes only the Linux helpers, declares the
Ubuntu runtime dependencies (`openssl` and `pkexec` among them, for updates). Mac-only native
connectors remain unavailable. Thunderbird connectivity is outside this work.

## Updates

Packaged builds look for updates at `https://cdn.tabmail.ai/releases/voice/linux-${arch}/` (`latest-linux.yml` on x64, `latest-linux-arm64.yml` on ARM)
(ADR-DESK-050) once the package carries a public key in `resources/linux/update-keys/`; without
one, updates are off. The feed's `signature` is Ed25519 over the package's name, architecture,
version and SHA-512. `install-update` (packaged under `linux/`, root-owned) checks it as the user
once the `.deb` is downloaded, and again as root, on its own copy, when the user installs it from
the menu or the question through `pkexec` (its polkit action,
`resources/linux/ai.tabmail.voice.install-update.policy`, gives the dialog its message and asks for an
administrator every time); then `apt-get install` installs it, with any missing
dependency from the system's own sources, and the app opens the new version. Nothing installs
by itself, and an older or equal version is refused. `test/main/native/linux/installUpdate.test.ts`
runs the real script on Linux.

## Upstream implementation references

[OpenWhispr's hotkey manager](https://github.com/OpenWhispr/openwhispr/blob/main/src/helpers/hotkeyManager.js)
rejects standalone right-side modifiers on its GNOME shortcut backend and uses a
regular-key fallback such as F8. Its
[GlobalShortcuts portal implementation](https://github.com/OpenWhispr/openwhispr/blob/main/src/helpers/gnomeGlobalShortcutsPortal.js)
receives activation and deactivation events, while the older GNOME custom-shortcut
path only toggles recording. Its separate evdev listener reads keyboard devices;
that requires device access and is not the GNOME shortcut backend. The supported
portal is the preferred direction here; the owner accepted standard keys, and F8 is the portal's default here. Do not claim
modifier-only parity from portal setup.

[OpenWhispr's paste helper](https://github.com/OpenWhispr/openwhispr/blob/main/resources/linux-fast-paste.c)
uses the RemoteDesktop portal and restore tokens on GNOME Wayland. Our write-only
clipboard and target-validation contract remains shared with the other platforms.

OpenWhispr's [Linux clipboard path](https://github.com/OpenWhispr/openwhispr/blob/196937c489bf700688f0cadc48211ba2570bb775/src/helpers/clipboard.js)
also permits a Wayland paste with no identified window. TabMail retains its
original-window check, matching the Mac contract; an unavailable identity must
not be mistaken for evidence that the original window is still focused.

## GNOME file tools

`voice-files` queries the existing LocalSearch index through TinySPARQL. It runs
as a separate, bounded process so index queries cannot block audio or insertion.
Build with `libtinysparql-dev`; packages depend on the runtime library and
LocalSearch. Values use prepared statement bindings, including typed dates.
Search is limited to indexed locations in the user's home; unindexed files are
not discovered by a secondary crawler. Potentially executable items and symlinks
are revealed in Files rather than opened.

References: [LocalSearch endpoint](https://gnome.pages.gitlab.gnome.org/localsearch/endpoint.html)
and [TinySPARQL connection API](https://tracker.api.gnome.org/class.SparqlConnection.html).

### Native productivity stores

`voice-productivity` is a one-request helper for Evolution Data Server. Contacts
use EBook's query builder and bounded cursors across enabled address books; creates
use the default writable address book. The shared Contacts tools own confirmation.
The helper does not retry writes, and the caller reports ambiguous failures without
claiming that nothing was saved. Provider errors and request contents are not logged.

Build with `libebook1.2-dev`; Debian packages require `libebook-1.2-21t64` and
`evolution-data-server`. The parent limits the helper to 30 seconds and 1 MiB of
output, separate from hotkey/audio processing. Unsupported cursor providers fail
explicitly instead of loading an unbounded address book. Results follow each
provider's family/given-name cursor order, visiting enabled sources in registry
order; this is not a global merge of every account's sort order.

The `voice-productivity` CTest uses a private D-Bus session and temporary HOME/XDG
stores, exercising actual local EDS creation/search, accent matching, result bounds,
query escaping and invalid-write refusal. It does not read the desktop's accounts.
Notes uses the EDS memo lists through ECal. Creation targets the default writable
memo list. Search uses a streaming view, collecting at most 1,000 matches and
512 KiB of JSON with 32 KiB per text field. An overflow, provider failure, changed
snapshot or incomplete view is refused, not silently truncated. Each view has a
10-second deadline inside the parent's 30-second process deadline. This reads EDS
memos, not arbitrary installed notes apps. Add `libecal2.0-dev` when building and
`libecal-2.0-3` at runtime.

Reminders uses EDS task lists with the same bounded view. The shared tools retain
confirmation, sorting and due-date formatting. Reads omit completed/cancelled
items; a due-before filter excludes undated tasks. Writes use the default writable
task list and preserve date-only versus timed values, with minute precision on
creation to match EventKit. Provider timezone identifiers are resolved through
ECal. Existing GNOME Online Accounts/EDS configuration determines available lists;
this does not provision a new remote account.

Calendar tools use EDS calendars. Creates preserve the shared inclusive all-day
end convention while storing EDS's exclusive DTEND. Reads collect a completed
view and fetch complete recurring series by UID through error-returning APIs.
EDS expands RRULE/RDATE/EXDATE; the adapter applies exact and RANGE exceptions,
retaining original recurrence identity, final overlap filtering and cancellation.
Recurring masters are discovered independently of unmodified overlap so a shifted
occurrence cannot disappear from a narrow query. The read can therefore reach
limits on a calendar containing many recurring series, even for a short interval.
Initial snapshots are capped at 1,000 components/512 KiB; complete-series retrieval
at 2,000 counted components/1 MiB, and output at 1,000 occurrences/512 KiB. Expansion
also stops after 10,000 visited occurrences per component. Exceeding a bound fails
the entire request without returning partial results. All calls remain inside the
parent process deadline.

The private-store test covers recurrence exclusions, moved and cancelled instances,
RANGE shifts and changed duration, DST, all-day dates and excessive recurrence.
A test-only preload library injects UID/timezone provider failures to verify that
they cannot become an empty-success response; it is not packaged with the app.
See the [EDS recurrence API](https://gnome.pages.gitlab.gnome.org/evolution-data-server/libecal/func.recur_generate_instances_sync.html)
and [complete-series API](https://gnome.pages.gitlab.gnome.org/evolution-data-server/libecal/method.Client.get_objects_for_uid_sync.html).
