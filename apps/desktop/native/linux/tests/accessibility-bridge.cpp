// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/accessibility.h"
#include <atomic>
#include <future>
#include <thread>
#include <iostream>
using namespace voice;
static void require(bool value) { if (!value) std::_Exit(1); }
int main() {
    std::atomic<unsigned> requests{0};
    std::atomic<bool> deny{false}, enabled{false};
    std::promise<GMainLoop*> ready;
    auto started = ready.get_future();
    std::thread service([&] {
        auto context = g_main_context_new();
        g_main_context_push_thread_default(context);
        auto loop = g_main_loop_new(context, false);
        Error error;
        auto bus = own(g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error.value));
        require(bus && !error.value);
        auto named = g_dbus_connection_call_sync(bus.get(), "org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", "org.a11y.Bus", 0u),
            nullptr, G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &error.value);
        require(named && !error.value); g_variant_unref(named);
        auto info = g_dbus_node_info_new_for_xml(R"(<node><interface name="org.a11y.Status">
            <property name="IsEnabled" type="b" access="readwrite"/>
            <property name="ScreenReaderEnabled" type="b" access="readwrite"/>
            </interface></node>)", &error.value);
        require(info && !error.value);
        struct State { std::atomic<unsigned>& requests; std::atomic<bool>& deny; std::atomic<bool>& enabled; } state{requests, deny, enabled};
        const GDBusInterfaceVTable table{nullptr, nullptr,
            [](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar* property, GVariant* value, GError** error, gpointer data) -> gboolean {
                auto state = static_cast<State*>(data);
                require(std::string(property) == "IsEnabled" && g_variant_is_of_type(value, G_VARIANT_TYPE_BOOLEAN) && g_variant_get_boolean(value));
                ++state->requests;
                if (state->deny) {
                    g_set_error_literal(error, G_DBUS_ERROR, G_DBUS_ERROR_ACCESS_DENIED, "Synthetic denial");
                    return false;
                }
                state->enabled = true;
                return true;
            }, {nullptr}};
        auto registration = g_dbus_connection_register_object(bus.get(), "/org/a11y/bus", info->interfaces[0], &table, &state, nullptr, &error.value);
        require(registration && !error.value);
        ready.set_value(loop);
        g_main_loop_run(loop);
        g_dbus_connection_unregister_object(bus.get(), registration);
        g_dbus_node_info_unref(info);
        g_main_loop_unref(loop);
        g_main_context_pop_thread_default(context); g_main_context_unref(context);
    });
    auto loop = started.get();
    require(enableAccessibilityBridge() && enabled && requests == 1);
    require(enableAccessibilityBridge() && enabled && requests == 2);
    deny = true;
    require(!enableAccessibilityBridge() && requests == 3);
    g_main_loop_quit(loop); service.join();
    std::cout << "standard bridge activation, repeat activation and denial passed\n";
}
