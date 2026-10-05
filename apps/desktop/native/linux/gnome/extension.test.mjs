import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./voice-caret@tabmail.ai/extension.js', import.meta.url), 'utf8');
class Signals {
    callbacks = new Map();
    next = 0;
    connect(name, callback) { const id = ++this.next; this.callbacks.set(id, {name, callback}); return id; }
    disconnect(id) { assert.ok(this.callbacks.delete(id)); }
    emit(name, ...args) { for (const item of this.callbacks.values()) if (item.name === name) item.callback(this, ...args); }
}
async function fixture(failExport = false) {
    const window = Object.assign(new Signals(), {get_frame_rect: () => ({x: 100, y: 100, width: 500, height: 400})});
    const display = Object.assign(new Signals(), {focus_window: window});
    const inputMethod = Object.assign(new Signals(), {currentFocus: {}});
    const overview = Object.assign(new Signals(), {visible: false});
    const sessionMode = Object.assign(new Signals(), {isLocked: false});
    const ibus = new Signals();
    let exported = false;
    let exportXML, exportPath;
    const grabs = new Map(), allowed = new Map(), actions = [];
    let lostOwner = null, failKey = null, nextGrab = 100;
    display.grab_accelerator = key => {
        if (key === failKey) return 0;
        const id = ++nextGrab; grabs.set(id, key); return id;
    };
    display.ungrab_accelerator = id => assert.ok(grabs.delete(id));
    const context = vm.createContext({global: {display}});
    const dependencies = {
        'gi://GLib': {default: {Variant: class {constructor(type, value) {this.type = type; this.value = value;}}}},
        'gi://Meta': {default: {KeyBindingFlags: {IGNORE_AUTOREPEAT: 1}, external_binding_name_for_action: id => String(id)}},
        'gi://Shell': {default: {ActionMode: {NORMAL: 1, NONE: 0}}},
        'gi://Gio': {default: {BusNameWatcherFlags: {NONE: 0},
            bus_watch_name_on_connection(_bus, _name, _flags, _appeared, vanished) {lostOwner = vanished; return 1;},
            bus_unwatch_name() {lostOwner = null;},
            DBus: {session: {emit_signal: (...args) => actions.push(args)}}, DBusExportedObject: {wrapJSObject: xml => { exportXML = xml; return ({
            export(_bus, path) { exportPath = path; if (failExport) throw new Error("synthetic export failure"); exported = true; }, unexport() { exported = false; },
        }); }}}},
        'resource:///org/gnome/shell/extensions/extension.js': {Extension: class {}},
        'resource:///org/gnome/shell/ui/main.js': {inputMethod, overview, sessionMode, wm: {allowKeybinding: (id, mode) => allowed.set(id, mode)}},
        'resource:///org/gnome/shell/misc/ibusManager.js': {getIBusManager: () => ibus},
    };
    const module = new vm.SourceTextModule(source, {context});
    await module.link(name => {
        const exports = dependencies[name];
        assert.ok(exports, name);
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, {context});
    });
    await module.evaluate();
    const extension = new module.namespace.default();
    if (failExport) assert.throws(() => extension.enable(), /synthetic export failure/);
    else extension.enable();
    const caret = (x = 200, y = 200) => inputMethod.emit('cursor-location-changed', {origin: {x, y}, size: {width: 0, height: 20}});
    const recording = (active, owner = ':1.42') => {
        let result;
        extension.SetRecordingAsync([active], {get_sender: () => owner, return_value: value => {result = value.value[0];}});
        return result;
    };
    const chat = (open, owner = ':1.42') => {
        let result;
        extension.SetChatOpenAsync([open], {get_sender: () => owner, return_value: value => {result = value.value[0];}});
        return result;
    };
    return {recording, chat, grabs, allowed, actions, disconnectOwner: () => lostOwner(), failGrab: key => {failKey = key;}, extension, display, window, inputMethod, overview, sessionMode, ibus, caret, exported: () => exported, protocol: () => ({xml: exportXML, path: exportPath})};
}

test('Wayland caret survives delayed IBus focus-out and follows the new field', async () => {
    const f = await fixture();
    assert.equal(f.extension.Read(), 'null');
    f.caret();
    f.ibus.emit('focus-out');
    assert.deepEqual(JSON.parse(f.extension.Read()), {x: 200, y: 200, width: 1, height: 20, source: 'wayland'});
    f.caret(300, 250);
    f.ibus.emit('focus-out');
    assert.equal(JSON.parse(f.extension.Read()).x, 300);
    f.inputMethod.currentFocus = null;
    assert.equal(f.extension.Read(), 'null');
    f.inputMethod.currentFocus = {};
    assert.equal(f.extension.Read(), 'null');
    f.extension.disable();
});

test('X11 IBus coordinates only apply without a Wayland focus and clear on focus-out', async () => {
    const f = await fixture();
    const rect = {x: 250, y: 210, width: 1, height: 20};
    f.ibus.emit('set-cursor-location', rect);
    assert.equal(f.extension.Read(), 'null');
    f.inputMethod.currentFocus = null;
    f.ibus.emit('set-cursor-location', rect);
    assert.deepEqual(JSON.parse(f.extension.Read()), {...rect, source: 'x11'});
    f.inputMethod.currentFocus = {};
    assert.equal(f.extension.Read(), 'null');
    f.inputMethod.currentFocus = null;
    f.ibus.emit('focus-out');
    assert.equal(f.extension.Read(), 'null');
    f.extension.disable();
});

test('window changes, overview, lock, invalid coordinates and disable invalidate geometry', async () => {
    const f = await fixture();
    for (const name of ['position-changed', 'size-changed', 'unmanaged']) {
        f.caret(); f.window.emit(name); assert.equal(f.extension.Read(), 'null');
    }
    for (const point of [[NaN, 200], [Infinity, 200], [99, 200], [600, 200], [200, 490]]) {
        f.caret(...point); assert.equal(f.extension.Read(), 'null');
    }
    f.caret(); f.overview.visible = true; assert.equal(f.extension.Read(), 'null');
    f.overview.emit('showing'); f.overview.visible = false; assert.equal(f.extension.Read(), 'null');
    f.caret(); f.sessionMode.isLocked = true; assert.equal(f.extension.Read(), 'null');
    f.sessionMode.emit('updated');
    f.sessionMode.isLocked = false;
    assert.equal(f.extension.Read(), 'null');
    f.display.focus_window = null; f.display.emit('notify::focus-window');
    f.caret(); assert.equal(f.extension.Read(), 'null');
    assert.equal(f.window.callbacks.size, 0);
    assert.ok(f.exported());
    f.extension.disable();
    assert.equal(f.exported(), false);
    for (const object of [f.display, f.inputMethod, f.overview, f.ibus, f.sessionMode]) assert.equal(object.callbacks.size, 0);
});


test('partial enable failure disconnects all listeners and allows retry', async () => {
    const f = await fixture(true);
    assert.equal(f.exported(), false);
    assert.equal(f.extension.Read(), 'null');
    for (const object of [f.display, f.inputMethod, f.overview, f.ibus, f.sessionMode, f.window]) assert.equal(object.callbacks.size, 0);
    assert.throws(() => f.extension.enable(), /synthetic export failure/);
    for (const object of [f.display, f.inputMethod, f.overview, f.ibus, f.sessionMode, f.window]) assert.equal(object.callbacks.size, 0);
    f.extension.disable();
});


test('an empty input-method rectangle is unavailable, not a caret at the window origin', async () => {
    const f = await fixture();
    f.caret();
    f.inputMethod.emit('cursor-location-changed', {origin: {x: 100, y: 100}, size: {width: 0, height: 0}});
    assert.equal(f.extension.Read(), 'null');
    f.caret();
    assert.equal(JSON.parse(f.extension.Read()).height, 20);
    f.extension.disable();
});


test('recording grabs are scoped to owner and disappear on end, disconnect, lock and disable', async () => {
    const f = await fixture();
    assert.equal(f.grabs.size, 0);
    assert.equal(f.recording(true), true);
    assert.deepEqual([...f.grabs.values()], ['space', 'Escape']);
    assert.equal(f.recording(true), true);
    assert.equal(f.grabs.size, 2);
    assert.equal(f.recording(false, ':1.99'), false);
    const space = [...f.grabs.keys()][0];
    f.display.emit('accelerator-activated', space);
    assert.equal(f.actions[0][0], ':1.42');
    assert.equal(f.actions[0][4].value[0], 'toggleMode');
    assert.equal(f.recording(false), true);
    assert.equal(f.grabs.size, 0);
    f.display.emit('accelerator-activated', space);
    assert.equal(f.actions.length, 1);
    f.recording(true); f.disconnectOwner(); assert.equal(f.grabs.size, 0);
    f.recording(true); f.sessionMode.isLocked = true; f.sessionMode.emit('updated');
    assert.equal(f.grabs.size, 0);
    assert.equal(f.recording(true), false);
    f.sessionMode.isLocked = false;
    f.recording(true); f.extension.disable(); assert.equal(f.grabs.size, 0);
    assert.ok([...f.allowed.values()].every(mode => mode === 0));
});

test('Escape releases grabs immediately and a partial grab failure rolls back', async () => {
    const f = await fixture();
    f.failGrab('Escape');
    assert.equal(f.recording(true), false);
    assert.equal(f.grabs.size, 0);
    f.failGrab(null); assert.equal(f.recording(true), true);
    f.display.emit('accelerator-activated', [...f.grabs.keys()][1]);
    assert.equal(f.actions[0][4].value[0], 'cancel');
    assert.equal(f.grabs.size, 0);
    f.extension.disable();
});

test('an open chat window keeps Escape alone, through a dictation, until it closes', async () => {
    const f = await fixture();
    assert.equal(f.chat(true), true);
    assert.deepEqual([...f.grabs.values()], ['Escape'], 'Space reaches the app in front');
    assert.equal(f.chat(false, ':1.99'), false, 'another client cannot release it');
    assert.equal(f.recording(true), true);
    assert.deepEqual([...f.grabs.values()].sort(), ['Escape', 'space']);
    assert.equal(f.recording(false), true);
    assert.deepEqual([...f.grabs.values()], ['Escape'], 'the dictation ending leaves the chat its Escape');
    f.display.emit('accelerator-activated', [...f.grabs.keys()][0]);
    assert.equal(f.actions[0][4].value[0], 'cancel');
    assert.equal(f.grabs.size, 0);
    assert.equal(f.chat(true), true);
    assert.equal(f.chat(false), true);
    assert.equal(f.grabs.size, 0);
    assert.equal(f.chat(true, ':1.99'), true, 'released, it is anyone\'s again');
    f.sessionMode.isLocked = true; f.sessionMode.emit('updated');
    assert.equal(f.grabs.size, 0);
    assert.equal(f.chat(true), false);
    f.extension.disable();
});

test('exported protocol matches the native GNOME peer and unicast Action envelope', async () => {
    const f = await fixture();
    const {xml, path} = f.protocol();
    assert.equal(path, '/ai/tabmail/Voice/Caret');
    assert.match(xml, /<interface name="ai\.tabmail\.Voice\.Caret">/);
    assert.match(xml, /<method name="Version"><arg type="u" direction="out"\/><\/method>/);
    assert.match(xml, /<method name="Read"><arg type="s" direction="out"\/><\/method>/);
    assert.match(xml, /<method name="SetRecording"><arg type="b" direction="in"\/><arg type="b" direction="out"\/><\/method>/);
    assert.match(xml, /<method name="SetChatOpen"><arg type="b" direction="in"\/><arg type="b" direction="out"\/><\/method>/);
    assert.match(xml, /<signal name="Action"><arg type="s"\/><\/signal>/);
    assert.equal(f.extension.Version(), 1);
    assert.equal(f.recording(true), true);
    f.display.emit('accelerator-activated', [...f.grabs.keys()][0]);
    assert.deepEqual(f.actions[0].slice(0, 4), [':1.42', path, 'ai.tabmail.Voice.Caret', 'Action']);
    assert.equal(f.actions[0][4].type, '(s)');
    assert.equal(f.actions[0][4].value[0], 'toggleMode');
    f.extension.disable();
});
