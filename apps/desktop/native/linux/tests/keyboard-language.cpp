// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/keyboard_language.h"
#include <source_location>
using namespace voice;
static void require(bool value, std::source_location at = std::source_location::current()) {
    if (!value) { std::cerr << "language check failed at " << at.line() << '\n'; std::_Exit(1); }
}
int main() {
    // A private service, never the desktop's actual input method.
    g_setenv("IBUS_ADDRESS", g_getenv("DBUS_SESSION_BUS_ADDRESS"), true);
    ibus_init(); Error error;
    auto bus = own(g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error.value)); require(bus && !error.value);
    auto named = g_dbus_connection_call_sync(bus.get(), "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", "org.freedesktop.IBus", 0u), nullptr, G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &error.value); require(named && !error.value); g_variant_unref(named);
    auto info = g_dbus_node_info_new_for_xml(R"xml(<node><interface name="org.freedesktop.DBus.Properties"><method name="Get"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method></interface></node>)xml", &error.value); require(info && !error.value);
    struct Fixture { std::string language = "en"; bool fail = false, delay = false; unsigned calls = 0; Object<GDBusMethodInvocation> pending; } fixture;
    const GDBusInterfaceVTable table{[](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*, GVariant* args, GDBusMethodInvocation* call, gpointer data) {
        auto f = static_cast<Fixture*>(data); ++f->calls;
        const char *api, *property; g_variant_get(args, "(&s&s)", &api, &property);
        require(std::string(api) == "org.freedesktop.IBus" && std::string(property) == "GlobalEngine");
        if (f->delay) { f->pending = own(static_cast<GDBusMethodInvocation*>(g_object_ref(call))); return; }
        if (f->fail) { g_dbus_method_invocation_return_dbus_error(call, "org.freedesktop.IBus.Error.NoEngine", "No engine"); return; }
        auto engine = own(ibus_engine_desc_new("synthetic", "Synthetic", "Synthetic", f->language.c_str(), "MIT", "Synthetic", "", "us"));
        g_dbus_method_invocation_return_value(call, g_variant_new("(v)", g_variant_new_variant(ibus_serializable_serialize(IBUS_SERIALIZABLE(engine.get())))));
    }, nullptr, nullptr, {nullptr}};
    require(g_dbus_connection_register_object(bus.get(), "/org/freedesktop/IBus", info->interfaces[0], &table, &fixture, nullptr, &error.value));
    g_dbus_node_info_unref(info);
    g_timeout_add_seconds(5, [](gpointer) -> gboolean { std::_Exit(2); }, nullptr);
    auto language = std::make_unique<KeyboardLanguage>();
    const auto read = [&] {
        bool done = false; nlohmann::json value;
        language->read([&](auto result, bool success) { require(success); value = result; done = true; });
        while (!done) g_main_context_iteration(nullptr, true);
        return value;
    };
    // Permit the async bus to connect before asserting a service response.
    for (unsigned i = 0; i < 500 && fixture.calls == 0; ++i) {
        read(); while (g_main_context_iteration(nullptr, false)) {} g_usleep(1000);
    }
    require(fixture.calls > 0 && read() == nlohmann::json{{"code", "en"}});
    fixture.language = "ko"; require(read() == nlohmann::json{{"code", "ko"}}); // A live change, not cached locale.
    fixture.language.clear(); require(read().is_null());
    fixture.fail = true; require(read().is_null()); fixture.fail = false;
    fixture.delay = true;
    const auto before = g_get_monotonic_time(); require(read().is_null());
    require(g_get_monotonic_time() - before < 1000000); // A silent service must not stall dictation.
    fixture.pending.reset();
    bool done = false;
    language->read([&](auto result, bool success) { require(success && result.is_null()); done = true; });
    while (!fixture.pending) g_main_context_iteration(nullptr, true);
    language.reset(); // Cancel an outstanding read safely; its reply resolves once.
    while (!done) g_main_context_iteration(nullptr, true);
    fixture.pending.reset();
    std::cout << "language service contract passed\n";
}
