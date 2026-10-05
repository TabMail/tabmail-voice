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
    const auto target = foreground.target();
    const auto result = voice::screenAccess(params, target,
        [](const auto& target) -> std::optional<std::string> {
            if (!target->app) std::cerr << "debug screen: desktop identity unavailable\n";
            return target->app ? std::optional<std::string>(target->app->id) : std::nullopt;
        },
        [&](const auto& target, const voice::ScreenExclusions& policy) -> JSON {
            if (!foreground.targets(target->token)) return nullptr;
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
    // A provider read may yield to another window while accessibility IPC is in flight.
    // Never return the previous window as the current screen/correction field.
    const auto checked = target && foreground.targets(target->token) ? result : JSON(nullptr);
    return method == "focusedFieldValue" && checked == voice::hiddenScreen() ? JSON{{"value", nullptr}} : checked;
}
}
