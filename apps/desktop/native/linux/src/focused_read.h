// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <algorithm>
#include <iostream>
#include <optional>
#include <string>
#include <nlohmann/json.hpp>
#include "foreground.h"
#include "screen.h"

namespace voice {
// The focused window's screen (`readScreen`) or field (`focusedFieldValue`), from what has focus now.
inline nlohmann::json focusedRead(const std::string& method, const nlohmann::json& params, const Foreground& foreground) {
    using JSON = nlohmann::json;
    // The shared core decides the bound a field read may ask for (1 to 20,000 UTF-16 units) before
    // anything is looked at; one it refuses is an error, as on the other platforms.
    std::optional<int> limit;
    if (method == "focusedFieldValue")
        limit = voice::core::request({{"field", {{"maxLength", params.value("maxLength", JSON())}}}}, voice_core_request_json).at("maxLength").get<int>();
    const auto target = foreground.target();
    const auto result = voice::screenAccess(params, target,
        [](const auto& target) -> std::optional<std::string> {
            if (!target->app) std::cerr << "debug screen: desktop identity unavailable\n";
            return target->app ? std::optional<std::string>(target->app->id) : std::nullopt;
        },
        [&](const auto& target, const voice::ScreenExclusions& policy) -> JSON {
            if (!foreground.targets(target->token)) return nullptr;
            // A field is read only in the app pasted into, named by its process (window tokens are each
            // process's own): a window of another app that came to the front meanwhile is not read.
            if (method == "focusedFieldValue" &&
                (!target->pid || !params.contains("pid") || !params["pid"].is_number_unsigned() || params["pid"] != target->pid)) return nullptr;
            const auto path = voice::ancestors(target->focus);
            const auto window = std::find_if(path.begin(), path.end(), [](const auto& node) {
                const auto role = voice::role(node); return role == ATSPI_ROLE_FRAME || role == ATSPI_ROLE_DIALOG || role == ATSPI_ROLE_WINDOW;
            });
            if (window == path.end()) { std::cerr << "debug screen: focused window unavailable\n"; return nullptr; }
            if (method == "readScreen") {
                voice::LiveScreenTree tree(*window);
                tree.focusKept = [&](const voice::Node& node) {
                    const auto now = foreground.target();
                    return now && foreground.targets(now->token) && voice::same(now->focus, node);
                };
                return voice::gatherScreen(tree, *window, target->focus, path, target->app.value_or(voice::AppIdentity{"", "Unknown"}), policy);
            }
            // A terminal's text is its scrollback: its field is the box around its cursor, which the
            // shared core cuts from the viewport the screen read takes (`terminal_box`), read as it is,
            // within a field read's time: the app asks voice-field-reader for one every half second
            // while it watches the field.
            if (voice::LiveScreenTree screen(*window, voice::LiveScreenTree::fieldReadMilliseconds);
                voice::terminalInFocus(screen, target->focus, path)) {
                try {
                    size_t visited = 0;
                    const auto viewport = voice::terminalViewport(screen, *window, target->focus, path, policy, visited);
                    if (viewport.is_null()) return JSON{{"value", nullptr}};
                    return voice::core::request({{"field", {{"maxLength", *limit}, {"viewport", viewport}}}}, voice_core_request_json);
                } catch (const voice::PrivacyHidden&) { return JSON{{"value", nullptr}}; }
                catch (const voice::ScreenBudgetExceeded&) {
                    std::cerr << "debug screen: terminal field read out of time\n";
                    return JSON{{"value", nullptr}};
                }
            }
            voice::LiveScreenTree tree(*window, voice::LiveScreenTree::fieldReadMilliseconds);
            try {
                if (!voice::safeSubtree(tree, *window, policy, false) || !voice::safeSubtree(tree, target->focus, policy, true)) return JSON{{"value", nullptr}};
            } catch (const voice::PrivacyHidden&) { return JSON{{"value", nullptr}}; }
            // Characters never outnumber UTF-16 units, so the core's count in units decides the rest.
            const auto value = tree.field(target->focus, *limit);
            // No text within the bound is a field with no value, as on the other platforms.
            return voice::core::request({{"field", {{"maxLength", *limit}, {"text", value ? JSON(*value) : JSON(nullptr)}}}}, voice_core_request_json);
        });
    // A provider read may yield to another window while accessibility IPC is in flight.
    // Never return the previous window as the current screen/correction field.
    const auto checked = target && foreground.targets(target->token) ? result : JSON(nullptr);
    return method == "focusedFieldValue" && checked == voice::hiddenScreen() ? JSON{{"value", nullptr}} : checked;
}
}
