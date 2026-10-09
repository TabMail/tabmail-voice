// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/input_session.h"
#include "../src/insertion.h"
#include <fcntl.h>
#include <unistd.h>
#include <iostream>
#include <regex>
#include <source_location>
#include <sstream>

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
    // Reads of the clipboard: only a save makes them, never a paste. Another app's clipboard, by
    // format; held reads wait for the test to answer them.
    unsigned publications = 0, reads = 0;
    std::map<std::string, std::vector<unsigned char>> foreign;
    bool holdReads = false;
    std::vector<GDBusMethodInvocation*> heldReads;
    std::vector<std::string> published;
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
    void owner(bool ours, std::vector<const char*> formats = {"text/plain;charset=utf-8"}) {
        GVariantBuilder dictionary; g_variant_builder_init(&dictionary, G_VARIANT_TYPE_VARDICT);
        g_variant_builder_add(&dictionary, "{sv}", "mime_types", g_variant_new_strv(formats.data(), formats.size()));
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
            const gchar* path = nullptr; const gchar* mime = nullptr; g_variant_get(args, "(&o&s)", &path, &mime);
            const auto found = foreign.find(mime);
            if (holdReads) { heldReads.push_back(invocation); return; }
            if (found == foreign.end()) {
                g_dbus_method_invocation_return_dbus_error(invocation, "org.freedesktop.portal.Error.Failed", "Synthetic read refused");
                return;
            }
            int pipes[2]; require(pipe2(pipes, O_CLOEXEC) == 0);
            require(write(pipes[1], found->second.data(), found->second.size()) == ssize_t(found->second.size())); close(pipes[1]);
            auto fds = own(g_unix_fd_list_new()); Error error;
            const int handle = g_unix_fd_list_append(fds.get(), pipes[0], &error.value); require(handle >= 0 && !error.value); close(pipes[0]);
            g_dbus_method_invocation_return_value_with_unix_fd_list(invocation, g_variant_new("(h)", handle), fds.get());
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
            auto dictionary = variant(g_variant_get_child_value(args, 1));
            auto formats = variant(g_variant_lookup_value(dictionary.get(), "mime_types", G_VARIANT_TYPE_STRING_ARRAY));
            published.clear();
            if (formats) { gsize count = 0; const gchar** names = g_variant_get_strv(formats.get(), &count); published.assign(names, names + count); g_free(names); }
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
    g_timeout_add_seconds(16, [](gpointer) -> gboolean { std::_Exit(1); }, nullptr);
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
    // A short put-back delay keeps the run quick; the shared core's own is checked by its cases.
    ClipboardKeeper keeper(input, {100, 1024 * 1024, 8});
    Inserter inserter(input, keeper, [&](uint64_t token) { return focused && token == 42; }, [&] { return terminal; });
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
    // The paste's stages, as its debug log (stderr) says them, with nothing of the text.
    const auto stages = [&](int64_t id, bool expectedSuccess) {
        std::ostringstream log;
        auto* saved = std::cerr.rdbuf(log.rdbuf());
        run(id, expectedSuccess);
        std::cerr.rdbuf(saved);
        std::vector<std::string> names;
        std::istringstream lines(log.str());
        const std::regex line("debug paste stage: ([a-z -]+) after [0-9]+ms");
        for (std::string entry; std::getline(lines, entry);) {
            // A put-back from an earlier paste may come due meanwhile.
            if (entry.starts_with("debug clipboard keeper: ")) continue;
            std::smatch match;
            require(std::regex_match(entry, match, line) && entry.find(text) == std::string::npos);
            names.push_back(match[1]);
        }
        return names;
    };
    // A clipboard whose state was never announced (GNOME's silent startup) is written all the same.
    fixture.publications = 0;
    require(stages(91, true) == std::vector<std::string>{"clipboard-write", "clipboard-written", "send-keys", "complete"});
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
        fixture.owner(false, {"application/vnd.portal.filetransfer"});
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
    reset(); focused = false; require(stages(2, false) == std::vector<std::string>{"not pasted"}); require(fixture.publications == 0 && fixture.keys.empty()); focused = true;
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
    // What the shared core refuses (an empty or oversized text, a deadline reached, past or too far
    // ahead) is refused before anything is published or typed, and the next paste still runs.
    reset();
    const auto refused = [&](nlohmann::json change) {
        auto request = parameters();
        const auto now = request["deadline"].get<int64_t>() - 2000;
        if (change.contains("deadline")) change["deadline"] = now + change["deadline"].get<int64_t>();
        request.update(change);
        bool threw = false, replied = false;
        try { inserter.insert(100, request, [&](auto, bool) { replied = true; }); } catch (const std::exception&) { threw = true; }
        require(threw && !replied && fixture.publications == 0 && fixture.keys.empty());
    };
    refused({{"text", ""}});
    refused({{"text", std::string(512 * 1024 + 1, 'a')}});
    refused({{"deadline", 0}});
    refused({{"deadline", -1}});
    refused({{"deadline", 10000}});
    run(101, true);
    require(fixture.publications == 1 && offered());
    // No insertion read the clipboard.
    require(fixture.reads == 0);
    // The clipboard saved ahead (as the app asks while the user speaks), every format of it, read in
    // the background, goes back after the paste. Its debug log is timed and holds no clipboard data.
    std::ostringstream keeperLog;
    auto* earlierLog = std::cerr.rdbuf(keeperLog.rdbuf());
    const auto count = [&](const std::string& line) {
        const auto log = keeperLog.str();
        size_t found = 0;
        for (auto at = log.find("debug clipboard keeper: " + line); at != std::string::npos; at = log.find("debug clipboard keeper: " + line, at + 1)) ++found;
        return found;
    };
    const auto until = [&](const std::function<bool()>& done) { while (!done()) g_main_context_iteration(nullptr, true); };
    // Waits out a put-back that may come.
    const auto settle = [&] {
        bool due = false;
        g_timeout_add(300, [](gpointer data) -> gboolean { *static_cast<bool*>(data) = true; return G_SOURCE_REMOVE; }, &due);
        until([&] { return due; });
    };
    const auto copy = [&](std::vector<const char*> formats) {
        const auto seen = changes;
        fixture.owner(false, formats);
        while (changes == seen) g_main_context_iteration(nullptr, true);
        fixture.keys.clear(); fixture.onKey = {}; fixture.publications = 0; fixture.reads = 0;
    };
    const std::vector<unsigned char> picture{1, 2, 3};
    fixture.foreign = {{"text/plain;charset=utf-8", fixture.original}, {"image/png", picture}};
    const auto putBack = [&] {
        return input.state->selection.ours && input.state->offer.size() == 2 && *input.state->offer.at("image/png") == picture &&
            *input.state->offer.at("text/plain;charset=utf-8") == fixture.original;
    };
    settle();
    copy({"text/plain;charset=utf-8", "image/png"});
    keeper.save();
    until([&] { return count("clipboard saved after") == 1; });
    require(fixture.reads == 2);
    // Saved as it is: not read again.
    keeper.save();
    require(fixture.reads == 2 && count("clipboard unchanged since it was saved") == 1);
    run(110, true);
    // The text is offered as the keys are sent, and not after.
    require(fixture.publications == 1 && offered());
    until([&] { return count("clipboard put back after") == 1; });
    require(fixture.publications == 2 && putBack() && fixture.published == std::vector<std::string>{"image/png", "text/plain;charset=utf-8"});
    // A clipboard put back is saved as it is, with no read.
    fixture.reads = 0;
    keeper.save();
    require(fixture.reads == 0 && count("clipboard saved after") == 2);
    // Two pastes in a row, the second before the first's put-back: the clipboard as it was before
    // both goes back once.
    fixture.publications = 0;
    run(111, true);
    run(112, true);
    until([&] { return count("clipboard put back after") == 2; });
    settle();
    require(fixture.publications == 3 && putBack() && count("clipboard put back after") == 2);
    // A copy made after the paste, before the put-back, is kept.
    keeper.save();
    fixture.publications = 0;
    run(113, true);
    copy({"text/plain;charset=utf-8"});
    settle();
    require(fixture.publications == 0 && !input.state->selection.ours && count("clipboard changed since the paste; not put back") == 1);
    // A save older than a copy made before the paste is never put back over it.
    copy({"text/plain;charset=utf-8", "image/png"});
    keeper.save();
    until([&] { return count("clipboard saved after") == 4; });
    copy({"text/plain;charset=utf-8"});
    run(114, true);
    settle();
    require(fixture.publications == 1 && offered() && count("no save of the clipboard as it was; it won't be put back") >= 1);
    // A save still reading when the paste comes is dropped: the paste never waits for it, and its
    // text stays.
    copy({"text/plain;charset=utf-8", "image/png"});
    fixture.holdReads = true;
    keeper.save();
    until([&] { return fixture.heldReads.size() == 1; });
    run(115, true);
    settle();
    require(fixture.publications == 1 && offered() && count("the clipboard's save still under way; it won't be put back") == 1);
    fixture.holdReads = false;
    for (auto* held : fixture.heldReads) g_dbus_method_invocation_return_dbus_error(held, "org.freedesktop.portal.Error.Failed", "Synthetic read refused");
    fixture.heldReads.clear();
    // A password manager's copy and a file transfer are not read, not saved and not put back.
    for (const char* withheld : {"x-kde-passwordManagerHint", "application/vnd.portal.filetransfer"}) {
        copy({"text/plain;charset=utf-8", withheld});
        const auto skipped = count("clipboard not to be saved after");
        keeper.save();
        require(fixture.reads == 0 && count("clipboard not to be saved after") == skipped + 1);
        run(116, true);
        settle();
        require(fixture.publications == 1 && offered());
    }
    // More formats than the shared core allows are not saved.
    std::vector<std::string> many;
    for (int index = 0; index <= 8; ++index) many.push_back("application/x-synthetic-" + std::to_string(index));
    std::vector<const char*> manyNames;
    for (const auto& name : many) manyNames.push_back(name.c_str());
    copy(manyNames);
    keeper.save();
    require(fixture.reads == 0 && count("clipboard not to be saved after") == 3);
    // The paste's own text, left on the clipboard where nothing was saved, is not saved.
    copy({"text/plain;charset=utf-8"});
    run(117, true);
    settle();
    keeper.save();
    require(fixture.reads == 0 && count("the clipboard holds the paste's text; not saved") == 1);
    require(keeperLog.str().find("Synthetic") == std::string::npos);
    std::weak_ptr<const std::vector<unsigned char>> retained = input.state->offer.at("text/plain;charset=utf-8");
    require(!retained.expired());
    input.state->close();
    require(retained.expired());
    input.restore([&](bool granted) { require(granted); g_main_loop_quit(loop); });
    g_main_loop_run(loop); require(fixture.grants == 2);
    // GNOME announces no selection when a session starts: until it does, nothing is saved.
    require(!input.state->selection.known);
    keeper.save();
    require(fixture.reads == 0 && count("clipboard not known yet; not saved") == 1);
    std::cerr.rdbuf(earlierLog);
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
    g_main_loop_unref(loop); std::cout << "portal FD transfers, Unicode paste, clipboard save and put-back, target changes, cancellation, key cleanup and intervening copy passed\n";
}
