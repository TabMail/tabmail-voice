# GNOME dictation integration

The `voice-caret@tabmail.ai` extension supplies focused caret geometry to TabMail
Voice's existing Electron overlay. GNOME 50 is supported. Other desktops, missing
extensions, unavailable input-method coordinates, and busy compositor requests use
the normal work-area fallback. Overview/Search may cover the overlay; the extension
does not render above Shell surfaces or move keyboard focus.

The extension listens to the same input-method signals used by GNOME's on-screen
keyboard: Wayland cursor location and X11 IBus cursor location. It exposes only a
rectangle on the session bus, never field text. During recording it also grabs
Space to change mode and Escape to cancel, using Mutter accelerators.
The grabs belong to the requesting helper connection and are released on recording
end, cancellation, helper disconnect, screen lock, or extension disable. Action
signals are sent only to that helper. No periodic polling, accessibility-tree
traversal, or custom renderer is involved.
The helper allows 25 ms for the bus call; the app bounds the entire request to 200 ms.

When Right Alt is the dictation key, the extension also holds it for the helper,
because the portal cannot bind a lone modifier: `Alt_R` starts a dictation and
`<Shift>Alt_R` starts agent mode, both without autorepeat. Mutter reports the press
but not the release, so while the key is down, and only then, the extension reads
the modifier state every 20 ms and reports the release. Only the `Alt_R` keysym is
held; where Right Alt is AltGr, it keeps typing characters. Cancelling a recording
leaves the dictation key held. A screen lock, a lost helper or disabling the extension
lets it go, with a release if it was down; when the extension is enabled or the screen
unlocks, it broadcasts `ready` and the helper asks for the key again.

## Installation and activation

The `.deb` installs the extension in GNOME's standard system directory:

`/usr/share/gnome-shell/extensions/voice-caret@tabmail.ai`

The package manager owns these files and removes them when the app is uninstalled.
Open TabMail Voice Settings → Permissions → GNOME integration → Enable to activate
it for the current user. This leaves other extensions unchanged. Newly installed or
updated extensions may require logging out and back in. Settings checks the live
extension protocol before reporting Enabled; files on disk alone are insufficient.
GNOME version validation remains enabled. The portal shortcuts remain available
when the extension is disabled or unavailable.

For development only, copy the extension directory into
`${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/`, log out and back in,
and enable it with `gnome-extensions enable voice-caret@tabmail.ai`. A development
user copy overrides the system package; move it out before testing package upgrades.

## Development

Run the JS lifecycle tests through CTest's `voice-gnome-extension`, or:

```sh
node --experimental-vm-modules --test extension.test.mjs
```

Use GNOME's supported `gnome-shell --devkit --wayland` for isolated UI tests. When
launching it from the main Shell, first place it in its own `systemd-run --user --scope`
unit, then create its private bus with `dbus-run-session`. Otherwise the nested Shell
inherits the parent's `org.gnome.Shell` unit and incorrectly tries to start systemd
X11 services on its private bus. Keep its XDG data/config/runtime directories separate, including the activation
environment of its private bus, so test AT-SPI services cannot replace desktop sockets.

References:
- [GNOME extension development](https://gjs.guide/extensions/development/creating.html)
- [GNOME 50 input-method geometry consumer](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-50/js/ui/keyboard.js)
- [GNOME's systemd session detection](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-50/src/shell-util.c)

- [Mutter temporary accelerators](https://gnome.pages.gitlab.gnome.org/mutter/meta/method.Display.grab_accelerator.html)
- [Blurt dictation extension](https://github.com/QuantiusBenignus/blurt/blob/main/extension.js) (reference only; no code copied)
