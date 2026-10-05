// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/gnome_controls.h"
#include <source_location>
using namespace voice;
static void require(bool value, std::source_location at = std::source_location::current()) {
    if (!value) { std::cerr << "controls check failed at " << at.line() << '\n'; std::_Exit(1); }
}
int main() {
    Error error;
    auto bus = own(g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error.value)); require(bus && !error.value);
    auto name = g_dbus_connection_call_sync(bus.get(), "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", "org.gnome.Shell", 0u), nullptr, G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &error.value);
    require(name && !error.value); g_variant_unref(name);
    auto info = g_dbus_node_info_new_for_xml(R"(<node><interface name="ai.tabmail.Voice.Caret"><method name="SetRecording"><arg type="b" direction="in"/><arg type="b" direction="out"/></method><method name="SetChatOpen"><arg type="b" direction="in"/><arg type="b" direction="out"/></method><method name="SetHotkey"><arg type="b" direction="in"/><arg type="b" direction="out"/></method><signal name="Action"><arg type="s"/></signal></interface></node>)", &error.value); require(info);
    // SetRecording's states; SetChatOpen's and SetHotkey's, separately.
    struct Calls { std::vector<bool> recording, chat, hotkey; } calls;
    auto& states = calls.recording;
    const GDBusInterfaceVTable table{[](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar* method, GVariant* args, GDBusMethodInvocation* call, gpointer data) {
        gboolean active; g_variant_get(args, "(b)", &active);
        auto calls = static_cast<Calls*>(data);
        const std::string name = method;
        (name == "SetChatOpen" ? calls->chat : name == "SetHotkey" ? calls->hotkey : calls->recording).push_back(active);
        g_dbus_method_invocation_return_value(call, g_variant_new("(b)", true));
    }, nullptr, nullptr, {nullptr}};
    const auto registration = g_dbus_connection_register_object(bus.get(), "/ai/tabmail/Voice/Caret", info->interfaces[0], &table, &calls, nullptr, &error.value); require(registration);
    g_dbus_node_info_unref(info);
    const auto drain = [&] {
        // A timer is not evidence that an asynchronous bus message arrived.
        // The first ordered daemon reply follows the action; dispatching it can
        // enqueue SetRecording. The second follows that resulting method call.
        for (int pass = 0; pass < 2; ++pass) {
            Error barrierError;
            auto reply = g_dbus_connection_call_sync(bus.get(), "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "GetId", nullptr, G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NONE,
                1000, nullptr, &barrierError.value);
            require(reply && !barrierError.value);
            g_variant_unref(reply);
            while (g_main_context_iteration(nullptr, false)) {}
        }
    };
    const auto action = [&](const char* value) {
        require(g_dbus_connection_emit_signal(bus.get(), nullptr, "/ai/tabmail/Voice/Caret", "ai.tabmail.Voice.Caret", "Action", g_variant_new("(s)", value), &error.value)); drain();
    };
    {
        Output output; Gesture gesture; GnomeControls controls(output, gesture);
        drain(); action("cancel"); action("toggleMode");
        controls.emit(*gesture.modifier(true, 1)); drain();
        controls.setRecording(true); drain(); require(states == std::vector<bool>{true});
        action("unknown"); action("toggleMode"); action("cancel");
        require(states == std::vector<bool>({true, false}));
        action("toggleMode"); gesture.modifier(false, 2);
        controls.emit(*gesture.modifier(true, 3)); drain();
        controls.emit(*gesture.modifier(false, 4)); drain();
        require(states == std::vector<bool>({true, false, true, false}));
        controls.emit(*gesture.modifier(true, 5)); drain();
    }
    drain(); require(states == std::vector<bool>({true, false, true, false, true, false}));
    {
        Output output; Gesture gesture; GnomeControls controls(output, gesture);
        gesture.tapMaxDuration = 0.3; gesture.doubleTapWindow = 0.4;
        controls.emit(*gesture.modifier(true, 10));
        controls.emit(*gesture.modifier(false, 10.1));
        // The main process's arming notification arrives after native key-up.
        controls.setRecording(true); drain();
        const auto second = gesture.modifier(true, 10.2);
        require(second == Action::startHandsFree);
        controls.emit(*second);
        controls.emit(*gesture.modifier(false, 10.3)); drain();
        action("cancel");
        gesture.dictationEnded();
        // Menu-started recording has no active native gesture, but still owns keys.
        controls.setRecording(true); drain();
        action("toggleMode"); action("cancel");
    }
    for (const auto initial : {Action::startAgent, Action::startAgentHandsFree}) {
        Output output; Gesture gesture; GnomeControls controls(output, gesture);
        const auto before = states.size();
        controls.emit(initial); drain();
        require(states.size() == before + 1 && states.back());
        action("toggleMode");
        action("cancel");
        require(states.size() == before + 2 && !states.back());
    }
    {
        // The chat window, open between dictations, takes Escape alone; nothing records.
        Output output; Gesture gesture; GnomeControls controls(output, gesture);
        const auto before = states.size();
        action("cancel");
        gesture.chatOpen = true; controls.setChatOpen(true); drain();
        require(calls.chat == std::vector<bool>{true});
        action("toggleMode"); action("cancel");
        require(states.size() == before);
        gesture.chatOpen = false; controls.setChatOpen(false); drain();
        action("cancel");
        require(calls.chat == std::vector<bool>({true, false}));
    }
    {
        // Right Alt, held by the Shell: its press drives the gesture once, an unmatched release
        // is ignored, the Shell's "ready" asks for it again, and letting it go while it is down
        // ends the hold.
        Output output; Gesture gesture; GnomeControls controls(output, gesture);
        std::optional<nlohmann::json> replied;
        controls.setHotkey(true, [&](nlohmann::json value, bool success) { require(success); replied = value; }); drain();
        require(calls.hotkey == std::vector<bool>{true} && replied && (*replied)["installed"] == true);
        action("hotkeyUp");
        // The Shell couldn't hold Right Alt (AltGr on this layout): the app is told, once.
        action("hotkeyUnavailable");
        action("hotkeyDown"); action("hotkeyDown");
        action("ready");
        require(calls.hotkey == std::vector<bool>({true, true}));
        replied.reset();
        controls.setHotkey(false, [&](nlohmann::json value, bool) { replied = value; }); drain();
        require(calls.hotkey == std::vector<bool>({true, true, false}) && replied && (*replied)["installed"] == false);
        action("hotkeyDown"); action("ready"); action("hotkeyUnavailable");
        require(calls.hotkey == std::vector<bool>({true, true, false}));
    }
    {
        // Shift with Right Alt is agent mode; the controls let the Shell's key go when they end.
        Output output; Gesture gesture; GnomeControls controls(output, gesture);
        controls.setHotkey(true); drain();
        action("hotkeyAgentDown"); action("hotkeyUp");
    }
    drain();
    require(calls.hotkey == std::vector<bool>({true, true, false, true, false}));
    g_dbus_connection_unregister_object(bus.get(), registration);
}
