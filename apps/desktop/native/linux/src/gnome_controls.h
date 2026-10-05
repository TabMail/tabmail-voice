// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "accessibility.h"
#include "channel.h"
#include "output.h"

namespace voice {
// The portal owns F8 and F9. The Shell extension owns Right Alt, when that is the
// dictation key, and the temporary recording keys, and releases them all when this
// bus client disappears.
class GnomeControls {
    Object<GDBusConnection> bus;
    Object<GCancellable> cancel = own(g_cancellable_new());
    Output& output;
    Gesture& gesture;
    guint signal = 0;
    bool recording = false, chat = false;
    // Right Alt: wanted, held by the Shell for this helper, and down.
    bool hotkey = false, hotkeyInstalled = false, hotkeyDown = false;
    uint64_t hotkeyGeneration = 0;
    static constexpr const char* path = "/ai/tabmail/Voice/Caret";
    static constexpr const char* interface = "ai.tabmail.Voice.Caret";
public:
    GnomeControls(Output& output, Gesture& gesture) : output(output), gesture(gesture) {
        Error error;
        bus = own(g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error.value));
        if (!bus) return;
        signal = g_dbus_connection_signal_subscribe(bus.get(), "org.gnome.Shell", interface,
            "Action", path, nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
            [](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*, GVariant* value, gpointer data) {
                auto self = static_cast<GnomeControls*>(data);
                if (!g_variant_is_of_type(value, G_VARIANT_TYPE("(s)"))) return;
                const char* action; g_variant_get(value, "(&s)", &action);
                const std::string name = action;
                // Announced to every helper when the Shell enables the extension or
                // unlocks: a held key was let go then, so ask for it again.
                if (name == "ready") { if (self->hotkey) self->requestHotkey(); return; }
                // Right Alt can't be had: it is AltGr on this keyboard layout.
                if (name == "hotkeyUnavailable") { if (self->hotkey) self->output.send({{"event", "hotkeyUnavailable"}}); return; }
                if (name == "hotkeyDown" || name == "hotkeyAgentDown" || name == "hotkeyUp") {
                    self->hotkeyChanged(name != "hotkeyUp", name == "hotkeyAgentDown");
                    return;
                }
                // Gesture's shared internal mode key remains platform-neutral;
                // the extension maps the physical Space key to that action.
                const unsigned key = std::string(action) == "toggleMode" ? 32 : std::string(action) == "cancel" ? 27 : 0;
                // An open chat window owns Escape alone.
                if (!self->recording && !(self->chat && key == 27)) return;
                // A menu-started recording has no native key gesture. Do not synthesize
                // handsFree from an asynchronous phase notification: that can arrive
                // after the first tap's release and turn the second tap into finish.
                const auto result = !key ? std::optional<Action>{} : self->gesture.active() || (key == 27 && self->gesture.chatOpen)
                    ? self->gesture.keyPressed(key, false)
                    : std::optional<Action>{key == 32 ? Action::toggleMode : Action::cancel};
                if (result) {
                    std::cerr << "debug gnome: recording action " << actionName(*result) << '\n';
                    self->emit(*result);
                }
            }, this, nullptr);
    }
    ~GnomeControls() {
        g_cancellable_cancel(cancel.get());
        setRecording(false); setChatOpen(false);
        if (hotkey) call("SetHotkey", false);
        if (signal) g_dbus_connection_signal_unsubscribe(bus.get(), signal);
    }
    void setRecording(bool active) {
        if (recording == active) return;
        recording = active;
        call("SetRecording", active);
    }
    // The chat window never takes the keyboard, so Escape reaches it only through the Shell.
    void setChatOpen(bool open) {
        if (chat == open) return;
        chat = open;
        call("SetChatOpen", open);
    }
    /** Right Alt as the dictation key, held by the Shell instead of the portal. Replies, and
     * reports a change, whether the Shell holds it. */
    void setHotkey(bool wanted, Channel::Reply reply = {}) {
        if (hotkey && !wanted) {
            hotkey = false; ++hotkeyGeneration;
            call("SetHotkey", false);
            if (hotkeyDown) hotkeyChanged(false, false, true);
            installed(false);
        }
        hotkey = wanted;
        if (wanted) requestHotkey(std::move(reply));
        else if (reply) reply({{"installed", false}}, true);
    }
    bool wantsHotkey() const { return hotkey; }
    void requestHotkey(Channel::Reply reply = {}) {
        struct Pending { GnomeControls* self; uint64_t visit; Channel::Reply reply; };
        auto pending = new Pending{this, ++hotkeyGeneration, std::move(reply)};
        if (!bus) { installed(false); if (pending->reply) pending->reply({{"installed", false}}, true); delete pending; return; }
        g_dbus_connection_call(bus.get(), "org.gnome.Shell", path, interface, "SetHotkey",
            g_variant_new("(b)", true), G_VARIANT_TYPE("(b)"), G_DBUS_CALL_FLAGS_NO_AUTO_START,
            250, cancel.get(), [](GObject* source, GAsyncResult* result, gpointer data) {
                std::unique_ptr<Pending> pending(static_cast<Pending*>(data));
                Error error;
                auto reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(source), result, &error.value);
                gboolean held = false;
                if (reply) { g_variant_get(reply, "(b)", &held); g_variant_unref(reply); }
                // These controls are gone; nothing is left to report to.
                if (g_error_matches(error.value, G_IO_ERROR, G_IO_ERROR_CANCELLED)) return;
                auto self = pending->self;
                // A missing or disabled extension, or another helper's keys, leave it not held.
                if (pending->visit == self->hotkeyGeneration && self->hotkey) self->installed(held);
                if (pending->reply) pending->reply({{"installed", self->hotkey && self->hotkeyInstalled}}, true);
            }, pending);
    }
    void call(const char* method, bool active) {
        if (!bus) return;
        g_dbus_connection_call(bus.get(), "org.gnome.Shell", path, interface, method,
            g_variant_new("(b)", active), G_VARIANT_TYPE("(b)"), G_DBUS_CALL_FLAGS_NO_AUTO_START,
            250, nullptr, [](GObject* source, GAsyncResult* result, gpointer) {
                Error error;
                auto reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(source), result, &error.value);
                if (reply) g_variant_unref(reply);
                // Missing/disabled extension keeps the existing portal shortcuts.
            }, nullptr);
    }
    void installed(bool held) {
        if (hotkeyInstalled == held) return;
        hotkeyInstalled = held;
        output.send({{"event", "hotkeyInstallationChanged"}, {"installed", held}});
    }
    // The Shell reports Right Alt's press and its release; Shift at the press is agent mode.
    void hotkeyChanged(bool down, bool agent, bool force = false) {
        if ((!hotkey && !force) || down == hotkeyDown) return; // Ignore unmatched releases.
        hotkeyDown = down;
        const double time = static_cast<double>(g_get_monotonic_time()) / G_USEC_PER_SEC;
        if (const auto result = gesture.modifier(down, time, agent)) emit(*result);
    }
    void emit(Action action) {
        if (action == Action::start || action == Action::startHandsFree || action == Action::startAgent || action == Action::startAgentHandsFree || action == Action::listenHandsFree)
            setRecording(true);
        else if (action == Action::finish || action == Action::cancel || action == Action::closeChat || action == Action::showHistory)
            setRecording(false);
        output.action(action);
    }
};
}
