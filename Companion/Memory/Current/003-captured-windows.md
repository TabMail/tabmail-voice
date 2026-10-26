## Captured windows

At key-down `TargetWindows` captures the foreground window, or the external window before Voice
when Voice is in front. Its app-local numeric handle is kept through shown/whole reads and paste.
Wire `target` is `{window, pid}`: HWND on Windows; an instance-scoped UUID for a retained AX window
on macOS; GNOME's window id plus AT-SPI `bus` and `path` on Linux. Rust validates these fields.
The native helpers answer `captureTarget`. GNOME integration version 4 adds `Target` and `Activate`;
its window is raised through `Main.activateWindow`. macOS additionally uses `preparePaste`,
`pasteTarget`, `cancelPaste` and `finishPaste` (ADR-DESK-053). Helpers always verify the target before
sending paste keys.
