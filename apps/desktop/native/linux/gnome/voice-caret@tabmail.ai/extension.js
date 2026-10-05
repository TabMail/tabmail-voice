// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as IBusManager from 'resource:///org/gnome/shell/misc/ibusManager.js';

const IFACE = `<node><interface name="ai.tabmail.Voice.Caret">
<method name="Read"><arg type="s" direction="out"/></method>
<method name="FromWindow"><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="s" direction="out"/></method>
<method name="Version"><arg type="u" direction="out"/></method>
<method name="SetRecording"><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
<method name="SetChatOpen"><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
<signal name="Action"><arg type="s"/></signal>
</interface></node>`;

/** Compositor geometry and temporary dictation shortcuts; no text or rendering.
 * Signal sources are the same as GNOME 50's on-screen keyboard FocusTracker.
 * https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/gnome-50/js/ui/keyboard.js
 */
export default class VoiceCaret extends Extension {
    enable() {
        try { this._enable(); } catch (error) { this.disable(); throw error; }
    }

    _enable() {
        this._signals = [];
        this._windowSignals = [];
        this._rect = null;
        this._window = null;
        this._grabs = [];
        this._wanted = {recording: false, chat: false};
        const listen = (object, signal, callback) => {
            this._signals.push([object, object.connect(signal, callback)]);
        };
        listen(global.display, 'notify::focus-window', () => this._focusChanged());
        listen(Main.overview, 'showing', () => { this._rect = null; });
        listen(Main.sessionMode, 'updated', () => {
            this._rect = null; this._focus = null;
            if (Main.sessionMode.isLocked) this._releaseRecording();
        });
        listen(global.display, 'accelerator-activated', (_display, id) => {
            const action = this._grabs.find(item => item.id === id)?.action;
            if (!action || !this._owner || Main.sessionMode.isLocked) return;
            Gio.DBus.session.emit_signal(this._owner, '/ai/tabmail/Voice/Caret',
                'ai.tabmail.Voice.Caret', 'Action', new GLib.Variant('(s)', [action]));
            if (action === 'cancel') this._releaseRecording();
        });
        listen(Main.inputMethod, 'cursor-location-changed', (_source, rect) => {
            this._accept({x: rect.origin.x, y: rect.origin.y,
                width: rect.size.width, height: rect.size.height}, 'wayland');
        });
        const ibus = IBusManager.getIBusManager();
        listen(ibus, 'set-cursor-location', (_source, rect) => {
            if (!Main.inputMethod.currentFocus)
                this._accept(rect, 'x11');
        });
        // IBus delivers focus-out asynchronously, after the new Wayland caret.
        // It owns X11 focus only; currentFocus identifies Wayland's live surface.
        listen(ibus, 'focus-out', () => {
            if (!Main.inputMethod.currentFocus) this._rect = null;
        });
        this._focusChanged();
        this._export = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._export.export(Gio.DBus.session, '/ai/tabmail/Voice/Caret');
        // GNOME Shell's existing session-bus name owns the exported object.
    }

    _focusChanged() {
        for (const [object, id] of this._windowSignals)
            object.disconnect(id);
        this._windowSignals = [];
        this._rect = null;
        this._window = global.display.focus_window;
        if (this._window) {
            for (const signal of ['position-changed', 'size-changed', 'unmanaged']) {
                const object = this._window;
                this._windowSignals.push([object, object.connect(signal, () => { this._rect = null; })]);
            }
        }
    }

    _accept(rect, source) {
        this._rect = null;
        if (!this._window || Main.overview.visible || Main.sessionMode.isLocked ||
            (source === 'wayland' && !Main.inputMethod.currentFocus))
            return;
        const values = [rect.x, rect.y, rect.width, rect.height];
        if (!values.every(Number.isFinite) || rect.width < 0 || rect.height <= 0)
            return;
        const bounds = this._window.get_frame_rect();
        // A zero-width caret is normal; a zero-height rectangle is an unset cursor.
        const width = Math.max(1, rect.width), height = rect.height;
        if (rect.x < bounds.x || rect.y < bounds.y ||
            rect.x + width > bounds.x + bounds.width || rect.y + height > bounds.y + bounds.height)
            return;
        this._rect = {x: rect.x, y: rect.y, width, height, source};
        this._focus = source === 'wayland' ? Main.inputMethod.currentFocus : null;
    }

    Read() {
        if (!this._rect || this._window !== global.display.focus_window ||
            Main.overview.visible || Main.sessionMode.isLocked ||
            (this._rect.source === 'wayland' && (!this._focus || this._focus !== Main.inputMethod.currentFocus)) ||
            (this._rect.source === 'x11' && Main.inputMethod.currentFocus))
            return 'null';
        return JSON.stringify(this._rect);
    }

    /** A caret the focused window's accessible reports in window coordinates, on the screen,
     * converted as GNOME Shell's magnifier converts it (js/ui/magnifier.js). Wayland gives
     * accessibility no screen coordinates, and some apps' input-method rectangle isn't
     * their caret (LibreOffice reports the start of the sentence). */
    FromWindow(x, y, width, height) {
        const window = global.display.focus_window;
        if (!window || Main.overview.visible || Main.sessionMode.isLocked ||
            ![x, y, width, height].every(Number.isFinite) || width < 0 || height <= 0)
            return 'null';
        const content = window.get_client_content_rect();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const rect = {x: content.x + scale * x, y: content.y + scale * y,
            width: scale * Math.max(1, width), height: scale * height};
        if (rect.x < content.x || rect.y < content.y ||
            rect.x + rect.width > content.x + content.width || rect.y + rect.height > content.y + content.height)
            return 'null';
        return JSON.stringify({...rect, source: 'accessibility'});
    }

    Version() { return 1; }

    /** Space and Escape while dictating. */
    SetRecordingAsync([active], invocation) {
        invocation.return_value(new GLib.Variant('(b)', [this._want(invocation.get_sender(), 'recording', active)]));
    }

    /** Escape while the chat window is open: the app shows it without taking the keyboard. */
    SetChatOpenAsync([open], invocation) {
        invocation.return_value(new GLib.Variant('(b)', [this._want(invocation.get_sender(), 'chat', open)]));
    }

    _want(owner, kind, active) {
        // Only the client that acquired the session may change it. A second
        // helper cannot replace a live owner's shortcuts.
        if (this._owner && this._owner !== owner)
            return false;
        if (active && Main.sessionMode.isLocked)
            return false;
        this._wanted = {...this._wanted, [kind]: active};
        const keys = [];
        if (this._wanted.recording) keys.push(['space', 'toggleMode']);
        if (this._wanted.recording || this._wanted.chat) keys.push(['Escape', 'cancel']);
        if (!keys.length) {
            this._releaseRecording();
            return true;
        }
        try {
            if (!this._owner) {
                this._owner = owner;
                this._ownerWatch = Gio.bus_watch_name_on_connection(Gio.DBus.session,
                    owner, Gio.BusNameWatcherFlags.NONE, null, () => this._releaseRecording());
            }
            for (const grab of this._grabs.filter(item => !keys.some(([key]) => key === item.key)))
                this._ungrab(grab);
            this._grabs = this._grabs.filter(item => keys.some(([key]) => key === item.key));
            for (const [key, action] of keys) {
                if (this._grabs.some(item => item.key === key)) continue;
                const id = global.display.grab_accelerator(key, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
                if (!id) throw new Error(`Cannot acquire ${key}`);
                this._grabs.push({id, key, action});
                Main.wm.allowKeybinding(Meta.external_binding_name_for_action(id), Shell.ActionMode.NORMAL);
            }
        } catch {
            this._releaseRecording();
        }
        return Boolean(this._owner) && (this._wanted[kind] || !active);
    }

    _ungrab({id}) {
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(id), Shell.ActionMode.NONE);
        global.display.ungrab_accelerator(id);
    }

    _releaseRecording() {
        for (const grab of this._grabs ?? [])
            this._ungrab(grab);
        this._grabs = [];
        this._wanted = {recording: false, chat: false};
        if (this._ownerWatch) Gio.bus_unwatch_name(this._ownerWatch);
        this._ownerWatch = 0;
        this._owner = null;
    }

    disable() {
        this._releaseRecording();
        this._export?.unexport();
        this._export = null;
        for (const [object, id] of [...(this._signals ?? []), ...(this._windowSignals ?? [])])
            object.disconnect(id);
        this._signals = [];
        this._windowSignals = [];
        this._window = null;
        this._rect = null;
        this._focus = null;
    }
}
