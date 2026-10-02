# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Owned native Wayland test app. Its pipe controls only synthetic fixture widgets."""
import gi
import json
import os
import sys
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, GLib

class Fixture(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=f"ai.tabmail.voice.fixture.p{os.getpid()}")

    def do_activate(self):
        window = Gtk.ApplicationWindow(application=self, title="Synthetic screen fixture")
        window.set_default_size(600, 350)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        box.set_margin_start(32)
        box.set_margin_end(32)
        box.set_margin_top(32)
        self.entry = Gtk.Entry()
        self.entry.set_text("Synthetic field content")
        self.password = Gtk.PasswordEntry()
        self.password.set_text("synthetic-password-must-not-be-read")
        box.append(Gtk.Label(label="Synthetic visible heading"))
        box.append(self.entry)
        box.append(self.password)
        window.set_child(box)
        window.present()
        GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, self.command)
        GLib.timeout_add(300, self.ready)

    def ready(self):
        self.entry.grab_focus()
        self.entry.set_position(-1)
        print(json.dumps({"ready": True}), flush=True)
        return False

    def command(self, stream, condition):
        if condition & GLib.IO_HUP:
            self.quit()
            return False
        command = json.loads(stream.readline())
        if command["kind"] == "password":
            self.password.grab_focus()
        elif command["kind"] == "entry":
            self.entry.grab_focus()
            if "text" in command:
                self.entry.set_text(command["text"])
            self.entry.set_position(-1)
        elif command["kind"] == "select":
            self.entry.grab_focus()
            self.entry.select_region(command["from"], command["to"])
        print(json.dumps({"done": command["kind"]}), flush=True)
        return True

Fixture().run(None)
