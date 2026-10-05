// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include <cmath>
#include "channel.h"
#include "portal_hotkey.h"
#include "portal_owner.h"
#include "gnome_controls.h"
#include "gnome_caret.h"

int main() {
    voice::Output output;
    voice::Gesture gesture;
    voice::GnomeCaret gnomeCaret;
    voice::GnomeControls controls(output, gesture);
    voice::PortalHotkey portal(output, gesture, [&](voice::Action action) { controls.emit(action); });
    voice::Channel channel(output, [&](const std::string& method, const nlohmann::json& params, voice::Channel::Reply reply, int64_t) {
        using JSON = nlohmann::json;
        if (method == "configure") {
            if (!params.is_object() || !params.contains("hotkey") || !params["hotkey"].is_string() ||
                !params.contains("tapMaxDuration") || !params["tapMaxDuration"].is_number() ||
                !params.contains("doubleTapWindow") || !params["doubleTapWindow"].is_number()) throw std::runtime_error("invalid configuration");
            const auto key = params["hotkey"].get<std::string>();
            const double tap = params["tapMaxDuration"], window = params["doubleTapWindow"];
            if ((key != "F8" && key != "F9") || !std::isfinite(tap) || tap < 0 || !std::isfinite(window) || window < 0)
                throw std::runtime_error("invalid shortcut configuration");
            gesture.tapMaxDuration = tap; gesture.doubleTapWindow = window;
            reply({{"installed", portal.configure(key)}}, true);
        } else if (method == "requestHotkey") {
            const auto parent = params.value("parent", std::string{});
            if (!parent.empty() && (parent.size() > 32 || !parent.starts_with("x11:") || parent.size() == 4 ||
                !std::all_of(parent.begin() + 4, parent.end(), [](char c) { return g_ascii_isxdigit(c); }))) throw std::runtime_error("invalid portal parent");
            portal.authorize(parent, std::move(reply));
        } else if (method == "caretAnchor") {
            gnomeCaret.read(std::move(reply));
        } else if (method == "gnomeIntegration") {
            gnomeCaret.integration(std::move(reply));
        } else if (method == "setRecording") {
            if (!params.is_object() || !params.contains("active") || !params["active"].is_boolean()) throw std::runtime_error("invalid recording state");
            const bool active = params["active"].get<bool>();
            controls.setRecording(active); reply(JSON::object(), true);
        } else if (method == "dictationEnded") {
            gesture.dictationEnded(); controls.setRecording(false); reply(JSON::object(), true);
        } else if (method == "setChatOpen") {
            if (!params.is_object() || !params.contains("isOpen") || !params["isOpen"].is_boolean()) throw std::runtime_error("invalid chat state");
            gesture.chatOpen = params["isOpen"].get<bool>(); controls.setChatOpen(gesture.chatOpen); reply(JSON::object(), true);
        } else throw std::runtime_error("unknown method");
    });
    auto loop = g_main_loop_new(nullptr, false);
    bool portalLost = false;
    voice::PortalOwner owner([&] { portalLost = true; g_main_loop_quit(loop); });
    g_main_loop_run(loop);
    g_main_loop_unref(loop);
    return portalLost ? 1 : 0;
}
