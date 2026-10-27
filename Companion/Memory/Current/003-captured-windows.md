## Captured windows

At key-down `TargetWindows` captures the foreground window, or the external window before Voice
when Voice is in front. Its app-local numeric handle is kept through shown/whole reads and paste.
Wire `target` is `{window, pid}`: HWND on Windows; an instance-scoped UUID for a retained AX window
on macOS; GNOME's window id plus AT-SPI `bus` and `path` on Linux. Rust validates these fields.
The native helpers answer `captureTarget`. GNOME integration version 4 adds `Target` and `Activate`;
its window is raised through `Main.activateWindow`. macOS additionally uses `preparePaste`,
`pasteTarget`, `cancelPaste` and `finishPaste` (ADR-DESK-053). Helpers always verify the target before
sending paste keys.

macOS also retains the focused AX element. If it disappears or focus names another element after
window restoration, paste is refused and the existing click-to-copy card preserves the text
(ADR-DESK-042). Text/caret changes within that same element remain allowed. Logical field tracking
through scene rebuilds and Windows/Linux field parity are P4 #276.
