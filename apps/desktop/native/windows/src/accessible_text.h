// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <oleacc.h>
#include <servprov.h>
#include <UIAutomation.h>
#include "../vendor/ia2/AccessibleText.h"
#include "microphone.h"
#include "text.h"
#include "../../shared/context/CaretSource.h"
#include "../../shared/context/walk.h"
#include <optional>
#include <array>
#include <algorithm>
#include <iostream>

namespace voice {
// IA2 reports logical UTF-16 offsets, including in bidirectional text. Keep its
// privacy metadata attached to this exact object: the native UIA provider and
// the MSAA bridge need not assign the same UIA identity to a field.
class AccessibleText {
public:
    static std::optional<AccessibleText> focused(HWND window, IUIAutomation* automation) {
        auto source = focusObject(window);
        if (!source) return std::nullopt;
        ComPtr<IServiceProvider> service;
        if (FAILED(source.As(&service)) || !service) return std::nullopt;
        ComPtr<IAccessibleText> text;
        if (FAILED(service->QueryService(__uuidof(IAccessible), __uuidof(IAccessibleText),
                reinterpret_cast<void**>(text.GetAddressOf()))) || !text) return std::nullopt;
        ComPtr<IUIAutomationElement> metadata;
        require(automation->ElementFromIAccessible(source.Get(), CHILDID_SELF, &metadata));
        if (!metadata) throw std::runtime_error("accessible text metadata unavailable");
        return AccessibleText{window, automation, std::move(source), std::move(text), std::move(metadata)};
    }

    IUIAutomationElement* metadata() const { return element.Get(); }

    bool valid() const {
        if (GetForegroundWindow() != window) return false;
        auto current = focusObject(window);
        if (!current) return false;
        // MSAA can marshal a fresh COM wrapper for the same field. Compare
        // the two MSAA-derived UIA elements, never COM pointer addresses or
        // identities from the separate native UIA provider.
        ComPtr<IUIAutomationElement> currentElement;
        require(automation->ElementFromIAccessible(current.Get(), CHILDID_SELF, &currentElement));
        if (!currentElement) return false;
        BOOL same = FALSE;
        require(automation->CompareElements(element.Get(), currentElement.Get(), &same));
        if (!same) {
            std::cerr << "debug accessible text: focus identity changed\n";
            return false;
        }
        VARIANT self{}; self.vt = VT_I4; self.lVal = CHILDID_SELF;
        VARIANT state{};
        require(source->get_accState(self, &state));
        const bool readable = state.vt == VT_I4 && (state.lVal & STATE_SYSTEM_FOCUSED) &&
            !(state.lVal & (STATE_SYSTEM_PROTECTED | STATE_SYSTEM_UNAVAILABLE | STATE_SYSTEM_INVISIBLE | STATE_SYSTEM_OFFSCREEN));
        VariantClear(&state);
        BOOL password = TRUE, focused = FALSE;
        require(element->get_CurrentIsPassword(&password));
        require(element->get_CurrentHasKeyboardFocus(&focused));
        if (!readable) std::cerr << "debug accessible text: protected or unavailable MSAA focus\n";
        if (password || !focused) std::cerr << "debug accessible text: protected or unavailable UIA metadata\n";
        return readable && !password && focused;
    }

    std::optional<std::wstring> value(unsigned limit) const {
        long length = 0;
        require(text->get_nCharacters(&length));
        if (length < 0 || static_cast<unsigned long>(length) > limit) return std::nullopt;
        auto result = range(0, length);
        long after = 0;
        require(text->get_nCharacters(&after));
        if (after != length || !valid()) return std::nullopt;
        return result;
    }

    std::optional<std::array<std::string, 3>> parts(bool& selectionUnavailable, ULONGLONG started) const {
        const auto before = selection();
        if (!before) { selectionUnavailable = true; return CaretSource::unavailable().parts; }
        const auto [length, start, end] = *before;
        auto result = readUtf16Caret(static_cast<size_t>(length), static_cast<size_t>(start), static_cast<size_t>(end),
            [&](size_t from, size_t to) {
                if (GetTickCount64() - started > walk::limits().timeBudgetMilliseconds) throw std::runtime_error("screen context time budget");
                auto value = range(static_cast<long>(from), static_cast<long>(to));
                if (GetTickCount64() - started > walk::limits().timeBudgetMilliseconds) throw std::runtime_error("screen context time budget");
                return value;
            });
        if (selection() != before || !valid()) result = CaretSource::unavailable();
        selectionUnavailable = result.selectionUnavailable;
        return result.parts;
    }

private:
    HWND window;
    ComPtr<IUIAutomation> automation;
    ComPtr<IAccessible> source;
    ComPtr<IAccessibleText> text;
    ComPtr<IUIAutomationElement> element;
    AccessibleText(HWND target, IUIAutomation* client, ComPtr<IAccessible> object, ComPtr<IAccessibleText> value,
                   ComPtr<IUIAutomationElement> metadata)
        : window(target), automation(client), source(std::move(object)), text(std::move(value)), element(std::move(metadata)) {}

    static ComPtr<IAccessible> focusObject(HWND window) {
        if (!window || GetForegroundWindow() != window) return {};
        GUITHREADINFO info{sizeof(GUITHREADINFO)};
        if (!GetGUIThreadInfo(GetWindowThreadProcessId(window, nullptr), &info) || !info.hwndFocus ||
            GetAncestor(info.hwndFocus, GA_ROOT) != window) return {};
        ComPtr<IAccessible> object;
        if (FAILED(AccessibleObjectFromWindow(info.hwndFocus, static_cast<DWORD>(OBJID_CLIENT), IID_PPV_ARGS(&object))) || !object) return {};
        for (unsigned depth = 0; depth < 64; ++depth) {
            VARIANT focus{};
            const HRESULT status = object->get_accFocus(&focus);
            if (status != S_OK) { VariantClear(&focus); return {}; }
            if (focus.vt == VT_I4 && focus.lVal == CHILDID_SELF) {
                VariantClear(&focus);
                return GetForegroundWindow() == window ? object : ComPtr<IAccessible>{};
            }
            ComPtr<IDispatch> child;
            if (focus.vt == VT_DISPATCH) child = focus.pdispVal;
            else if (focus.vt == VT_I4) object->get_accChild(focus, &child);
            VariantClear(&focus);
            if (!child) return {};
            ComPtr<IAccessible> next;
            if (FAILED(child.As(&next)) || !next) return {};
            object = std::move(next);
        }
        return {};
    }
    std::optional<std::array<long, 3>> selection() const {
        long length = 0, count = 0, start = -1, end = -1;
        require(text->get_nCharacters(&length));
        require(text->get_nSelections(&count));
        if (count == 0) { require(text->get_caretOffset(&start)); end = start; }
        else if (count == 1) require(text->get_selection(0, &start, &end));
        else return std::nullopt;
        if (length < 0 || start < 0 || end < start || end > length) return std::nullopt;
        return std::array<long, 3>{length, start, end};
    }
    std::wstring range(long start, long end) const {
        if (start == end) return {};
        BSTR value = nullptr;
        const HRESULT status = text->get_text(start, end, &value);
        const auto length = value ? SysStringLen(value) : 0;
        if (FAILED(status) || length != static_cast<unsigned long>(end - start)) {
            SysFreeString(value);
            throw std::runtime_error("accessible text range unavailable");
        }
        std::wstring result(value, length);
        SysFreeString(value);
        return result;
    }

};
}
