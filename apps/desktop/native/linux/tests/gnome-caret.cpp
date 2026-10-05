// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/gnome_caret.h"
#include <source_location>
using namespace voice;
static void require(bool value, std::source_location at = std::source_location::current()) {
    if (!value) { std::cerr << "caret check failed at " << at.line() << '\n'; std::_Exit(1); }
}
int main() {
    using JSON = nlohmann::json;
    for (const char* invalid : {"null", "[]", "broken", "{}", "{\"x\":true,\"y\":1,\"width\":1,\"height\":2}", "{\"x\":1,\"y\":2,\"width\":0,\"height\":2}", "{\"x\":1e99,\"y\":2,\"width\":1,\"height\":2}"})
        require(GnomeCaret::geometry(invalid).is_null());
    require(GnomeCaret::geometry(std::string(513, ' ').c_str()).is_null());
    Error error;
    auto bus = own(g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error.value)); require(bus && !error.value);
    auto named = g_dbus_connection_call_sync(bus.get(), "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", "org.gnome.Shell", 0u), nullptr, G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &error.value); require(named && !error.value); g_variant_unref(named);
    auto info = g_dbus_node_info_new_for_xml(R"xml(<node><interface name="ai.tabmail.Voice.Caret"><method name="Read"><arg type="s" direction="out"/></method><method name="FromWindow"><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="s" direction="out"/></method></interface></node>)xml", &error.value); require(info && !error.value);
    struct Fixture { std::string value = R"({"x":-50,"y":200,"width":1,"height":20,"source":"wayland"})"; bool fail = false, delay = false; unsigned calls = 0; Object<GDBusMethodInvocation> pending; std::string method; std::array<double, 4> args{}; } fixture;
    const GDBusInterfaceVTable table{[](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar* method, GVariant* args, GDBusMethodInvocation* call, gpointer data) {
        auto f = static_cast<Fixture*>(data); ++f->calls; f->method = method;
        if (f->method == "FromWindow") g_variant_get(args, "(dddd)", &f->args[0], &f->args[1], &f->args[2], &f->args[3]);
        if (f->delay) { f->pending = own(static_cast<GDBusMethodInvocation*>(g_object_ref(call))); return; }
        if (f->fail) { g_dbus_method_invocation_return_dbus_error(call, "ai.tabmail.Voice.Caret.Unavailable", "Unavailable"); return; }
        g_dbus_method_invocation_return_value(call, g_variant_new("(s)", f->value.c_str()));
    }, nullptr, nullptr, {nullptr}};
    const auto registration = g_dbus_connection_register_object(bus.get(), "/ai/tabmail/Voice/Caret", info->interfaces[0], &table, &fixture, nullptr, &error.value); require(registration);
    g_dbus_node_info_unref(info);
    g_timeout_add_seconds(5, [](gpointer) -> gboolean { std::_Exit(2); }, nullptr);
    auto caret = std::make_unique<GnomeCaret>();
    const auto read = [&] {
        bool done = false; JSON value;
        caret->read([&](auto result, bool success) { require(success); value = result; done = true; });
        while (!done) g_main_context_iteration(nullptr, true);
        return value;
    };
    for (unsigned i = 0; i < 500 && fixture.calls == 0; ++i) {
        read(); while (g_main_context_iteration(nullptr, false)) {} g_usleep(1000);
    }
    require(fixture.calls > 0 && read() == JSON({{"x", -50}, {"y", 200}, {"width", 1}, {"height", 20}}));
    // A window-relative caret goes to the Shell as it is, and comes back as a screen rectangle.
    const auto fromWindow = [&](std::array<int, 4> rect) {
        bool done = false; JSON value;
        caret->fromWindow(rect, [&](auto result, bool success) { require(success); value = result; done = true; });
        while (!done) g_main_context_iteration(nullptr, true);
        return value;
    };
    fixture.value = R"({"x":979,"y":312,"width":2,"height":19,"source":"accessibility"})";
    require(fromWindow({869, 280, 2, 19}) == JSON({{"x", 979}, {"y", 312}, {"width", 2}, {"height", 19}}));
    require(fixture.method == "FromWindow" && fixture.args == std::array<double, 4>{869, 280, 2, 19});
    fixture.value = "null"; require(fromWindow({869, 280, 2, 19}).is_null());
    fixture.fail = true; require(fromWindow({869, 280, 2, 19}).is_null()); fixture.fail = false;
    fixture.value = "null"; require(read().is_null() && fixture.method == "Read");
    fixture.value = "malformed"; require(read().is_null());
    fixture.fail = true; require(read().is_null()); fixture.fail = false;
    fixture.delay = true;
    const auto before = g_get_monotonic_time(); require(read().is_null());
    require(g_get_monotonic_time() - before < 250000);
    fixture.pending.reset();
    bool done = false;
    caret->read([&](auto result, bool success) { require(success && result.is_null()); done = true; });
    while (!fixture.pending) g_main_context_iteration(nullptr, true);
    caret.reset();
    while (!done) g_main_context_iteration(nullptr, true);
    fixture.pending.reset();
    g_dbus_connection_unregister_object(bus.get(), registration);
    caret = std::make_unique<GnomeCaret>();
    for (unsigned i = 0; i < 10; ++i) { while (g_main_context_iteration(nullptr, false)) {} g_usleep(1000); }
    require(read().is_null()); // Extension absent: normal fallback, not an error.
    std::cout << "GNOME caret service contract passed\n";
}
