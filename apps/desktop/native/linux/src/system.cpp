// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include <atspi/atspi.h>
#include <gio/gdesktopappinfo.h>
#include <pwd.h>
#include "channel.h"
#include "foreground.h"
#include "input_session.h"
#include "portal_owner.h"
#include "insertion.h"
#include "gnome_caret.h"
#include "keyboard_language.h"

namespace {
using JSON = nlohmann::json;
// What a saved clipboard may hold, and when it goes back: the shared core's.
voice::ClipboardKeeper::Rules clipboardRules() {
    const auto rules = voice::core::request({{"clipboard", JSON::object()}}, voice_core_request_json);
    return {rules.at("restoreDelay").get<unsigned>(), rules.at("maxBytes").get<unsigned long long>(), rules.at("maxFormats").get<size_t>()};
}
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
    voice::KeyboardLanguage keyboardLanguage;
    voice::GnomeCaret gnomeCaret;
    voice::Foreground foreground([&] { return gnomeCaret.holding(); }, [&] { return gnomeCaret.focus(); });
    voice::InputSession input(output);
    voice::ClipboardKeeper clipboard(input, clipboardRules());
    voice::Inserter inserter(input, clipboard, [&](uint64_t token) { return foreground.matches(token); }, [&] {
        const auto target = foreground.target(); return target && target->terminal;
    });
    voice::Channel channel(output, [&](const std::string& method, const JSON& params, voice::Channel::Reply reply, int64_t id) {
        if (method == "redactText") {
            reply(voice::core::request(params, voice_core_redact_text_json), true);
        } else if (method == "cancel") {
            if (params.is_object() && params.contains("id") && params["id"].is_number_integer()) inserter.cancel(params["id"].get<int64_t>());
        } else if (method == "insert") {
            inserter.insert(id, params, reply);
        } else if (method == "clipboardSave") {
            // Answered at once: the clipboard is read in the background, for the next paste to put back.
            clipboard.save();
            reply(JSON::object(), true);
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
        } else if (method == "fullUserName") {
            const auto user = getpwuid(getuid());
            const std::string name = user && user->pw_gecos ? user->pw_gecos : "";
            reply({{"name", name.substr(0, name.find(','))}}, true);
        } else if (method == "appInfo") {
            reply(appInfo(params), true);
        } else if (method == "keyboardLanguage") {
            keyboardLanguage.read(std::move(reply));

        } else if (method == "caretAnchor") {
            // The focused element's own caret, placed on the screen by the Shell.
            const auto target = foreground.target();
            const auto started = std::chrono::steady_clock::now();
            const auto elapsed = [started] {
                return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
            };
            const bool matched = target && foreground.targets(target->token);
            const auto caret = matched ? voice::caretInWindow(target->focus) : std::nullopt;
            // Geometry and timing only, never field text.
            std::cerr << "debug accessibility: caret " << (!target ? "no target" : !matched ? "stale target" : caret ? "read" : "unavailable")
                << " in " << elapsed() << "ms\n";
            if (!caret) reply(nullptr, true);
            else {
                const auto placed = gnomeCaret.fromWindow(*caret);
                std::cerr << "debug accessibility: caret placed " << (placed.is_null() ? "nowhere" : "on screen")
                    << " after " << elapsed() << "ms\n";
                reply(placed, true);
            }
        } else if (method == "frontmostApp") {
            reply(voice::frontmostApp(foreground), true);
        } else {
            throw std::runtime_error("unknown method");
        }
    });
    bool portalLost = false;
    voice::PortalOwner owner([&] { portalLost = true; atspi_event_quit(); });
    atspi_event_main();
    return portalLost ? 1 : 0;
}
