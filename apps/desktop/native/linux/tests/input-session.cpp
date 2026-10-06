// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/input_session.h"
#include "../src/insertion.h"
#include <fcntl.h>
#include <unistd.h>
#include <iostream>
#include <source_location>

using namespace voice;
static void require(bool value, std::source_location where = std::source_location::current()) { if (!value) { std::cerr << "check failed at line " << where.line() << "\n"; std::_Exit(1); } }
struct Fixture {
    Object<GDBusConnection> bus;
    std::vector<unsigned char> original{'S', 'y', 'n', 't', 'h', 'e', 't', 'i', 'c'};
    std::map<unsigned, int> readers;
    std::vector<std::pair<int, unsigned>> keys;
    std::function<void()> onTransfer;
    std::function<void(int, unsigned)> onKey;
    std::optional<std::pair<int, unsigned>> failKey;
    // Reads of the clipboard: the helper never makes one.
    unsigned publications = 0, reads = 0;
    // Another app copies just after the helper publishes, before it pastes.
    bool copyAfterPublish = false;
    std::vector<unsigned char> expected = original;
    unsigned completed = 0, grants = 0;
    bool clipboardGranted = true;
    unsigned deviceTypes = 1;
    const std::string session = "/org/freedesktop/portal/desktop/session/test";
    const char* xml = R"(<node>
      <interface name="org.freedesktop.host.portal.Registry"><method name="Register"><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/></method></interface>
      <interface name="org.freedesktop.portal.RemoteDesktop">
        <method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
        <method name="SelectDevices"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
        <method name="Start"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
        <method name="NotifyKeyboardKeysym"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="in"/></method>
      </interface>
      <interface name="org.freedesktop.portal.Clipboard">
        <method name="RequestClipboard"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/></method>
        <method name="SetSelection"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/></method>
        <method name="SelectionRead"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="h" direction="out"/></method>
        <method name="SelectionWrite"><arg type="o" direction="in"/><arg type="u" direction="in"/><arg type="h" direction="out"/></method>
        <method name="SelectionWriteDone"><arg type="o" direction="in"/><arg type="u" direction="in"/><arg type="b" direction="in"/></method>
      </interface>
      <interface name="org.freedesktop.portal.Session"><method name="Close"/></interface>
    </node>)";
    Fixture() {
        Error error; bus = own(g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error.value)); require(bool(bus) && !error.value);
        auto reply = variant(g_dbus_connection_call_sync(bus.get(), "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
            g_variant_new("(su)", InputSession::State::service, 0u), nullptr, G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &error.value)); require(bool(reply) && !error.value);
        auto info = g_dbus_node_info_new_for_xml(xml, &error.value); require(info && !error.value);
        const GDBusInterfaceVTable table{[](GDBusConnection*, const gchar* sender, const gchar*, const gchar*, const gchar* method, GVariant* args, GDBusMethodInvocation* invocation, gpointer data) {
            static_cast<Fixture*>(data)->call(sender, method, args, invocation);
        }, nullptr, nullptr, {nullptr}};
        for (auto interface = info->interfaces; *interface; ++interface)
            require(g_dbus_connection_register_object(bus.get(), (*interface)->name == std::string("org.freedesktop.portal.Session") ? session.c_str() : InputSession::State::desktop,
                *interface, &table, this, nullptr, &error.value));
        g_dbus_node_info_unref(info);
    }
    void owner(bool ours, const char* format = "text/plain;charset=utf-8") {
        GVariantBuilder dictionary; g_variant_builder_init(&dictionary, G_VARIANT_TYPE_VARDICT);
        const char* formats[]{format};
        g_variant_builder_add(&dictionary, "{sv}", "mime_types", g_variant_new_strv(formats, 1));
        g_variant_builder_add(&dictionary, "{sv}", "session_is_owner", g_variant_new_boolean(ours));
        require(g_dbus_connection_emit_signal(bus.get(), nullptr, InputSession::State::desktop, InputSession::State::clipboard, "SelectionOwnerChanged",
            g_variant_new("(o@a{sv})", session.c_str(), g_variant_builder_end(&dictionary)), nullptr));
    }
    void call(const char* sender, const std::string& method, GVariant* args, GDBusMethodInvocation* invocation) {
        if (method == "CreateSession" || method == "SelectDevices" || method == "Start") {
            auto dictionary = variant(g_variant_get_child_value(args, g_variant_n_children(args) - 1));
            const gchar* token = nullptr; require(g_variant_lookup(dictionary.get(), "handle_token", "&s", &token));
            std::string name(sender + 1); std::replace(name.begin(), name.end(), '.', '_');
            const auto path = std::string(InputSession::State::desktop) + "/request/" + name + "/" + token;
            if (method == "SelectDevices") {
                guint types = 0, persistence = 0;
                require(g_variant_lookup(dictionary.get(), "types", "u", &types) && types == 1);
                require(g_variant_lookup(dictionary.get(), "persist_mode", "u", &persistence) && persistence == 2);
                const gchar* restore = nullptr;
                if (grants) require(g_variant_lookup(dictionary.get(), "restore_token", "&s", &restore) && std::string(restore) == "synthetic-restore-token");
                else require(!g_variant_lookup(dictionary.get(), "restore_token", "&s", &restore));
            }
            GVariantBuilder result; g_variant_builder_init(&result, G_VARIANT_TYPE_VARDICT);
            if (method == "CreateSession") g_variant_builder_add(&result, "{sv}", "session_handle", g_variant_new_string(session.c_str()));
            if (method == "Start") {
                ++grants;
                g_variant_builder_add(&result, "{sv}", "restore_token", g_variant_new_string("synthetic-restore-token"));
                g_variant_builder_add(&result, "{sv}", "devices", g_variant_new_uint32(deviceTypes));
                g_variant_builder_add(&result, "{sv}", "clipboard_enabled", g_variant_new_boolean(clipboardGranted));
            }
            g_dbus_method_invocation_return_value(invocation, g_variant_new("(o)", path.c_str()));
            require(g_dbus_connection_emit_signal(bus.get(), sender, path.c_str(), "org.freedesktop.portal.Request", "Response", g_variant_new("(u@a{sv})", 0u, g_variant_builder_end(&result)), nullptr));
            // Deliberately no initial owner signal: matches ownerless GNOME startup.
        } else if (method == "SelectionRead") {
            ++reads;
            g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.portal.Error.Failed", "Synthetic read refused");
        } else if (method == "SelectionWrite") {
            int pipes[2]; require(pipe2(pipes, O_CLOEXEC | O_NONBLOCK) == 0);
            auto fds = own(g_unix_fd_list_new()); Error error;
            const int handle = g_unix_fd_list_append(fds.get(), pipes[1], &error.value); require(handle >= 0 && !error.value);
            guint serial = 0; auto value = variant(g_variant_get_child_value(args, 1)); serial = g_variant_get_uint32(value.get()); readers[serial] = pipes[0]; close(pipes[1]);
            g_dbus_method_invocation_return_value_with_unix_fd_list(invocation, g_variant_new("(h)", handle), fds.get());
        } else if (method == "SelectionWriteDone") {
            const gchar* path = nullptr; guint serial = 0; gboolean success = false; g_variant_get(args, "(&oub)", &path, &serial, &success);
            require(success && readers.contains(serial)); unsigned char bytes[100]; const auto size = read(readers[serial], bytes, sizeof(bytes)); close(readers[serial]); readers.erase(serial);
            require(size == ssize_t(expected.size()) && std::equal(expected.begin(), expected.end(), bytes)); ++completed;
            g_dbus_method_invocation_return_value(invocation, nullptr); if (onTransfer) onTransfer();
        } else if (method == "SetSelection") {
            ++publications; owner(true);
            if (copyAfterPublish) { copyAfterPublish = false; owner(false); }
            g_dbus_method_invocation_return_value(invocation, nullptr);
        }
        else if (method == "NotifyKeyboardKeysym") {
            auto key = variant(g_variant_get_child_value(args, 2)), down = variant(g_variant_get_child_value(args, 3));
            keys.emplace_back(g_variant_get_int32(key.get()), g_variant_get_uint32(down.get()));
            if (onKey) onKey(keys.back().first, keys.back().second);
            // The compositor may accept the event before the transport reports
            // failure. Record it first and fail only once, allowing key cleanup.
            if (failKey == keys.back()) {
                failKey.reset();
                g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.portal.Error.Failed", "Synthetic key failure");
                return;
            }
            g_dbus_method_invocation_return_value(invocation, nullptr);
        } else g_dbus_method_invocation_return_value(invocation, nullptr);
    }
};
int main() {
    gchar* temporary = g_dir_make_tmp("voice-portal-test-XXXXXX", nullptr); require(temporary != nullptr);
    const std::string tokenPath = std::string(temporary) + "/token"; g_free(temporary);
    Fixture fixture; Output output; InputSession input(output, tokenPath); auto loop = g_main_loop_new(nullptr, false);
    g_timeout_add_seconds(8, [](gpointer) -> gboolean { std::_Exit(1); }, nullptr);
    bool restoredWithoutGrant = true;
    input.restore([&](bool granted) { restoredWithoutGrant = granted; });
    require(!restoredWithoutGrant && fixture.grants == 0);
    unsigned changes = 0;
    input.state->onOwnerChange = [&] { ++changes; };
    input.request([&](bool granted) {
        require(granted && input.ready() && !input.state->selection.ours);
        input.state->publish({{"text/plain;charset=utf-8", std::make_shared<const std::vector<unsigned char>>(fixture.original)}}, nullptr, [&](bool success) {
            require(success);
            fixture.onTransfer = [&] { g_main_loop_quit(loop); };
            require(g_dbus_connection_emit_signal(fixture.bus.get(), nullptr, InputSession::State::desktop, InputSession::State::clipboard, "SelectionTransfer",
                g_variant_new("(osu)", fixture.session.c_str(), "text/plain;charset=utf-8", 42u), nullptr));
        });
    });
    g_main_loop_run(loop); require(fixture.completed == 1 && input.state->selection.ours);
    fixture.onTransfer = {};
    const auto emitOwner = [&](GVariant* dictionary) {
        const auto seen = changes;
        require(g_dbus_connection_emit_signal(fixture.bus.get(), nullptr, InputSession::State::desktop,
            InputSession::State::clipboard, "SelectionOwnerChanged",
            g_variant_new("(o@a{sv})", fixture.session.c_str(), dictionary), nullptr));
        while (changes == seen) g_main_context_iteration(nullptr, true);
    };
    emitOwner(options());
    require(!input.state->selection.ours && input.state->offer.empty());
    GVariantBuilder malformed; g_variant_builder_init(&malformed, G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&malformed, "{sv}", "session_is_owner", g_variant_new_boolean(true));
    emitOwner(g_variant_builder_end(&malformed));
    require(!input.state->selection.ours);
    bool focused = true, terminal = false;
    Inserter inserter(input, [&](uint64_t token) { return focused && token == 42; }, [&] { return terminal; });
    { auto inner = input.state->onOwnerChange; input.state->onOwnerChange = [&changes, inner] { ++changes; inner(); }; }
    const auto parameters = [] {
        const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        return nlohmann::json{{"text", "Synthetic Unicode café 日本語"}, {"window", 42u}, {"deadline", now + 2000}};
    };
    const auto reset = [&] {
        const auto seen = changes;
        fixture.owner(false);
        while (changes == seen) g_main_context_iteration(nullptr, true);
        fixture.keys.clear(); fixture.onKey = {}; fixture.publications = 0;
    };
    const auto run = [&](int64_t id, bool expectedSuccess) {
        bool replied = false;
        inserter.insert(id, parameters(), [&](auto, bool success) { require(success == expectedSuccess); replied = true; g_main_loop_quit(loop); });
        if (!replied) g_main_loop_run(loop);
        require(replied);
    };
    // Keep the immutable text alive while constructing the byte vector.
    const auto text = parameters()["text"].get<std::string>();
    fixture.expected.assign(text.begin(), text.end());
    const auto offered = [&] { return *input.state->offer.at("text/plain;charset=utf-8") == fixture.expected; };
    // A clipboard whose state was never announced (GNOME's silent startup) is written all the same.
    fixture.publications = 0;
    run(91, true);
    require(fixture.publications == 1 && offered() && fixture.keys.size() == 4);
    reset();
    fixture.onKey = [&](int key, unsigned down) {
        if (key == 'v' && down) require(g_dbus_connection_emit_signal(fixture.bus.get(), nullptr, InputSession::State::desktop, InputSession::State::clipboard, "SelectionTransfer",
            g_variant_new("(osu)", fixture.session.c_str(), "text/plain;charset=utf-8", 43u), nullptr));
    };
    run(1, true);
    require(fixture.completed == 2 && fixture.publications == 1);
    require(fixture.keys == std::vector<std::pair<int, unsigned>>{{0xffe3, 1}, {'v', 1}, {'v', 0}, {0xffe3, 0}});
    // The text stays on the clipboard; the next dictation replaces it.
    require(offered());
    run(92, true);
    require(fixture.publications == 2 && fixture.keys.size() == 8 && offered());
    reset();
    // Another app copying between the publish and the paste vetoes the paste.
    fixture.copyAfterPublish = true;
    run(77, false);
    require(fixture.publications == 1 && fixture.keys.empty() && !input.state->selection.ours);
    reset();
    // Another app's file transfer on the clipboard is replaced like any copy, and never read.
    {
        const auto seen = changes;
        fixture.owner(false, "application/vnd.portal.filetransfer");
        while (changes == seen) g_main_context_iteration(nullptr, true);
    }
    run(93, true);
    require(fixture.publications == 1 && offered() && fixture.reads == 0);
    require(fixture.keys == std::vector<std::pair<int, unsigned>>{{0xffe3, 1}, {'v', 1}, {'v', 0}, {0xffe3, 0}});
    reset();
    fixture.onKey = [&](int key, unsigned down) { if (key == 0xffe3 && down) inserter.cancel(78); };
    run(78, false);
    require(fixture.keys == std::vector<std::pair<int, unsigned>>{{0xffe3, 1}, {0xffe3, 0}} && fixture.publications == 1);
    require(offered());
    reset(); focused = false; run(2, false); require(fixture.publications == 0 && fixture.keys.empty()); focused = true;
    reset();
    bool canceledReply = false;
    inserter.insert(3, parameters(), [&](auto, bool success) { require(!success); canceledReply = true; g_main_loop_quit(loop); });
    inserter.cancel(3);
    if (!canceledReply) g_main_loop_run(loop);
    require(canceledReply && fixture.publications == 1 && fixture.keys.empty());
    reset();
    fixture.onKey = [&](int key, unsigned down) { if (key == 'v' && down) fixture.owner(false); };
    run(4, true); require(fixture.publications == 1 && !input.state->selection.ours); // Intervening copy wins.
    reset();
    fixture.onKey = [&](int key, unsigned down) { if (key == 0xffe3 && down) focused = false; };
    run(5, false);
    require(fixture.keys == std::vector<std::pair<int, unsigned>>{{0xffe3, 1}, {0xffe3, 0}} && fixture.publications == 1);
    focused = true; terminal = true; reset();
    run(6, true);
    require(fixture.keys == std::vector<std::pair<int, unsigned>>{{0xffe3, 1}, {0xffe1, 1}, {'v', 1}, {'v', 0}, {0xffe1, 0}, {0xffe3, 0}});
    reset();
    fixture.onKey = [&](int key, unsigned down) { if (key == 0xffe1 && down) focused = false; };
    run(7, false);
    require(fixture.keys == std::vector<std::pair<int, unsigned>>{{0xffe3, 1}, {0xffe1, 1}, {0xffe1, 0}, {0xffe3, 0}});
    focused = true; reset();
    fixture.onKey = [&](int key, unsigned down) { if (key == 0xffe3 && down) terminal = false; };
    run(8, false);
    require(fixture.keys == std::vector<std::pair<int, unsigned>>{{0xffe3, 1}, {0xffe3, 0}});
    terminal = false;
    const std::vector<std::pair<std::pair<int, unsigned>, std::vector<std::pair<int, unsigned>>>> failures{
        {{0xffe3, 1}, {{0xffe3, 1}, {0xffe3, 0}}},
        {{'v', 1}, {{0xffe3, 1}, {'v', 1}, {'v', 0}, {0xffe3, 0}}},
        {{'v', 0}, {{0xffe3, 1}, {'v', 1}, {'v', 0}, {'v', 0}, {0xffe3, 0}}},
        {{0xffe3, 0}, {{0xffe3, 1}, {'v', 1}, {'v', 0}, {0xffe3, 0}, {0xffe3, 0}}},
    };
    int64_t failedID = 9;
    for (const auto& [failure, expectedKeys] : failures) {
        reset(); fixture.failKey = failure;
        run(failedID++, false);
        require(!fixture.failKey && fixture.keys == expectedKeys && fixture.publications == 1);
        require(offered());
    }
    // No insertion read the clipboard.
    require(fixture.reads == 0);
    std::weak_ptr<const std::vector<unsigned char>> retained = input.state->offer.at("text/plain;charset=utf-8");
    require(!retained.expired());
    input.state->close();
    require(retained.expired());
    input.restore([&](bool granted) { require(granted); g_main_loop_quit(loop); });
    g_main_loop_run(loop); require(fixture.grants == 2);
    struct stat tokenMetadata{}; require(stat(tokenPath.c_str(), &tokenMetadata) == 0 && (tokenMetadata.st_mode & 0777) == 0600);
    PortalToken tokens(tokenPath); require(tokens.take() == "synthetic-restore-token" && tokens.take().empty());
    require(tokens.save("rotated-token") && tokens.take() == "rotated-token");
    require(!tokens.save(std::string(4097, 'x')) && !tokens.save(std::string("a\0b", 3)));
    require(symlink("/etc/passwd", tokenPath.c_str()) == 0 && tokens.take().empty()); unlink(tokenPath.c_str());
    for (int missing = 0; missing < 2; ++missing) {
        input.state->close();
        fixture.clipboardGranted = missing != 0;
        fixture.deviceTypes = missing == 1 ? 0 : 1;
        require(tokens.save("synthetic-restore-token"));
        bool replied = false;
        input.request([&](bool granted) { require(!granted && !input.ready()); replied = true; g_main_loop_quit(loop); });
        g_main_loop_run(loop);
        require(replied && !input.state->selection.ours && input.state->offer.empty() && input.state->session.empty());
        fixture.clipboardGranted = true; fixture.deviceTypes = 1;
        require(tokens.save("synthetic-restore-token"));
        replied = false;
        input.request([&](bool granted) { require(granted && input.ready()); replied = true; g_main_loop_quit(loop); });
        g_main_loop_run(loop); require(replied);
    }
    input.state->close(); rmdir(tokenPath.substr(0, tokenPath.find_last_of('/')).c_str());
    g_main_loop_unref(loop); std::cout << "portal FD transfers, write-only Unicode paste, target changes, cancellation, key cleanup and intervening copy passed\n";
}
