// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/channel.h"
#include "../src/portal_hotkey.h"
#include <source_location>
using namespace voice;
static void require(bool value, std::source_location where = std::source_location::current()) {
    if (!value) { std::cerr << "shortcut check failed at " << where.line() << '\n'; std::_Exit(1); }
}
int main() {
    Error error;
    auto bus = own(g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error.value)); require(bus && !error.value);
    auto named = variant(g_dbus_connection_call_sync(bus.get(), "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
        g_variant_new("(su)", "org.freedesktop.portal.Desktop", 0u), nullptr, G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &error.value)); require(named && !error.value);
    const char* xml = R"xml(<node>
      <interface name="org.freedesktop.host.portal.Registry"><method name="Register"><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/></method></interface>
      <interface name="org.freedesktop.portal.GlobalShortcuts">
      <method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
      <method name="ListShortcuts"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
      <method name="BindShortcuts"><arg type="o" direction="in"/><arg type="a(sa{sv})" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
      </interface><interface name="org.freedesktop.portal.Session"><method name="Close"/></interface>
    </node>)xml";
    struct Fixture { bool deny = true; unsigned binds = 0; unsigned grantMask = 7; } fixture;
    const char* path = "/org/freedesktop/portal/desktop";
    const char* session = "/org/freedesktop/portal/desktop/session/test";
    auto info = g_dbus_node_info_new_for_xml(xml, &error.value); require(info && !error.value);
    const GDBusInterfaceVTable table{[](GDBusConnection* bus, const gchar* sender, const gchar*, const gchar*, const gchar* method, GVariant* args, GDBusMethodInvocation* call, gpointer data) {
        auto fixture = static_cast<Fixture*>(data); const std::string name = method;
        if (name == "Register" || name == "Close") { g_dbus_method_invocation_return_value(call, nullptr); return; }
        auto dictionary = variant(g_variant_get_child_value(args, g_variant_n_children(args) - 1));
        const gchar* token; require(g_variant_lookup(dictionary.get(), "handle_token", "&s", &token));
        std::string owner(sender + 1); std::replace(owner.begin(), owner.end(), '.', '_');
        const auto request = "/org/freedesktop/portal/desktop/request/" + owner + "/" + token;
        GVariantBuilder result; g_variant_builder_init(&result, G_VARIANT_TYPE_VARDICT);
        if (name == "CreateSession") g_variant_builder_add(&result, "{sv}", "session_handle", g_variant_new_string("/org/freedesktop/portal/desktop/session/test"));
        if (name == "BindShortcuts") {
            ++fixture->binds;
            auto shortcuts = variant(g_variant_get_child_value(args, 1));
            require(g_variant_n_children(shortcuts.get()) == 3);
            auto first = variant(g_variant_get_child_value(shortcuts.get(), 0));
            const gchar* id; GVariant* props; g_variant_get(first.get(), "(&s@a{sv})", &id, &props);
            const gchar* trigger; require(std::string(id) == "dictation-F8" && g_variant_lookup(props, "preferred_trigger", "&s", &trigger) && std::string(trigger) == "F8"); g_variant_unref(props);
            GVariantBuilder granted; g_variant_builder_init(&granted, G_VARIANT_TYPE("a(sa{sv})"));
            for (unsigned i = 0; i < 3; ++i) if (fixture->grantMask & (1u << i)) {
                auto entry = variant(g_variant_get_child_value(shortcuts.get(), i));
                g_variant_builder_add_value(&granted, entry.get());
            }
            g_variant_builder_add(&result, "{sv}", "shortcuts", g_variant_builder_end(&granted));
        }
        g_dbus_method_invocation_return_value(call, g_variant_new("(o)", request.c_str()));
        require(g_dbus_connection_emit_signal(bus, sender, request.c_str(), "org.freedesktop.portal.Request", "Response",
            g_variant_new("(u@a{sv})", name == "BindShortcuts" && fixture->deny ? 1u : 0u, g_variant_builder_end(&result)), nullptr));
    }, nullptr, nullptr, {nullptr}};
    for (auto api = info->interfaces; *api; ++api) require(g_dbus_connection_register_object(bus.get(), std::string((*api)->name).ends_with("Session") ? session : path, *api, &table, &fixture, nullptr, &error.value));
    g_dbus_node_info_unref(info);
    Output output; Gesture gesture; gesture.tapMaxDuration = 0.2; gesture.doubleTapWindow = 0.3;
    std::vector<Action> actions;
    PortalHotkey portal(output, gesture, [&](Action action) { actions.push_back(action); output.action(action); });
    g_timeout_add_seconds(8, [](gpointer) -> gboolean { std::_Exit(2); }, nullptr);
    require(!portal.configure("F8"));
    while (portal.busy()) g_main_context_iteration(nullptr, true);
    require(!portal.ready() && fixture.binds == 1); // A new session must bind; ListShortcuts cannot restore it.
    const auto authorize = [&](bool expected) {
        bool replied = false;
        portal.authorize("", [&](auto result, bool success) { require(success && result["installed"] == expected); replied = true; });
        while (!replied) g_main_context_iteration(nullptr, true);
        require(portal.ready() == expected);
    };
    fixture.deny = true; authorize(false);
    fixture.deny = false;
    // No partial grant can provide the complete dictation/edit/cancel contract.
    for (unsigned mask = 0; mask < 7; ++mask) { fixture.grantMask = mask; authorize(false); }
    fixture.grantMask = 7; authorize(true);
    auto emit = [&](const char* event, uint64_t time, const char* id = "dictation-F8") {
        require(g_dbus_connection_emit_signal(bus.get(), nullptr, path, "org.freedesktop.portal.GlobalShortcuts", event,
            g_variant_new("(ost@a{sv})", session, id, time, options()), nullptr));
    };
    emit("Activated", 1000); while (!gesture.holding) g_main_context_iteration(nullptr, true);
    emit("Deactivated", 1500); while (gesture.holding) g_main_context_iteration(nullptr, true);
    emit("Activated", 2000); while (!gesture.holding) g_main_context_iteration(nullptr, true);
    require(g_dbus_connection_emit_signal(bus.get(), nullptr, session, "org.freedesktop.portal.Session", "Closed", g_variant_new("(@a{sv})", options()), nullptr));
    while (portal.ready()) g_main_context_iteration(nullptr, true);
    require(!gesture.active());
    const auto binds = fixture.binds;
    require(!portal.configure("F8"));
    while (portal.busy()) g_main_context_iteration(nullptr, true);
    require(portal.ready() && fixture.binds == binds + 1); // Restarts bind the same saved IDs again.
    emit("Activated", 5000, "mode-F8");
    while (!gesture.holding) g_main_context_iteration(nullptr, true);
    require(actions.back() == Action::startAgent); // One initial-intent action, no synthetic Space.
    const auto beforeRepeat = actions.size();
    emit("Activated", 5100, "mode-F8"); // Repeat must not lose ownership of the held gesture.
    emit("Deactivated", 5400, "mode-F8");
    while (gesture.holding) g_main_context_iteration(nullptr, true);
    require(!gesture.active() && actions.size() == beforeRepeat + 1 && actions.back() == Action::finish);
    emit("Activated", 6000); emit("Deactivated", 6050);
    emit("Activated", 6100); emit("Deactivated", 6150);
    while (!gesture.handsFree) g_main_context_iteration(nullptr, true);
    const auto beforeMode = actions.size();
    emit("Activated", 6200, "mode-F8");
    while (actions.size() == beforeMode) g_main_context_iteration(nullptr, true);
    require(actions.back() == Action::toggleMode && gesture.handsFree);
    emit("Deactivated", 6250, "mode-F8");
    emit("Activated", 6300, "cancel-F8");
    while (gesture.handsFree) g_main_context_iteration(nullptr, true);
    require(!gesture.active());
    require(actions.back() == Action::cancel);
    gesture.chatOpen = true;
    const auto beforeClose = actions.size();
    emit("Activated", 6500, "cancel-F8");
    while (actions.size() == beforeClose) g_main_context_iteration(nullptr, true);
    require(actions.back() == Action::closeChat);
    // Right Alt chosen instead: the portal's keys go, a dictation they started is cancelled, and
    // the app is told once; letting go again tells it nothing.
    gesture.chatOpen = false;
    emit("Activated", 7000); while (!gesture.holding) g_main_context_iteration(nullptr, true);
    portal.disable();
    require(!portal.ready() && !gesture.active());
    portal.disable();
    std::cerr << "shortcut permission refusal, retry, press/release and revoked-session cleanup passed\n";
}
