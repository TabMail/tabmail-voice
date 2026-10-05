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
    emit(name, ...args) { return [...this.callbacks.values()].filter(item => item.name === name).map(item => item.callback(this, ...args)); }
}
const KEY = {space: 0x20, Escape: 0xff1b, Alt_R: 0xffea, Meta_R: 0xffe8, a: 0x61};
const FLAG_REPEATED = 8;
async function fixture(failExport = false) {
    const window = Object.assign(new Signals(), {get_frame_rect: () => ({x: 100, y: 100, width: 500, height: 400}),
        get_client_content_rect: () => ({x: 110, y: 140, width: 480, height: 350})});
    const theme = {scale_factor: 1};
    const display = Object.assign(new Signals(), {focus_window: window});
    const inputMethod = Object.assign(new Signals(), {currentFocus: {}});
    const overview = Object.assign(new Signals(), {visible: false});
    const sessionMode = Object.assign(new Signals(), {isLocked: false});
    const ibus = new Signals();
    let exported = false;
    let exportXML, exportPath;
    const grabs = new Map(), allowed = new Map(), actions = [];
    let lostOwner = null, failKey = null, nextGrab = 100, revokeAtOnce = false;
    // The Shell's modal stack: the keyboard hold pushes one, and nothing else does here.
    const modals = [], added = [];
    class Actor extends Signals {
        constructor(props) { super(); Object.assign(this, props); this.destroyed = false; }
        destroy() { this.destroyed = true; }
    }
    display.grab_accelerator = key => {
        if (key === failKey) return 0;
        const id = ++nextGrab; grabs.set(id, key); return id;
    };
    display.ungrab_accelerator = id => assert.ok(grabs.delete(id));
    const context = vm.createContext({global: {display, stage: {}}});
    const dependencies = {
        'gi://GLib': {default: {Variant: class {constructor(type, value) {this.type = type; this.value = value;}}}},
        'gi://Clutter': {default: {Actor, EventFlags: {FLAG_REPEATED}, EVENT_STOP: true,
            KEY_space: KEY.space, KEY_Escape: KEY.Escape, KEY_Alt_R: KEY.Alt_R, KEY_Meta_R: KEY.Meta_R}},
        'gi://Meta': {default: {KeyBindingFlags: {IGNORE_AUTOREPEAT: 1}, external_binding_name_for_action: id => String(id)}},
        'gi://Shell': {default: {ActionMode: {NORMAL: 1, NONE: 0}}},
        'gi://St': {default: {ThemeContext: {get_for_stage: () => theme}}},
        'gi://Gio': {default: {BusNameWatcherFlags: {NONE: 0},
            bus_watch_name_on_connection(_bus, _name, _flags, _appeared, vanished) {lostOwner = vanished; return 1;},
            bus_unwatch_name() {lostOwner = null;},
            DBus: {session: {emit_signal: (...args) => actions.push(args)}}, DBusExportedObject: {wrapJSObject: xml => { exportXML = xml; return ({
            export(_bus, path) { exportPath = path; if (failExport) throw new Error("synthetic export failure"); exported = true; }, unexport() { exported = false; },
        }); }}}},
        'resource:///org/gnome/shell/extensions/extension.js': {Extension: class {}},
        'resource:///org/gnome/shell/ui/main.js': {inputMethod, overview, sessionMode, wm: {allowKeybinding: (id, mode) => allowed.set(id, mode)},
            layoutManager: {uiGroup: {add_child: actor => added.push(actor)}},
            pushModal(actor, params) {
                const grab = Object.assign(new Signals(), {revoked: revokeAtOnce, is_revoked() { return this.revoked; }});
                modals.push({actor, params, grab});
                return grab;
            },
            popModal(grab) { assert.equal(modals.pop()?.grab, grab, 'the hold pops its own modal'); }},
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
    else {
        extension.enable();
        // Enabling tells every helper, not one, that the keys can be asked for.
        assert.deepEqual(actions.map(([destination, , , , value]) => [destination, value.value[0]]), [[null, 'ready']]);
        actions.length = 0;
    }
    const caret = (x = 200, y = 200) => inputMethod.emit('cursor-location-changed', {origin: {x, y}, size: {width: 0, height: 20}});
    const recording = (active, owner = ':1.42') => {
        let result;
        extension.SetRecordingAsync([active], {get_sender: () => owner, return_value: value => {result = value.value[0];}});
        return result;
    };
    const hotkey = (active, owner = ':1.42') => {
        let result;
        extension.SetHotkeyAsync([active], {get_sender: () => owner, return_value: value => {result = value.value[0];}});
        return result;
    };
    // A key event to the actor holding the keyboard; what its handlers returned.
    const key = (type, symbol, repeated = false) => modals.at(-1).actor.emit(`key-${type}-event`,
        {get_key_symbol: () => symbol, get_flags: () => (repeated ? FLAG_REPEATED : 0)});
    const chat = (open, owner = ':1.42') => {
        let result;
        extension.SetChatOpenAsync([open], {get_sender: () => owner, return_value: value => {result = value.value[0];}});
        return result;
    };
    return {theme, recording, chat, hotkey, key, modals, added, revokeAtOnce: value => {revokeAtOnce = value;}, grabs, allowed, actions, disconnectOwner: () => lostOwner(), failGrab: key => {failKey = key;}, extension, display, window, inputMethod, overview, sessionMode, ibus, caret, exported: () => exported, protocol: () => ({xml: exportXML, path: exportPath})};
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

test('a window-relative caret is placed in the focused window\'s content, scaled, and refused outside it', async () => {
    const f = await fixture();
    assert.deepEqual(JSON.parse(f.extension.FromWindow(30, 40, 0, 18)), {x: 140, y: 180, width: 1, height: 18, source: 'accessibility'});
    f.theme.scale_factor = 2;
    assert.deepEqual(JSON.parse(f.extension.FromWindow(30, 40, 2, 18)), {x: 170, y: 220, width: 4, height: 36, source: 'accessibility'});
    f.theme.scale_factor = 1;
    for (const outside of [[-1, 40, 1, 18], [30, -1, 1, 18], [480, 40, 1, 18], [30, 340, 1, 18]])
        assert.equal(f.extension.FromWindow(...outside), 'null', String(outside));
    for (const invalid of [[NaN, 40, 1, 18], [30, 40, -1, 18], [30, 40, 1, 0], [30, Infinity, 1, 18]])
        assert.equal(f.extension.FromWindow(...invalid), 'null', String(invalid));
    f.overview.visible = true; assert.equal(f.extension.FromWindow(30, 40, 1, 18), 'null'); f.overview.visible = false;
    f.sessionMode.isLocked = true; assert.equal(f.extension.FromWindow(30, 40, 1, 18), 'null'); f.sessionMode.isLocked = false;
    f.display.focus_window = null; assert.equal(f.extension.FromWindow(30, 40, 1, 18), 'null');
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
    assert.match(xml, /<method name="FromWindow"><arg type="d" direction="in"\/><arg type="d" direction="in"\/><arg type="d" direction="in"\/><arg type="d" direction="in"\/><arg type="s" direction="out"\/><\/method>/);
    assert.match(xml, /<signal name="Action"><arg type="s"\/><\/signal>/);
    assert.equal(f.extension.Version(), 1);
    assert.equal(f.recording(true), true);
    f.display.emit('accelerator-activated', [...f.grabs.keys()][0]);
    assert.deepEqual(f.actions[0].slice(0, 4), [':1.42', path, 'ai.tabmail.Voice.Caret', 'Action']);
    assert.equal(f.actions[0][4].type, '(s)');
    assert.equal(f.actions[0][4].value[0], 'toggleMode');
    f.extension.disable();
});

const sent = f => f.actions.map(([destination, , , , value]) => `${destination} ${value.value[0]}`);
const grabOf = (f, key) => [...f.grabs].find(([, name]) => name === key)?.[0];
const RIGHT_ALT = ['Alt_R', '<Shift>Alt_R', '<Alt>Alt_R', '<Shift><Alt>Alt_R'];

test('Right Alt held takes the whole keyboard: Space switches mode, Escape cancels, the rest is swallowed, its release ends the hold', async () => {
    const f = await fixture();
    f.caret();
    assert.equal(f.hotkey(true), true);
    assert.deepEqual([...f.grabs.values()], RIGHT_ALT);
    assert.ok([...f.allowed.values()].every(mode => mode === 1));
    assert.equal(f.extension.Holding(), false);
    f.display.emit('accelerator-activated', grabOf(f, 'Alt_R'));
    assert.deepEqual(sent(f), [':1.42 hotkeyDown']);
    assert.equal(f.modals.length, 1);
    assert.equal(f.modals[0].params.actionMode, 0, 'no Shell keybinding runs during the hold');
    assert.deepEqual(f.added, [f.modals[0].actor]);
    assert.equal(f.modals[0].actor.reactive, true);
    assert.equal(f.extension.Holding(), true);
    // The app in front lost its keyboard focus to the hold: the caret read as the key went down stays.
    f.inputMethod.currentFocus = null;
    assert.equal(JSON.parse(f.extension.Read()).x, 200);
    f.display.emit('accelerator-activated', grabOf(f, 'Alt_R'));
    assert.equal(f.modals.length, 1, 'one hold');
    assert.deepEqual(f.key('press', KEY.space), [true]);
    assert.deepEqual(f.key('press', KEY.space, true), [true], 'a held Space repeats nothing');
    assert.deepEqual(f.key('release', KEY.space), [true]);
    assert.deepEqual(f.key('press', KEY.a), [true], 'another key reaches no app');
    assert.deepEqual(f.key('release', KEY.a), [true]);
    assert.deepEqual(sent(f), [':1.42 hotkeyDown', ':1.42 toggleMode']);
    assert.deepEqual(f.key('release', KEY.Alt_R), [true]);
    assert.deepEqual(sent(f).slice(2), [':1.42 hotkeyUp']);
    assert.equal(f.modals.length, 0);
    assert.ok(f.added[0].destroyed);
    assert.equal(f.extension.Holding(), false);
    assert.equal(f.extension.Read(), 'null', 'after the hold the caret is read live again');
    f.extension.disable();
});

test('Shift with Right Alt is agent mode, and its release (Meta_R with Shift down) ends the hold', async () => {
    const f = await fixture();
    f.hotkey(true);
    f.display.emit('accelerator-activated', grabOf(f, '<Shift>Alt_R'));
    f.key('release', KEY.Meta_R);
    assert.deepEqual(sent(f), [':1.42 hotkeyAgentDown', ':1.42 hotkeyUp']);
    // A latched Alt (Sticky Keys) is on the next press: it still starts a hold.
    f.display.emit('accelerator-activated', grabOf(f, '<Alt>Alt_R'));
    f.key('release', KEY.Alt_R);
    f.display.emit('accelerator-activated', grabOf(f, '<Shift><Alt>Alt_R'));
    f.key('release', KEY.Alt_R);
    assert.deepEqual(sent(f).slice(2), [':1.42 hotkeyDown', ':1.42 hotkeyUp', ':1.42 hotkeyAgentDown', ':1.42 hotkeyUp']);
    assert.equal(f.modals.length, 0);
    assert.equal(f.hotkey(false, ':1.99'), false, 'another client cannot release it');
    assert.equal(f.hotkey(false), true);
    assert.equal(f.grabs.size, 0);
    assert.equal(f.hotkey(true, ':1.99'), true, 'released, it is anyone\'s again');
    f.extension.disable();
});

test('Escape during the hold cancels and lets go of the recording keys; the hold lasts until Right Alt is up', async () => {
    const f = await fixture();
    f.hotkey(true);
    f.display.emit('accelerator-activated', grabOf(f, 'Alt_R'));
    assert.equal(f.recording(true), true);
    assert.equal(f.chat(true), true);
    f.key('press', KEY.Escape);
    assert.deepEqual(sent(f), [':1.42 hotkeyDown', ':1.42 cancel']);
    assert.deepEqual([...f.grabs.values()], RIGHT_ALT, 'the recording keys and the chat\'s Escape are let go');
    assert.equal(f.modals.length, 1);
    f.key('release', KEY.Alt_R);
    assert.deepEqual(sent(f).slice(2), [':1.42 hotkeyUp']);
    f.extension.disable();
});

test('a keyboard the Shell cannot give leaves the press doing nothing; a grab over the hold ends it', async () => {
    const f = await fixture();
    f.hotkey(true);
    f.revokeAtOnce(true);
    f.display.emit('accelerator-activated', grabOf(f, 'Alt_R'));
    assert.deepEqual(sent(f), []);
    assert.equal(f.modals.length, 0);
    assert.ok(f.added[0].destroyed);
    assert.equal(f.extension.Holding(), false);
    f.revokeAtOnce(false);
    f.display.emit('accelerator-activated', grabOf(f, 'Alt_R'));
    // A system dialog takes the keys over the hold, Right Alt's release among them.
    f.modals[0].grab.emit('notify::revoked');
    assert.deepEqual(sent(f), [':1.42 hotkeyDown', ':1.42 hotkeyUp']);
    assert.equal(f.modals.length, 0);
    f.extension.disable();
});

test('the dictation key outlives each dictation, its Escape and its chat', async () => {
    const f = await fixture();
    f.hotkey(true);
    assert.equal(f.recording(true), true);
    assert.deepEqual([...f.grabs.values()].sort(), [...RIGHT_ALT, 'Escape', 'space'].sort());
    f.display.emit('accelerator-activated', grabOf(f, 'Escape'));
    assert.deepEqual(sent(f), [':1.42 cancel']);
    assert.deepEqual([...f.grabs.values()], RIGHT_ALT);
    f.chat(true); f.recording(true); f.recording(false); f.chat(false);
    assert.deepEqual([...f.grabs.values()], RIGHT_ALT);
    f.failGrab('space');
    assert.equal(f.recording(true), false);
    assert.deepEqual([...f.grabs.values()], RIGHT_ALT, 'a recording key that cannot be had leaves the dictation key');
    assert.deepEqual(sent(f).slice(1), [], 'only the dictation key says it is unavailable');
    f.failGrab(null);
    assert.equal(f.recording(true), true);
    f.extension.disable();
});

test('a dictation key that cannot be had keeps the keys already held, and the helper is told why', async () => {
    const f = await fixture();
    f.recording(true);
    // Right Alt is AltGr on this layout: the Shell has no Alt_R key to hold.
    f.failGrab('Alt_R');
    assert.equal(f.hotkey(true), false);
    assert.deepEqual([...f.grabs.values()], ['space', 'Escape']);
    assert.deepEqual(sent(f), [':1.42 hotkeyUnavailable']);
    f.failGrab('<Shift>Alt_R');
    assert.equal(f.hotkey(true, ':1.99'), false, 'another client is refused without a reason');
    assert.deepEqual(sent(f), [':1.42 hotkeyUnavailable']);
    f.extension.disable();
});

test('a lock, a lost helper or disabling ends a hold; unlocking asks helpers again', async () => {
    const f = await fixture();
    f.hotkey(true);
    f.display.emit('accelerator-activated', grabOf(f, 'Alt_R'));
    f.sessionMode.isLocked = true; f.sessionMode.emit('updated');
    assert.deepEqual(sent(f), [':1.42 hotkeyDown', ':1.42 hotkeyUp']);
    assert.equal(f.modals.length, 0);
    assert.equal(f.grabs.size, 0);
    assert.equal(f.hotkey(true), false);
    f.sessionMode.isLocked = false; f.sessionMode.emit('updated');
    assert.deepEqual(sent(f).slice(2), ['null ready']);
    assert.equal(f.hotkey(true), true);
    f.display.emit('accelerator-activated', grabOf(f, 'Alt_R'));
    f.disconnectOwner();
    assert.equal(f.modals.length, 0);
    assert.equal(f.grabs.size, 0);
    f.hotkey(true);
    f.display.emit('accelerator-activated', grabOf(f, 'Alt_R'));
    f.extension.disable();
    assert.equal(f.modals.length, 0);
    assert.equal(f.grabs.size, 0);
    assert.deepEqual(sent(f).slice(-1), [':1.42 hotkeyUp']);
});
