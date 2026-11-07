// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/gnome_caret.h"
#include <atomic>
#include <optional>
#include <source_location>
#include <thread>
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
    auto info = g_dbus_node_info_new_for_xml(R"xml(<node><interface name="ai.tabmail.Voice.Caret"><method name="Version"><arg type="u" direction="out"/></method><method name="Read"><arg type="s" direction="out"/></method><method name="FromWindow"><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="s" direction="out"/></method><method name="Target"><arg type="u" direction="in"/><arg type="t" direction="out"/><arg type="u" direction="out"/></method><method name="Activate"><arg type="t" direction="in"/><arg type="b" direction="out"/></method><method name="Focus"><arg type="t" direction="out"/><arg type="u" direction="out"/></method><method name="App"><arg type="t" direction="in"/><arg type="s" direction="out"/><arg type="s" direction="out"/></method></interface></node>)xml", &error.value); require(info && !error.value);
    struct Fixture { std::string value = R"({"x":-50,"y":200,"width":1,"height":20,"source":"wayland"})"; bool fail = false, delay = false, malformed = false; unsigned calls = 0, version = 5; guint64 window = 0, asked = 0; guint32 pid = 0; unsigned appAfterMs = 0; std::string appID, appName, appError; Object<GDBusMethodInvocation> pending; std::string method; std::array<double, 4> args{}; } fixture;
    const GDBusInterfaceVTable table{[](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar* method, GVariant* args, GDBusMethodInvocation* call, gpointer data) {
        auto f = static_cast<Fixture*>(data); ++f->calls; f->method = method;
        if (f->method == "FromWindow") g_variant_get(args, "(dddd)", &f->args[0], &f->args[1], &f->args[2], &f->args[3]);
        if (f->delay) { f->pending = own(static_cast<GDBusMethodInvocation*>(g_object_ref(call))); return; }
        if (f->fail) { g_dbus_method_invocation_return_dbus_error(call, "ai.tabmail.Voice.Caret.Unavailable", "Unavailable"); return; }
        if (f->method == "Version") { g_dbus_method_invocation_return_value(call, g_variant_new("(u)", f->version)); return; }
        if (f->method == "Activate") {
            guint64 window = 0; g_variant_get(args, "(t)", &window);
            g_dbus_method_invocation_return_value(call, g_variant_new("(b)", window == f->window));
            return;
        }
        if (f->method == "App") {
            g_variant_get(args, "(t)", &f->asked);
            if (!f->appError.empty()) { g_dbus_method_invocation_return_dbus_error(call, f->appError.c_str(), "Synthetic"); return; }
            // A busy Shell's answer, after `appAfterMs`.
            if (f->appAfterMs) {
                g_timeout_add(f->appAfterMs, [](gpointer call) -> gboolean {
                    g_dbus_method_invocation_return_value(static_cast<GDBusMethodInvocation*>(call), g_variant_new("(ss)", "chromium_chromium.desktop", "Chromium Web Browser"));
                    return G_SOURCE_REMOVE;
                }, call);
                return;
            }
            g_dbus_method_invocation_return_value(call, f->malformed ? g_variant_new("(s)", f->appID.c_str()) : g_variant_new("(ss)", f->appID.c_str(), f->appName.c_str()));
            return;
        }
        if (f->method == "Focus" || f->method == "Target") {
            g_dbus_method_invocation_return_value(call, f->malformed ? g_variant_new("(uu)", 1u, f->pid) : g_variant_new("(tu)", f->window, f->pid));
            return;
        }
        g_dbus_method_invocation_return_value(call, g_variant_new("(s)", f->value.c_str()));
    }, nullptr, nullptr, {nullptr}};
    const auto registration = g_dbus_connection_register_object(bus.get(), "/ai/tabmail/Voice/Caret", info->interfaces[0], &table, &fixture, nullptr, &error.value); require(registration);
    g_dbus_node_info_unref(info);
    g_timeout_add_seconds(10, [](gpointer) -> gboolean { std::_Exit(2); }, nullptr);
    auto caret = std::make_unique<GnomeCaret>();
    const auto read = [&] {
        bool done = false; JSON value;
        caret->read([&](auto result, bool success) { require(success); value = result; done = true; });
        while (!done) g_main_context_iteration(nullptr, true);
        return value;
    };
    const auto integration = [&] {
        bool done = false, value = false;
        caret->integration([&](JSON result, bool success) { require(success); value = result.get<bool>(); done = true; });
        while (!done) g_main_context_iteration(nullptr, true);
        return value;
    };
    // Asked the moment the helper starts, as the app does at launch, the Shell is asked and answers
    // (#262): the helper doesn't answer for it before it is connected. Whichever is asked first: a
    // caret, then, on a helper started afresh, the integration.
    require(read() == JSON({{"x", -50}, {"y", 200}, {"width", 1}, {"height", 20}}) && fixture.calls == 1 && fixture.method == "Read");
    caret = std::make_unique<GnomeCaret>();
    require(integration() && fixture.calls == 2 && fixture.method == "Version");
    require(read() == JSON({{"x", -50}, {"y", 200}, {"width", 1}, {"height", 20}}) && fixture.calls == 3);
    // A Shell still running an older extension (until the next login) is not ready.
    fixture.version = 3; require(!integration()); fixture.version = 4; require(!integration()); fixture.version = 5;
    fixture.fail = true; require(!integration()); fixture.fail = false;
    // A window-relative caret goes to the Shell as it is, and comes back as a screen rectangle. The
    // answer is the call's own return value: the helper replies before handling its next request (a
    // screen read that holds the main loop). The Shell's side is served here, on the main loop, while
    // another thread asks.
    const auto fromWindow = [&](std::array<int, 4> rect) {
        std::atomic<bool> done = false; JSON value;
        std::thread asker([&] { value = caret->fromWindow(rect); done = true; });
        while (!done) g_main_context_iteration(nullptr, false);
        asker.join();
        return value;
    };
    fixture.value = R"({"x":979,"y":312,"width":2,"height":19,"source":"accessibility"})";
    require(fromWindow({869, 280, 2, 19}) == JSON({{"x", 979}, {"y", 312}, {"width", 2}, {"height", 19}}));
    require(fixture.method == "FromWindow" && fixture.args == std::array<double, 4>{869, 280, 2, 19});
    fixture.value = "null"; require(fromWindow({869, 280, 2, 19}).is_null());
    fixture.fail = true; require(fromWindow({869, 280, 2, 19}).is_null()); fixture.fail = false;
    // A Shell that doesn't answer holds the helper no longer than the call's time limit.
    fixture.delay = true;
    const auto asked = g_get_monotonic_time(); require(fromWindow({869, 280, 2, 19}).is_null());
    require(g_get_monotonic_time() - asked < 250000);
    fixture.delay = false; fixture.pending.reset();
    // The window with the keyboard focus, by the Shell: its id and process, asked and answered like
    // FromWindow. No window: none in front, and no process for it. No answer, a failure or a reply
    // of another shape: no answer.
    const auto focus = [&] {
        std::atomic<bool> done = false; std::optional<std::pair<uint64_t, unsigned>> value;
        std::thread asker([&] { value = caret->focus(); done = true; });
        while (!done) g_main_context_iteration(nullptr, false);
        asker.join();
        return value;
    };
    using Focus = std::optional<std::pair<uint64_t, unsigned>>;
    fixture.window = 7100; fixture.pid = 4242;
    require(focus() == Focus(std::pair<uint64_t, unsigned>{7100, 4242}) && fixture.method == "Focus");
    const auto target = [&] {
        std::atomic<bool> done = false; Focus value;
        std::thread asker([&] { value = caret->target(); done = true; });
        while (!done) g_main_context_iteration(nullptr, false);
        asker.join(); return value;
    };
    require(target() == Focus(std::pair<uint64_t, unsigned>{7100, 4242}) && fixture.method == "Target");
    bool activated = false, activationDone = false;
    caret->activate(7100, [&](bool success) { activated = success; activationDone = true; });
    while (!activationDone) g_main_context_iteration(nullptr, true);
    require(activated && fixture.method == "Activate");
    activationDone = false;
    caret->activate(7101, [&](bool success) { activated = success; activationDone = true; });
    while (!activationDone) g_main_context_iteration(nullptr, true);
    require(!activated);
    fixture.window = 0; require(focus() == Focus(std::pair<uint64_t, unsigned>{0, 0}));
    fixture.window = 7100; fixture.malformed = true; require(!focus()); fixture.malformed = false;
    fixture.fail = true; require(!focus()); fixture.fail = false;
    fixture.delay = true;
    const auto focusAsked = g_get_monotonic_time(); require(!focus());
    require(g_get_monotonic_time() - focusAsked < 1000000);
    fixture.delay = false; fixture.pending.reset();
    // A window's app, by the Shell: its desktop file's id and name for the window asked about. No app where
    // the Shell knows no desktop file for it (an empty id) or has no extension to ask, or one older than App;
    // unknown where it has no live window with the id, or gives no answer: a failure or no reply in time.
    const auto app = [&](uint64_t window) {
        std::atomic<bool> done = false; WindowApp value;
        std::thread asker([&] { value = caret->app(window); done = true; });
        while (!done) g_main_context_iteration(nullptr, false);
        asker.join(); return value;
    };
    fixture.appID = "chromium_chromium.desktop"; fixture.appName = "Chromium Web Browser";
    const auto none = [](const WindowApp& value) { return !value.app && !value.unknown; };
    auto known = app(7100);
    require(known.app && !known.unknown && known.app->id == "chromium_chromium.desktop" && known.app->name == "Chromium Web Browser" && fixture.method == "App" && fixture.asked == 7100);
    fixture.appName = ""; known = app(7101);
    require(known.app && !known.unknown && known.app->id == "chromium_chromium.desktop" && known.app->name.empty() && fixture.asked == 7101);
    fixture.appID = ""; fixture.appName = "Synthetic window"; require(none(app(7100)));
    fixture.appID = "chromium_chromium.desktop";
    // An extension older than App (until the next log-in), or none exported: nothing to ask.
    for (const char* unasked : {"org.freedesktop.DBus.Error.UnknownMethod", "org.freedesktop.DBus.Error.UnknownObject",
                                "org.freedesktop.DBus.Error.UnknownInterface", "org.freedesktop.DBus.Error.ServiceUnknown",
                                "org.freedesktop.DBus.Error.NameHasNoOwner"}) {
        fixture.appError = unasked; require(none(app(7100)) && fixture.asked == 7100);
    }
    for (const char* failed : {"ai.tabmail.Voice.Caret.Error.NoWindow", "org.freedesktop.DBus.Error.Failed"}) {
        fixture.appError = failed; require(app(7100).unknown);
    }
    fixture.appError.clear();
    // A reply the fixture's bus refuses to send (not the interface's shape) arrives as a failure.
    fixture.malformed = true; known = app(7100); require(known.unknown && !known.app); fixture.malformed = false;
    fixture.fail = true; require(app(7100).unknown); fixture.fail = false;
    // No Shell id at hand is still a question: the Shell answers it as for any id (here, a closed window's).
    const auto callsBefore = fixture.calls;
    fixture.appError = "ai.tabmail.Voice.Caret.Error.NoWindow"; known = app(0);
    require(known.unknown && !known.app && fixture.calls == callsBefore + 1 && fixture.asked == 0);
    fixture.appError.clear();
    // The Shell gets longer to name an app than to say which window is in front (`HelperConfig::shellAppTimeoutMs`):
    // an answer that comes after Focus's limit is still taken, and none at all holds the read for App's limit only.
    fixture.appAfterMs = 2 * GnomeCaret::focusTimeoutMilliseconds;
    known = app(7100); require(known.app && !known.unknown && known.app->id == "chromium_chromium.desktop");
    fixture.appAfterMs = 0;
    fixture.delay = true;
    const auto appAsked = g_get_monotonic_time(); require(app(7100).unknown);
    const auto appWaited = g_get_monotonic_time() - appAsked;
    require(appWaited >= HelperConfig::shellAppTimeoutMs * 900LL && appWaited < HelperConfig::shellAppTimeoutMs * 1000LL + 1000000);
    fixture.delay = false; fixture.pending.reset();
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
    require(read().is_null() && !integration()); // Extension absent: normal fallback, not an error.
    std::cout << "GNOME caret service contract passed\n";
}
