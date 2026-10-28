## ADR-DESK-065: On macOS the app is in the Dock while Settings is open

**Context:** Owner, 2026-10-22: "if the Settings is open, we should have a dock icon on the Mac, just
like we have it on … Ubuntu and maybe also Windows … so that it's clear" (issue #252). The Mac app is a
menu-bar app with no Dock icon (`LSUIElement` in its Info.plist, `app.dock.hide()` at launch), so an
open Settings window behind other apps had no Dock icon and no Cmd-Tab entry to bring it back. On
Windows and Linux the Settings and welcome windows already show in the taskbar (only the overlay, the
hidden audio window and the paste history skip it).

**Decision:**
- **Which windows.** The app's own windows, opened from the menu (`presentedWindows` in `Windows`):
  Settings, the welcome wizard and the last screen context. The overlay and the paste history float
  over other apps and never put the app in the Dock.
- **Shown.** Opening one shows the icon (`app.dock.show()`) if it isn't already there. Showing it
  moves the focus (Electron activates the Dock and then the app), so the window is shown and focused
  only once `show()` has resolved; a window already open is brought forward the same way.
- **Hidden.** When the last of them closes, the icon is hidden (`app.dock.hide()`), but no sooner
  than `dockHideAfterShowDelay` (1.2 s) after it showed: Electron ignores a hide within a second of a
  show (a guard against macOS leaving two icons), which would leave the icon in the Dock after a
  window opened and closed quickly. A window opened while that hide waits cancels it and keeps the
  icon, without showing it a second time.
- **The menu bar.** In the Dock the app owns the menu bar while it is in front, which a menu-bar app
  never did. Electron's default menu would show there, with View (reload, developer tools) and Help
  (Electron's website), none of them the app's. The Mac app sets its own: the app menu (About, Hide,
  Quit), Edit (cut, copy and paste in Settings' fields) and Window. Windows and Linux are unchanged.
  *Amended 2026-10-28 (#298): it also has File, Electron's `fileMenu` role, whose one item on macOS is
  Close Window (Cmd-W): Electron's Window menu on macOS has no Close, so Cmd-W did nothing. It closes
  the focused window (Settings, the welcome guide, the last screen context, the paste history); the
  overlay is never focused, so it is never closed this way, and the app keeps running in the menu bar.*

**Consequences:**
- Clicking the Dock icon activates the app, which brings its open window forward (macOS does this).
  Quit from the Dock icon's menu, or Cmd-Q, quits the app as the tray menu's Quit does.
- The packaged app keeps `LSUIElement`, so it still launches with no Dock icon and never shows one
  until a window opens.
- Tests: `windows.test.ts` (the icon shows as Settings opens and the window shows only after it;
  opened again, no second show; hidden after the last window closes, not before the delay since it
  showed; kept while another of the windows is open or one opens before the hide; never for the
  overlay or the paste history, never off macOS), `index.test.ts` (the Mac app's menu, none set
  elsewhere), each red-verified against the code before.
