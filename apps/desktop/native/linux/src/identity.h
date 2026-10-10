// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <gio/gdesktopappinfo.h>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>

namespace voice {
struct AppIdentity { std::string id, name; };
// Whether `pid` is a sandbox's bus proxy (Flatpak's xdg-dbus-proxy): a sandboxed app reaches the
// accessibility bus through it, so the bus names the proxy's process, never the app's own.
inline bool busProxy(unsigned pid) {
    if (!pid) return false;
    std::ifstream name(std::filesystem::path("/proc") / std::to_string(pid) / "comm");
    std::string value;
    return std::getline(name, value) && value == "xdg-dbus-proxy";
}
// Resolve local launcher metadata, never the remote app's accessible name/title.
// Ambiguous executables are unknown rather than an identity that bypasses exclusions.
inline std::optional<AppIdentity> desktopIdentity(unsigned pid) {
    if (!pid) return {};
    const auto process = std::filesystem::path("/proc") / std::to_string(pid);
    std::ifstream environment(process / "environ", std::ios::binary);
    std::string entry;
    size_t total = 0;
    while (std::getline(environment, entry, '\0')) {
        total += entry.size() + 1;
        if (total > 1024 * 1024) break;
        constexpr std::string_view prefix = "GIO_LAUNCHED_DESKTOP_FILE=";
        if (!entry.starts_with(prefix)) continue;
        const auto path = entry.substr(prefix.size());
        if (!path.ends_with(".desktop")) break;
        auto info = g_desktop_app_info_new_from_filename(path.c_str());
        if (!info) break;
        const auto id = g_app_info_get_id(G_APP_INFO(info));
        const auto name = g_app_info_get_display_name(G_APP_INFO(info));
        const auto result = id && name ? std::optional<AppIdentity>{{id, name}} : std::nullopt;
        g_object_unref(info);
        if (result) return result;
    }
    std::error_code error;
    const auto executable = std::filesystem::read_symlink(process / "exe", error);
    if (error) return {};
    std::optional<AppIdentity> result;
    auto list = g_app_info_get_all();
    bool ambiguous = false;
    for (auto item = list; item; item = item->next) {
        auto info = G_APP_INFO(item->data);
        const auto command = g_app_info_get_executable(info);
        if (!command) continue;
        gchar* resolved = g_find_program_in_path(command);
        if (!resolved) continue;
        const auto candidate = std::filesystem::canonical(resolved, error);
        g_free(resolved);
        if (error || candidate != executable) continue;
        const auto id = g_app_info_get_id(info);
        const auto name = g_app_info_get_display_name(info);
        if (!id || !name) continue;
        if (result && result->id != id) { ambiguous = true; break; }
        result = AppIdentity{id, name};
    }
    g_list_free_full(list, g_object_unref);
    return ambiguous ? std::nullopt : result;
}
}
