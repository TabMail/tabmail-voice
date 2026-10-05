// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <windows.h>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>
#include <stdexcept>
#include "ScreenExclusions.h"
#include <iostream>
#include <utility>

namespace voice {
inline std::wstring executableName(HWND window) {
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return {};
    wchar_t path[32768]{};
    DWORD length = 32768;
    const bool found = QueryFullProcessImageNameW(process, 0, path, &length);
    CloseHandle(process);
    if (!found) return {};
    std::wstring name(path, length);
    const auto slash = name.find_last_of(L"\\/");
    return slash == std::wstring::npos ? name : name.substr(slash + 1);
}

// The screen-read reply for a screen not read for the user's privacy (an excluded
// app, a page of an excluded website or of an unknown address): that it is
// hidden, and nothing of it, so the app can tell the agent the screen was kept
// from it rather than empty. A read that fails for any other reason stays null.
inline nlohmann::json hiddenScreen() { return {{"hidden", true}}; }

// This is the handler boundary: validation and the one target identity lookup
// precede constructing any accessibility client or asking for window text.
// Injectable operations let tests prove refused requests perform no read at all.
template<class Target, class Identity, class Read>
inline nlohmann::json screenAccess(const nlohmann::json& params, Target target,
                                  Identity&& identity, Read&& read, bool field = false) {
    const ScreenExclusions exclusions(params);
    if (!target) return nullptr;
    if (exclusions.excludesApp(identity(target))) {
        std::cerr << "debug screen access: excluded app not read\n";
        return field ? nlohmann::json{{"value", nullptr}} : hiddenScreen();
    }
    return read(target, exclusions);
}

}
