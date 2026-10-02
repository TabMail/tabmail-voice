// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "accessibility.h"
#include "output.h"

namespace voice {
// The portal owns the initial hotkey. The Shell extension owns only the
// temporary recording keys, and releases them when this bus client disappears.
class GnomeControls {
    Object<GDBusConnection> bus;
    Output& output;
    Gesture& gesture;
    guint signal = 0;
    bool recording = false;
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
                if (!self->recording || !g_variant_is_of_type(value, G_VARIANT_TYPE("(s)"))) return;
                const char* action; g_variant_get(value, "(&s)", &action);
                // Gesture's shared internal mode key remains platform-neutral;
                // the extension maps the physical Shift key to that action.
                const unsigned key = std::string(action) == "toggleMode" ? 32 : std::string(action) == "cancel" ? 27 : 0;
                // A menu-started recording has no native key gesture. Do not synthesize
                // handsFree from an asynchronous phase notification: that can arrive
                // after the first tap's release and turn the second tap into finish.
                const auto result = !key ? std::optional<Action>{} : self->gesture.active()
                    ? self->gesture.keyPressed(key, false)
                    : std::optional<Action>{key == 32 ? Action::toggleMode : Action::cancel};
                if (result) {
                    std::cerr << "debug gnome: recording action " << actionName(*result) << '\n';
                    self->emit(*result);
                }
            }, this, nullptr);
    }
    ~GnomeControls() {
        setRecording(false);
        if (signal) g_dbus_connection_signal_unsubscribe(bus.get(), signal);
    }
    void setRecording(bool active) {
        if (recording == active) return;
        recording = active;
        if (!bus) return;
        g_dbus_connection_call(bus.get(), "org.gnome.Shell", path, interface, "SetRecording",
            g_variant_new("(b)", active), G_VARIANT_TYPE("(b)"), G_DBUS_CALL_FLAGS_NO_AUTO_START,
            250, nullptr, [](GObject* source, GAsyncResult* result, gpointer) {
                Error error;
                auto reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(source), result, &error.value);
                if (reply) g_variant_unref(reply);
                // Missing/disabled extension keeps the existing portal shortcuts.
            }, nullptr);
    }
    void emit(Action action) {
        if (action == Action::start || action == Action::startHandsFree || action == Action::listenHandsFree)
            setRecording(true);
        else if (action == Action::finish || action == Action::cancel || action == Action::closeChat || action == Action::showHistory)
            setRecording(false);
        output.action(action);
    }
};
}
