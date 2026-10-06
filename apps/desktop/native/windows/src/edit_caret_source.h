// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <windows.h>
#include <string>
#include <string_view>
#include "../../shared/context/CaretSource.h"
#include "../../shared/context/walk.h"

namespace voice {
class EditCaretSource {
public:
    static std::optional<CaretSource> read(HWND edit) {
        wchar_t name[16]{};
        if (!edit || !GetClassNameW(edit, name, 16) || _wcsicmp(name, L"Edit") != 0 || !permitted(edit)) return std::nullopt;
        const auto send = [&](UINT message, WPARAM value, LPARAM data) {
            DWORD_PTR result = 0;
            if (!SendMessageTimeoutW(edit, message, value, data, SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT, 200, &result))
                throw std::runtime_error("edit control did not answer");
            return result;
        };
        const auto selection = [&]() {
            DWORD start = MAXDWORD, end = MAXDWORD;
            // The packed return value loses offsets above 65535. System-message
            // marshalling supplies the complete DWORD endpoints through pointers.
            send(EM_GETSEL, reinterpret_cast<WPARAM>(&start), reinterpret_cast<LPARAM>(&end));
            return std::pair{start, end};
        };
        const auto length = send(WM_GETTEXTLENGTH, 0, 0);
        // Standard Edit has no offset-range text message. Bound its whole UTF-16
        // transfer by the shared aggregate source allowance before allocating.
        const auto limit = core::request({{"limits", true}}, voice_core_context_json).at("caretSourceBytes").get<size_t>();
        if (length > limit) return CaretSource::unavailable();
        const auto selected = selection();
        if (selected.first > selected.second || selected.second > length) return CaretSource::unavailable();
        const auto text = [&]() -> std::optional<std::wstring> {
            if (!permitted(edit)) return std::nullopt;
            std::wstring value(static_cast<size_t>(length) + 1, L'\0');
            const auto count = send(WM_GETTEXT, static_cast<WPARAM>(value.size()), reinterpret_cast<LPARAM>(value.data()));
            if (count != length) return std::nullopt;
            value.resize(static_cast<size_t>(count)); return value;
        };
        const auto original = text();
        if (!original || send(WM_GETTEXTLENGTH, 0, 0) != length || selection() != selected || text() != original ||
            send(WM_GETTEXTLENGTH, 0, 0) != length || selection() != selected || !permitted(edit)) return CaretSource::unavailable();
        const auto result = readUtf16Caret(original->size(), selected.first, selected.second, [&](size_t start, size_t end) {
            return std::wstring_view(*original).substr(start, end - start);
        });
        return result;
    }
private:
    static bool permitted(HWND edit) {
        return IsWindow(edit) && IsWindowEnabled(edit) && !(GetWindowLongPtrW(edit, GWL_STYLE) & (ES_PASSWORD | ES_READONLY));
    }
};
}
