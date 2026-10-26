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
// A captured window can be read in the background. Its AT-SPI bus and object path identify the
// exact frame; another window of the same app never contributes a caret or a selection.
inline nlohmann::json capturedRead(const nlohmann::json& params, const Foreground& foreground) {
    using JSON = nlohmann::json;
    const auto target = core::request({{"targetWindow", params.at("target")}}, voice_core_request_json);
    const auto window = capturedWindow(target);
    if (!window) return JSON(nullptr);
    Error error;
    const auto pid = atspi_accessible_get_process_id(window.get(), &error.value);
    error.check();
    if (target["pid"] != pid) return JSON(nullptr);
    const auto app = desktopIdentity(pid);
    return screenAccess(params, window,
        [&](const auto&) { return app ? std::optional<std::string>(app->id) : std::nullopt; },
        [&](const auto&, const ScreenExclusions& policy) -> JSON {
            auto focus = window;
            auto path = ancestors(window);
            if (const auto now = foreground.target(); now && target["window"] == now->token && foreground.targets(now->token)) {
                const auto focusedPath = ancestors(now->focus);
                const auto focusedWindow = windowOf(focusedPath);
                if (focusedWindow && same(*focusedWindow, window)) { focus = now->focus; path = focusedPath; }
            }
            LiveScreenTree tree(window);
            tree.focusKept = [&](const Node& node) {
                const auto now = foreground.target();
                return now && target["window"] == now->token && foreground.targets(now->token) && same(now->focus, node);
            };
            auto result = gatherScreen(tree, window, focus, path, app.value_or(AppIdentity{"", "Unknown"}), policy);
            return state(window, ATSPI_STATE_DEFUNCT) ? JSON(nullptr) : result;
        });
}

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
            const auto window = voice::windowOf(path);
            if (!window) { std::cerr << "debug screen: focused window unavailable\n"; return nullptr; }
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
