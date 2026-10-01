// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <windows.h>
#include <dwmapi.h>
#include <nlohmann/json.hpp>
#include <string_view>
#include <iterator>
#include <algorithm>

namespace voice {
// Geometry only: never request window titles, UIA values, or Search contents.
// These shell surfaces occupy a higher z-order band than ordinary app overlays.
inline nlohmann::json shellExclusionBounds() {
    nlohmann::json result = nlohmann::json::array();
    const auto collect = [](HWND window, LPARAM context) -> BOOL {
        auto& bounds = *reinterpret_cast<nlohmann::json*>(context);
        if (bounds.size() >= 16) return FALSE;
        if (!IsWindowVisible(window) || IsIconic(window)) return TRUE;
        DWORD cloaked{};
        if (FAILED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) || cloaked) return TRUE;
        DWORD pid{};
        GetWindowThreadProcessId(window, &pid);
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!process) return TRUE;
        wchar_t path[32768]{};
        DWORD length = static_cast<DWORD>(std::size(path));
        const BOOL read = QueryFullProcessImageNameW(process, 0, path, &length);
        CloseHandle(process);
        if (!read) return TRUE;
        const std::wstring_view full(path, length);
        const auto slash = full.find_last_of(L"\\/");
        const auto name = full.substr(slash == std::wstring_view::npos ? 0 : slash + 1);
        if (_wcsicmp(name.data(), L"SearchHost.exe") != 0 &&
            _wcsicmp(name.data(), L"StartMenuExperienceHost.exe") != 0) return TRUE;
        RECT rect{};
        if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect))) &&
            !GetWindowRect(window, &rect)) return TRUE;
        if (rect.right <= rect.left || rect.bottom <= rect.top) return TRUE;
        const nlohmann::json entry = {{"x", rect.left}, {"y", rect.top},
                                     {"width", rect.right - rect.left}, {"height", rect.bottom - rect.top}};
        if (std::find(bounds.begin(), bounds.end(), entry) == bounds.end()) bounds.push_back(entry);
        return TRUE;
    };
    // EnumWindows can omit modern shell surfaces; the active shell HWND is still queryable.
    collect(GetForegroundWindow(), reinterpret_cast<LPARAM>(&result));
    EnumWindows(collect, reinterpret_cast<LPARAM>(&result));
    return result;
}
}
