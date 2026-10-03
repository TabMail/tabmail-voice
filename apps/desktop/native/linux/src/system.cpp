// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include <atspi/atspi.h>
#include <gio/gdesktopappinfo.h>
#include <pwd.h>
#include "channel.h"
#include "microphone.h"
#include "foreground.h"
#include "screen.h"
#include "input_session.h"
#include "portal_owner.h"
#include "insertion.h"
#include "keyboard_language.h"

namespace {
using JSON = nlohmann::json;
JSON appInfo(const JSON& params) {
    if (!params.is_object() || !params.contains("path") || !params["path"].is_string())
        throw std::runtime_error("invalid path");
    const auto path = params["path"].get<std::string>();
    if (path.size() > 4096 || path.find('\0') != std::string::npos || !path.ends_with(".desktop"))
        throw std::runtime_error("invalid path");
    auto info = g_desktop_app_info_new_from_filename(path.c_str());
    if (!info) return nullptr;
    const auto id = g_app_info_get_id(G_APP_INFO(info));
    const auto name = g_app_info_get_display_name(G_APP_INFO(info));
    JSON result = id && name ? JSON{{"bundleIdentifier", id}, {"name", name}, {"path", path}} : JSON(nullptr);
    g_object_unref(info);
    return result;
}
}
int main() {
    if (!voice::enableAccessibilityBridge()) std::cerr << "debug accessibility: bridge activation unavailable\n";
    if (atspi_init() != 0) return 1;
    atspi_set_timeout(250, 1000);
    voice::Output output;
    voice::Microphone microphone(output);
    voice::KeyboardLanguage keyboardLanguage;
    voice::Foreground foreground;
    voice::InputSession input(output);
    voice::Inserter inserter(input, [&](uint64_t token) { return foreground.matches(token); }, [&] {
        const auto target = foreground.target(); return target && target->terminal;
    });
    voice::Channel channel(output, [&](const std::string& method, const JSON& params, voice::Channel::Reply reply, int64_t id) {
        if (method == "cancel") {
            if (params.is_object() && params.contains("id") && params["id"].is_number_integer()) inserter.cancel(params["id"].get<int64_t>());
        } else if (method == "insert") {
            inserter.insert(id, params, reply);
        } else if (method == "requestInsertion") {
            const auto parent = params.value("parent", std::string{});
            if (!parent.empty() && (parent.size() > 32 || !parent.starts_with("x11:") ||
                parent.size() == 4 || !std::all_of(parent.begin() + 4, parent.end(), [](char c) { return g_ascii_isxdigit(c); })))
                throw std::runtime_error("invalid portal parent");
            input.request([reply](bool granted) { reply(JSON::object(), granted); }, parent);
        } else if (method == "restoreInsertion") {
            input.restore([reply](bool granted) { reply({{"granted", granted}}, true); });
        } else if (method == "insertionPermission") {
            reply({{"granted", input.ready()}}, true);
        } else if (method == "microphonePrepare") {
            microphone.prepare([reply](bool success) { reply(JSON::object(), success); });
        } else if (method == "microphoneStart") {
            if (!params.is_object() || !params.contains("session") || !params["session"].is_number_integer() ||
                !params.contains("sampleRate") || !params["sampleRate"].is_number_unsigned())
                throw std::runtime_error("invalid audio parameters");
            const auto session = params["session"].get<int>();
            const auto rate = params["sampleRate"].get<unsigned>();
            if (params["session"] != session || params["sampleRate"] != rate)
                throw std::runtime_error("audio parameters out of range");
            microphone.start(session, rate, [reply](bool success) { reply(JSON::object(), success); });
        } else if (method == "microphoneStop") {
            if (!params.is_object() || !params.contains("session") || !params["session"].is_number_integer())
                throw std::runtime_error("invalid audio session");
            microphone.stop(params["session"].get<int>(), [reply](bool success) { reply(JSON::object(), success); });
        } else if (method == "fullUserName") {
            const auto user = getpwuid(getuid());
            const std::string name = user && user->pw_gecos ? user->pw_gecos : "";
            reply({{"name", name.substr(0, name.find(','))}}, true);
        } else if (method == "appInfo") {
            reply(appInfo(params), true);
        } else if (method == "keyboardLanguage") {
            keyboardLanguage.read(std::move(reply));

        } else if (method == "frontmostApp") {
            const auto target = foreground.target();
            const bool focused = target && foreground.matches(target->token);
            // Opaque per-process window tokens, never window titles or field text.
            // Distinguish a missing provider result from a genuine target change.
            std::cerr << "debug accessibility: frontmost target "
                << (focused ? std::to_string(target->token) : target ? "unfocused" : "unavailable") << "\n";
            reply(focused ? JSON{{"window", target->token}} : JSON(nullptr), true);
        } else if (method == "readScreen" || method == "focusedFieldValue") {
            const auto target = foreground.target();
            const auto result = voice::screenAccess(params, target,
                [](const auto& target) -> std::optional<std::string> {
                    if (!target->app) std::cerr << "debug screen: desktop identity unavailable\n";
                    return target->app ? std::optional<std::string>(target->app->id) : std::nullopt;
                },
                [&](const auto& target, const voice::ScreenExclusions& policy) -> JSON {
                    if (!foreground.matches(target->token)) return nullptr;
                    if (method == "focusedFieldValue") {
                        if (!params.contains("window") || !params["window"].is_number_unsigned() || params["window"] != target->token ||
                            !params.contains("maxLength") || !params["maxLength"].is_number_integer()) return nullptr;
                    }
                    const auto path = voice::ancestors(target->focus);
                    const auto window = std::find_if(path.begin(), path.end(), [](const auto& node) {
                        const auto role = voice::role(node); return role == ATSPI_ROLE_FRAME || role == ATSPI_ROLE_DIALOG || role == ATSPI_ROLE_WINDOW;
                    });
                    if (window == path.end()) { std::cerr << "debug screen: focused window unavailable\n"; return nullptr; }
                    voice::LiveScreenTree tree(*window);
                    if (method == "readScreen") return voice::gatherScreen(tree, *window, target->focus, path, target->app.value_or(voice::AppIdentity{"", "Unknown"}), policy);
                    const auto limit = params["maxLength"].get<int>();
                    if (limit < 0 || limit > 20000 || params["maxLength"] != limit) return nullptr;
                    for (const auto& node : path) if (tree.isPassword(node)) return JSON{{"value", nullptr}};
                    try {
                        if (!voice::safeSubtree(tree, *window, policy, false) || !voice::safeSubtree(tree, target->focus, policy, true)) return JSON{{"value", nullptr}};
                    } catch (const voice::PrivacyHidden&) { return JSON{{"value", nullptr}}; }
                    const auto value = tree.field(target->focus, limit);
                    return value ? JSON{{"value", voice::privacy::ScreenPrivacy::redact(*value)}} : JSON(nullptr); // Local-only correction learning; never backend context.
                });
            reply(method == "focusedFieldValue" && result == voice::hiddenScreen() ? JSON{{"value", nullptr}} : result, true);
        } else {
            throw std::runtime_error("unknown method");
        }
    });
    bool portalLost = false;
    voice::PortalOwner owner([&] { portalLost = true; atspi_event_quit(); });
    atspi_event_main();
    return portalLost ? 1 : 0;
}
