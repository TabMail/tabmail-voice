// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <oleacc.h>
#include "Privacy/ScreenPrivacy.h"
#include "Privacy/PageScan.h"
#include "Privacy/ScreenAccess.h"
#include "accessible_text.h"
#include "uia_caret_source.h"
#include "edit_caret_source.h"
#include <UIAutomation.h>
#include <string>
#include <string_view>
#include <algorithm>
#include <array>
#include <optional>
#include <iostream>
#include <cmath>
#include "microphone.h"
#include "text.h"
#include "screen_context.h"
#include "../../shared/context/SemanticText.h"
#include "helper_config.h"
#include <vector>

namespace voice {
class Automation {
public:
    Automation() { require(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation))); }
    ComPtr<IUIAutomationElement> ownedFocus(HWND expected, const char** refusal = nullptr) {
        if (refusal) *refusal = "foreground-changed";
        if (!expected || GetForegroundWindow() != expected) return {};
        ComPtr<IUIAutomationElement> element;
        require(automation->GetFocusedElement(&element));
        if (refusal) *refusal = "no-focused-element";
        if (!element) return {};
        if (refusal) *refusal = "focus-not-owned";
        return owns(expected, element.Get()) ? element : ComPtr<IUIAutomationElement>{};
    }
    bool owns(HWND expected, IUIAutomationElement* element) {
        if (!expected || !element || GetForegroundWindow() != expected) return false;
        ComPtr<IUIAutomationTreeWalker> walker;
        require(automation->get_RawViewWalker(&walker));
        ComPtr<IUIAutomationElement> ancestor = element;
        bool owned = false;
        for (unsigned depth = 0; ancestor && depth < 64; ++depth) {
            UIA_HWND window = nullptr;
            require(ancestor->get_CurrentNativeWindowHandle(&window));
            if (window && GetAncestor(static_cast<HWND>(window), GA_ROOT) == expected) { owned = true; break; }
            ComPtr<IUIAutomationElement> parent;
            require(walker->GetParentElement(ancestor.Get(), &parent));
            ancestor = parent;
        }
        return owned && GetForegroundWindow() == expected;
    }
    ComPtr<IUIAutomationElement> focused(HWND expected, const char** refusal = nullptr) {
        auto element = ownedFocus(expected, refusal);
        if (!element) return {};
        BOOL password = TRUE;
        require(element->get_CurrentIsPassword(&password));
        if (refusal) *refusal = "protected-field";
        return password ? ComPtr<IUIAutomationElement>{} : element;
    }
    bool same(IUIAutomationElement* first, IUIAutomationElement* second) {
        BOOL result = FALSE;
        require(automation->CompareElements(first, second, &result));
        return result != FALSE;
    }
    bool editable(IUIAutomationElement* element) {
        if (!element) return false;
        BOOL enabled = FALSE;
        require(element->get_CurrentIsEnabled(&enabled));
        if (!enabled) return false;
        ComPtr<IUIAutomationValuePattern> value;
        if (SUCCEEDED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&value))) && value) {
            BOOL readOnly = TRUE;
            require(value->get_CurrentIsReadOnly(&readOnly));
            return !readOnly;
        }
        ComPtr<IUIAutomationTextEditPattern> edit;
        return SUCCEEDED(element->GetCurrentPatternAs(UIA_TextEditPatternId, IID_PPV_ARGS(&edit))) && edit;
    }
    // A terminal canvas accepts keyboard input without exposing an editable value.
    // Keep this separate from editable(): terminal output is not a whole-field value.
    bool acceptsInput(HWND window, IUIAutomationElement* element) {
        if (editable(element)) return true;
        if (!element || !caretEligible(element) || _wcsicmp(executableName(window).c_str(), L"WindowsTerminal.exe") != 0) return false;
        BOOL password = TRUE;
        require(element->get_CurrentIsPassword(&password));
        if (password) return false;
        CONTROLTYPEID type = 0;
        require(element->get_CurrentControlType(&type));
        if (type != UIA_TextControlTypeId) return false;
        struct ClassName { BSTR value = nullptr; ~ClassName() { SysFreeString(value); } } name;
        require(element->get_CurrentClassName(&name.value));
        if (!name.value || std::wstring_view(name.value, SysStringLen(name.value)) != L"TermControl") return false;
        ComPtr<IUIAutomationTextPattern> text;
        return SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&text))) && text;
    }
    JSON caret(HWND window) {
        const char* refusal = nullptr;
        auto element = focused(window, &refusal);
        if (!element) {
            std::cerr << "debug caret lookup: " << refusal << '\n';
            return nullptr;
        }
        if (!caretEligible(element.Get())) {
            std::cerr << "debug caret lookup: ineligible-focused-element\n";
            return nullptr;
        }
        const bool isEditable = editable(element.Get());
        JSON result = nullptr;
        ComPtr<IUIAutomationTextPattern2> text;
        if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPattern2Id, IID_PPV_ARGS(&text))) && text) {
            BOOL active = FALSE;
            ComPtr<IUIAutomationTextRange> range;
            require(text->GetCaretRange(&active, &range));
            if (active && range) result = rangeRect(range.Get());
        }
        const char* source = result.is_null() ? "none" : "text-pattern-caret";
        if (result.is_null()) {
            result = editCaret(element.Get(), window);
            if (!result.is_null()) source = "win32-edit-caret";
        }
        if (result.is_null()) {
            result = accessibleCaret(element.Get(), window);
            if (!result.is_null()) source = "accessible-caret";
        }
        // Geometry capabilities are independent of editable-value capabilities.
        // Providers without an editable value may expose an active TextPattern2
        // caret or a collapsed TextPattern selection (for example terminal grids).
        if (result.is_null()) {
            result = textAnchor(element.Get(), !isEditable);
            if (!result.is_null()) source = "text-selection";
        }
        if (result.is_null() && isEditable) {
            // Like the Mac locator, use a field-sized focus frame when no text range
            // exposes geometry. Refuse a page-sized element or an off-screen field.
            BOOL offscreen = TRUE;
            RECT frame{};
            require(element->get_CurrentIsOffscreen(&offscreen));
            require(element->get_CurrentBoundingRectangle(&frame));
            const double height = static_cast<double>(frame.bottom) - frame.top;
            if (!offscreen && height <= 120.0 * GetDpiForWindow(window) / 96.0) {
                result = rectangle(frame.left, frame.top, static_cast<double>(frame.right) - frame.left, height);
                if (!result.is_null()) source = "focused-field-frame";
            }
        }
        auto current = focused(window);
        if (!current || !caretEligible(current.Get()) || !same(element.Get(), current.Get()) || GetForegroundWindow() != window) {
            std::cerr << "debug caret lookup: focus-changed-during-lookup\n";
            return nullptr;
        }
        if (result.is_null()) std::cerr << "debug caret lookup: no-caret-geometry\n";
        else std::cerr << "debug caret source: " << source << '\n';
        return result;
    }
    JSON fieldValue(HWND window, unsigned maxLength, const ScreenExclusions& exclusions) {
        const char* refusal = nullptr;
        auto element = focused(window, &refusal);
        if (!element && refusal && std::string_view(refusal) == "protected-field") return {{"value", nullptr}};
        if (!element) return nullptr;
        if (refusedPages(window, element.Get(), exclusions, 200, true)) return {{"value", nullptr}};
        if (!editable(element.Get())) return nullptr;
        if (!safeTextSubtree(element.Get(), GetTickCount64(), 200)) return {{"value", nullptr}};
        std::optional<std::wstring> value;
        auto logical = AccessibleText::focused(window, automation.Get());
        if (logical) {
            // Preflight the metadata of the exact IA2 text object. Its bridged
            // identity can differ from the native provider's focused element.
            if (!logical->valid() || !owns(window, logical->metadata()) ||
                refusedPages(window, logical->metadata(), exclusions, 200, true) ||
                !safeTextSubtree(logical->metadata(), GetTickCount64(), 200)) return {{"value", nullptr}};
            value = logical->value(maxLength);
        } else {
            ComPtr<IUIAutomationTextPattern> pattern;
            if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern))) && pattern) {
                ComPtr<IUIAutomationTextRange> document;
                require(pattern->get_DocumentRange(&document));
                if (!document) return nullptr;
                BSTR text = nullptr;
                // One extra UTF-16 unit distinguishes a complete field from truncation.
                require(document->GetText(static_cast<int>(maxLength) + 1, &text));
                if (!text) value = std::wstring{};
                else {
                    const auto length = SysStringLen(text);
                    if (length <= maxLength) value = std::wstring(text, length);
                    SysFreeString(text);
                }
            } else value = editValue(element.Get(), maxLength);
        }
        if (!value) return nullptr;
        // Chromium's empty textarea TextPattern can expose an embedded-object
        // placeholder. Only treat it as empty when its ValuePattern confirms that.
        if (*value == L"\uFFFC" && emptyValue(element.Get())) value = std::wstring{};
        auto current = focused(window);
        if (!current || !editable(current.Get()) || !same(element.Get(), current.Get()) || GetForegroundWindow() != window) return nullptr;
        return {{"value", privacy::ScreenPrivacy::redact(utf8(*value))}};
    }

    JSON readScreen(HWND window, const ScreenExclusions& exclusions) {
        if (!window || GetForegroundWindow() != window) return nullptr;
        // Without a focused element in this window (none at all, or the focus is in another
        // of the app's windows) the window is still read, without a caret, as on the Mac.
        auto element = ownedFocus(window);
        if (GetForegroundWindow() != window) return nullptr;
        BOOL protectedFocus = FALSE;
        if (element) {
            protectedFocus = TRUE;
            require(element->get_CurrentIsPassword(&protectedFocus));
        }
        const auto started = GetTickCount64();
        std::optional<PageHost> focusedPage;
        if (element && refusedPages(window, element.Get(), exclusions, 1500, false, &focusedPage)) return hiddenScreen();
        // A protected focus contributes only the caret marker. Never ask it for
        // value/text patterns, including the editable capability probe.
        const bool isEditable = element && !protectedFocus && editable(element.Get());
        // A page that has the focus itself and can't be edited is no field: the walk reads
        // it as it is laid out, and only what is selected in it is kept, as on the Mac.
        // Terminals use visible native ranges and an independent caret anchor, before the
        // generic field reader can request scrollback or whole-field context.
        const std::wstring app = executableName(window);
        const bool terminal = std::any_of(std::begin(HelperConfig::terminalApps), std::end(HelperConfig::terminalApps),
            [&](const wchar_t* name) { return _wcsicmp(app.c_str(), name) == 0; });
        if (terminal) return readTerminalScreen(window, element.Get(), app, exclusions, started);
        const bool pageInFocus = element && !protectedFocus && !isEditable && !terminal && isDocument(element.Get());
        std::optional<std::array<std::string, 3>> parts;
        std::string pageSelection;
        bool selectionUnavailable = false;
        auto logical = isEditable ? AccessibleText::focused(window, automation.Get()) : std::nullopt;
        if (logical) {
            if (!logical->valid()) return nullptr;
            if (!owns(window, logical->metadata())) {
                std::cerr << "debug accessible text: metadata ownership unavailable\n";
                return nullptr;
            }
            if (refusedPages(window, logical->metadata(), exclusions, 1500, false)) return hiddenScreen();
            // A field that can't be shown safe gives no caret text, and the rest of the
            // window is still read, as for a field read through UI Automation below.
            if (safeTextSubtree(logical->metadata(), started, 1500)) parts = logical->parts(selectionUnavailable, started);
            else std::cerr << "debug accessible text: protected or incomplete subtree\n";
        } else if (isEditable) {
            if (safeTextSubtree(element.Get(), started, 1500)) parts = textParts(element.Get(), selectionUnavailable, started);
        } else if (pageInFocus) pageSelection = selectedInPage(element.Get(), exclusions, selectionUnavailable, started);
        else if (element && !protectedFocus && terminal) parts = readOnlyParts(element.Get(), selectionUnavailable, started);
        const std::string left = parts ? (*parts)[0] : "";
        const std::string selection = parts ? (*parts)[1] : pageSelection;
        const std::string right = parts ? (*parts)[2] : "";
        VisibleContext context({left, selection, right});
        const std::string caretText = left + "‸" + selection + (selection.empty() ? "" : "‸") + right;
        // Only a page that is excluded, or whose address is unknown, is reported as hidden;
        // a read that stopped because the window lost the foreground is no context.
        bool hiddenPage = false;
        std::optional<std::wstring> walkedHost;
        const FocusRead focus{element.Get(), terminal, !terminal && (protectedFocus || parts.has_value()), !pageSelection.empty()};
        if (!readVisible(window, focus, caretText, started, context, exclusions, hiddenPage, walkedHost)) {
            return hiddenPage ? hiddenScreen() : JSON(nullptr);
        }
        wchar_t title[513]{};
        GetWindowTextW(window, title, 513);
        auto current = ownedFocus(window);
        if (GetForegroundWindow() != window || !element != !current) return nullptr;
        if (element) {
            BOOL password = TRUE, unchanged = FALSE;
            require(element->get_CurrentIsPassword(&password));
            require(automation->CompareElements(element.Get(), current.Get(), &unchanged));
            if (password != protectedFocus || !unchanged || (logical && !logical->valid())) return nullptr;
        }
        std::array<std::string, 3> caret{left, selection, right};
        const bool redactionChangedSelection = privacy::ScreenPrivacy::apply(context, caret);
        const bool selectionRedacted = selectionUnavailable || redactionChangedSelection;
        const auto rendered = context.render();
        const auto summary = "Windows screen context: " + std::to_string(context.nodes) + " nodes, " +
            std::to_string(context.count()) + " blocks, " + std::to_string(rendered.size()) + " bytes, " +
            std::to_string(GetTickCount64() - started) + " ms" +
            (context.stopped.empty() ? "" : ", stopped: " + context.stopped);
        // The page the focus is in; without one, the first page the walk reached, as on the Mac.
        const auto pageName = focusedPage && focusedPage->kind == PageHost::Kind::host ? std::optional<std::wstring>(focusedPage->name) : walkedHost;
        return {{"appName", utf8(app)}, {"bundleID", nullptr}, {"windowTitle", privacy::ScreenPrivacy::redact(utf8(title))},
            {"host", pageName ? JSON(utf8(*pageName)) : JSON(nullptr)}, {"terminalProgram", nullptr}, {"focusedRole", isEditable ? "editable text" : "control"},
            {"textBeforeCaret", caret[0]}, {"selectedText", caret[1]}, {"textAfterCaret", caret[2]},
            {"selectionRedacted", selectionRedacted},
            {"renderedText", rendered}, {"summary", summary}, {"logDescription", rendered}};
    }

private:
    std::optional<PageHost> pageHost(IUIAutomationElement* element) {
        CONTROLTYPEID type = 0;
        require(element->get_CurrentControlType(&type));
        if (type != UIA_DocumentControlTypeId) return std::nullopt;
        // Chromium's native UIA ValueValue property is often unsupported for a
        // document, while its standard LegacyIAccessible value is the page URL.
        // Ask the document itself, never the editable browser address field.
        ComPtr<IUIAutomationLegacyIAccessiblePattern> legacy;
        const HRESULT status = element->GetCurrentPatternAs(UIA_LegacyIAccessiblePatternId, IID_PPV_ARGS(&legacy));
        if (SUCCEEDED(status) && legacy) {
            BSTR address = nullptr;
            if (FAILED(legacy->get_CurrentValue(&address))) return PageHost{};
            const std::wstring value(address ? address : L"", address ? SysStringLen(address) : 0);
            SysFreeString(address);
            if (!value.empty()) return hostOfAddress(value);
        } else if (FAILED(status) && status != UIA_E_NOTSUPPORTED) return PageHost{};
        // A property-cache query can turn a provider's failed Value read into
        // NotSupported; even the pattern getter can return a default empty string.
        // An advertised address therefore needs an actual string property value
        // to establish emptiness. Missing data is unknown, not an addressless page.
        ComPtr<IUIAutomationValuePattern> addressPattern;
        const HRESULT patternStatus = element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&addressPattern));
        if (SUCCEEDED(patternStatus) && addressPattern) {
            BSTR address = nullptr;
            if (FAILED(addressPattern->get_CurrentValue(&address))) return PageHost{};
            const std::wstring value(address ? address : L"", address ? SysStringLen(address) : 0);
            SysFreeString(address);
            if (!value.empty()) return hostOfAddress(value);
        }
        if (FAILED(patternStatus) && patternStatus != UIA_E_NOTSUPPORTED) return PageHost{};
        VARIANT value;
        VariantInit(&value);
        const HRESULT result = element->GetCurrentPropertyValueEx(UIA_ValueValuePropertyId, TRUE, &value);
        PageHost page;
        if (SUCCEEDED(result)) {
            if (value.vt == VT_BSTR) page = hostOfAddress(std::wstring(value.bstrVal ? value.bstrVal : L"", value.bstrVal ? SysStringLen(value.bstrVal) : 0));
            else {
                BOOL unsupported = FALSE;
                if (!addressPattern && (value.vt == VT_EMPTY ||
                    (SUCCEEDED(automation->CheckNotSupported(value, &unsupported)) && unsupported)))
                    page = {PageHost::Kind::noHost, {}};
            }
        } else if (result == UIA_E_NOTSUPPORTED && !addressPattern) page = {PageHost::Kind::noHost, {}};
        VariantClear(&value);
        return page;
    }
    struct PageTree {
        using Node = ComPtr<IUIAutomationElement>;
        Automation* owner;
        ComPtr<IUIAutomationTreeWalker> walker;
        ULONGLONG started, budget;
        bool protectedNode = false;
        ComPtr<IUIAutomationCacheRequest> passwordCache;
        bool withinBudget() const { return GetTickCount64() - started <= budget; }
        bool isPassword(const Node& node) {
            BOOL password = TRUE;
            require(passwordCache ? node->get_CachedIsPassword(&password) : node->get_CurrentIsPassword(&password));
            protectedNode = protectedNode || password != FALSE;
            return password != FALSE;
        }
        std::optional<PageHost> page(const Node& node) { return owner->pageHost(node.Get()); }
        std::vector<Node> children(const Node& node, size_t limit) {
            std::vector<Node> result;
            if (!limit || !withinBudget()) return result;
            Node child;
            require(passwordCache ? walker->GetFirstChildElementBuildCache(node.Get(), passwordCache.Get(), &child)
                                  : walker->GetFirstChildElement(node.Get(), &child));
            while (child && result.size() < limit && withinBudget()) {
                result.push_back(child);
                Node next;
                require(passwordCache ? walker->GetNextSiblingElementBuildCache(child.Get(), passwordCache.Get(), &next)
                                      : walker->GetNextSiblingElement(child.Get(), &next));
                child = next;
            }
            return result;
        }
    };
    bool safeTextSubtree(IUIAutomationElement* root, ULONGLONG started, ULONGLONG budget) {
        PageTree tree{this, {}, started, budget};
        require(automation->get_RawViewWalker(&tree.walker));
        // Fetch only the password metadata with each raw-tree navigation result.
        // The cache is local to this census and covers one element, never a
        // materialized subtree or provider text. This saves a cross-process
        // property call per node while retaining the same node/time bounds.
        require(automation->CreateCacheRequest(&tree.passwordCache));
        require(tree.passwordCache->AddProperty(UIA_IsPasswordPropertyId));
        require(tree.passwordCache->put_TreeScope(TreeScope_Element));
        ComPtr<IUIAutomationCondition> raw;
        require(automation->get_RawViewCondition(&raw));
        require(tree.passwordCache->put_TreeFilter(raw.Get()));
        if (!tree.withinBudget()) {
            std::cerr << "debug aggregate text refused: time budget\n";
            return false;
        }
        ComPtr<IUIAutomationElement> cachedRoot;
        require(root->BuildUpdatedCache(tree.passwordCache.Get(), &cachedRoot));
        if (!cachedRoot) throw std::runtime_error("missing aggregate metadata");
        const auto safe = privacy::safeTextSubtree(tree, cachedRoot);
        if (!safe) {
            // Categories only: never log provider text or accessibility identity.
            std::cerr << "debug aggregate text refused: "
                << (tree.protectedNode ? "protected descendant" : !tree.withinBudget() ? "time budget" : "incomplete census") << '\n';
        }
        return safe;
    }
    bool refusedPages(HWND window, IUIAutomationElement* focus, const ScreenExclusions& exclusions,
                      ULONGLONG budget, bool field, std::optional<PageHost>* focusedPage = nullptr) {
        PageTree tree{this, {}, GetTickCount64(), budget};
        require(automation->get_RawViewWalker(&tree.walker));
        ComPtr<IUIAutomationElement> node = focus;
        for (unsigned depth = 0; node && depth < 200 && tree.withinBudget(); ++depth) {
            if (!tree.isPassword(node)) {
                const auto page = tree.page(node);
                if (focusedPage && !*focusedPage && page) *focusedPage = page;
                if (page && exclusions.excludes(*page)) {
                    std::cerr << "debug screen access: excluded or unknown page not read\n";
                    return true;
                }
            }
            ComPtr<IUIAutomationElement> parent;
            require(tree.walker->GetParentElement(node.Get(), &parent));
            node = parent;
        }
        if (privacy::holdsExcludedPage(tree, ComPtr<IUIAutomationElement>(focus), exclusions, true)) {
            std::cerr << "debug screen access: excluded or unknown page not read\n";
            return true;
        }
        if (field) {
            ComPtr<IUIAutomationElement> root;
            require(automation->ElementFromHandle(window, &root));
            if (root && privacy::holdsExcludedPage(tree, root, exclusions, false)) {
                std::cerr << "debug screen access: excluded or unknown page not read\n";
                return true;
            }
        }
        return false;
    }
    static bool caretEligible(IUIAutomationElement* element) {
        BOOL enabled = FALSE, focused = FALSE, offscreen = TRUE;
        require(element->get_CurrentIsEnabled(&enabled));
        require(element->get_CurrentHasKeyboardFocus(&focused));
        require(element->get_CurrentIsOffscreen(&offscreen));
        if (!enabled || !focused || offscreen) return false;
        ComPtr<IUIAutomationValuePattern> value;
        if (SUCCEEDED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&value))) && value) {
            BOOL readOnly = TRUE;
            require(value->get_CurrentIsReadOnly(&readOnly));
            if (readOnly) return false;
        }
        return true;
    }
    static std::string elementName(IUIAutomationElement* element) {
        struct Name { BSTR value = nullptr; ~Name() { SysFreeString(value); } } name;
        if (FAILED(element->get_CurrentName(&name.value)) || !name.value) return {};
        return readUtf16Snapshot(std::wstring_view(name.value, SysStringLen(name.value))).text;
    }
    static void appendVisibleField(IUIAutomationElement* element, VisibleContext& context,
                                   std::optional<ContextFrame> frame, ULONGLONG started) {
        ComPtr<IUIAutomationTextPattern> text;
        const auto status = element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&text));
        if (status == UIA_E_NOTSUPPORTED || (SUCCEEDED(status) && !text)) return;
        require(status);
        UiaCaretSource::appendField(text.Get(), context, frame, started);
    }
    static std::string controlText(IUIAutomationTextPattern* document, IUIAutomationElement* element, const RECT& frame, ULONGLONG started) {
        if (!document) return {};
        ComPtr<IUIAutomationTextRange> range;
        if (FAILED(document->RangeFromChild(element, &range)) || !range) return {};
        SAFEARRAY* rectangles = nullptr;
        if (FAILED(range->GetBoundingRectangles(&rectangles)) || !rectangles) return {};
        LONG first = 0, last = -1;
        bool valid = SafeArrayGetDim(rectangles) == 1 && SUCCEEDED(SafeArrayGetLBound(rectangles, 1, &first)) &&
            SUCCEEDED(SafeArrayGetUBound(rectangles, 1, &last)) && last >= first &&
            (last - first + 1) % 4 == 0 && last - first < 256;
        bool visible = false;
        for (LONG index = first; valid && index <= last; index += 4) {
            double rect[4]{};
            for (LONG part = 0; part < 4; ++part) {
                LONG position = index + part;
                if (FAILED(SafeArrayGetElement(rectangles, &position, &rect[part])) || !std::isfinite(rect[part])) valid = false;
            }
            if (rect[2] < 0 || rect[3] < 0 || rect[0] < frame.left - 1 || rect[1] < frame.top - 1 ||
                rect[0] + rect[2] > frame.right + 1 || rect[1] + rect[3] > frame.bottom + 1) valid = false;
            visible = visible || (rect[2] > 0 && rect[3] > 0);
        }
        SafeArrayDestroy(rectangles);
        if (!valid || !visible) return {};
        const auto result = UiaCaretSource::rangeSource(range.Get(), started);
        // An embedded-object marker is not a visible caption.
        return result == "\xEF\xBF\xBC" ? "" : result;
    }
    // What is selected in a page that has the focus itself. Empty when nothing is, when the
    // provider gives no single text selection, or when what holds it can't be shown safe.
    std::string selectedInPage(IUIAutomationElement* page, const ScreenExclusions& exclusions, bool& selectionUnavailable, ULONGLONG started) {
        CONTROLTYPEID type = 0;
        if (FAILED(page->get_CurrentControlType(&type)) || type != UIA_DocumentControlTypeId) return {};
        ComPtr<IUIAutomationTextPattern> pattern;
        if (FAILED(page->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern))) || !pattern) return {};
        ComPtr<IUIAutomationTextRangeArray> selections;
        if (FAILED(pattern->GetSelection(&selections)) || !selections) return {};
        int count = 0;
        if (FAILED(selections->get_Length(&count)) || count != 1) return {};
        ComPtr<IUIAutomationTextRange> selected, whole;
        if (FAILED(selections->GetElement(0, &selected)) || !selected) return {};
        if (FAILED(pattern->get_DocumentRange(&whole)) || !whole) return {};
        // A caret alone selects nothing, and is asked for no text.
        int extent = 0;
        if (FAILED(selected->CompareEndpoints(TextPatternRangeEndpoint_Start, selected.Get(), TextPatternRangeEndpoint_End, &extent)) || extent == 0) return {};
        // A range's text takes in everything under it, so what encloses the selection is
        // looked through first. Its own short budget leaves the walk its time.
        ComPtr<IUIAutomationElement> enclosing;
        if (FAILED(selected->GetEnclosingElement(&enclosing)) || !enclosing) return {};
        try {
            PageTree tree{this, {}, GetTickCount64(), HelperConfig::contextSelectionScanMs};
            require(automation->get_RawViewWalker(&tree.walker));
            if (privacy::holdsExcludedPage(tree, enclosing, exclusions, true)) return {};
            if (!privacy::safeTextSubtree(tree, enclosing)) return {};
            const auto value = UiaCaretSource::selectedText(pattern.Get(), selected.Get(), whole.Get(), started);
            if (value) return *value;
            selectionUnavailable = true;
            return CaretSource::unavailable().parts[1];
        } catch (const std::exception&) {
            return {};
        }
    }
    // The text around the caret in a terminal's focused pane, which is no editable field.
    // None when it gives no text selection or can't be shown safe.
    std::optional<std::array<std::string, 3>> readOnlyParts(IUIAutomationElement* element, bool& selectionUnavailable, ULONGLONG started) {
        ComPtr<IUIAutomationTextPattern> pattern;
        if (FAILED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern))) || !pattern) return std::nullopt;
        try {
            if (!safeTextSubtree(element, GetTickCount64(), HelperConfig::contextSelectionScanMs)) return std::nullopt;
            return textParts(element, selectionUnavailable, started);
        } catch (const std::exception&) {
            return std::nullopt;
        }
    }
    static bool isDocument(IUIAutomationElement* element) {
        CONTROLTYPEID type = 0;
        return SUCCEEDED(element->get_CurrentControlType(&type)) && type == UIA_DocumentControlTypeId;
    }
    static bool isControl(CONTROLTYPEID type) {
        return type == UIA_ButtonControlTypeId || type == UIA_SplitButtonControlTypeId || type == UIA_CheckBoxControlTypeId ||
            type == UIA_RadioButtonControlTypeId || type == UIA_ComboBoxControlTypeId;
    }
    // Interface chrome, skipped with everything under it. In a page its controls and
    // toolbars hold content, and are read.
    static bool isChrome(CONTROLTYPEID type, bool web) {
        return type == UIA_MenuBarControlTypeId || type == UIA_MenuControlTypeId ||
            type == UIA_MenuItemControlTypeId || type == UIA_ImageControlTypeId ||
            type == UIA_ScrollBarControlTypeId || type == UIA_SliderControlTypeId ||
            type == UIA_SpinnerControlTypeId || (!web && (isControl(type) || type == UIA_ToolBarControlTypeId));
    }
    // A row of a table or of an app's own list, read as one block of its cells like the Mac's
    // table row. A page's list item is no row: it is walked into.
    static bool isRow(CONTROLTYPEID type, bool web) {
        return type == UIA_DataItemControlTypeId || (!web && type == UIA_ListItemControlTypeId);
    }
    // Where an element is, and whether it can show text there: in the window, not off screen.
    // A box at most a pixel thin shows nothing (screen-reader-only text, a list item
    // scrolled out of view); one that reports no size says nothing and counts as shown.
    struct Placement {
        bool shown;
        std::optional<ContextFrame> geometry;
        RECT frame;
    };
    static std::optional<Placement> placement(IUIAutomationElement* node, const RECT& windowFrame, double hiddenThickness) {
        BOOL offscreen = TRUE;
        RECT frame{};
        if (FAILED(node->get_CurrentIsOffscreen(&offscreen)) || FAILED(node->get_CurrentBoundingRectangle(&frame))) return std::nullopt;
        const double width = static_cast<double>(frame.right) - frame.left;
        const double height = static_cast<double>(frame.bottom) - frame.top;
        const bool sized = width > 0 && height > 0;
        RECT intersection{};
        const bool inWindow = !sized || IntersectRect(&intersection, &frame, &windowFrame);
        const bool shown = !offscreen && inWindow &&
            ((width == 0 && height == 0) || std::min(width, height) > hiddenThickness);
        const std::optional<ContextFrame> geometry = sized ?
            std::optional<ContextFrame>{{static_cast<double>(frame.left), static_cast<double>(frame.top), width, height}} : std::nullopt;
        return Placement{shown, geometry, frame};
    }
    // An element's children in the provider's order: no more than the walk could still
    // visit, and none past its time.
    static std::vector<ComPtr<IUIAutomationElement>> childrenOf(IUIAutomationTreeWalker* walker, IUIAutomationElement* node,
                                                                 size_t limit, ULONGLONG started, bool& outOfTime) {
        std::vector<ComPtr<IUIAutomationElement>> children;
        ComPtr<IUIAutomationElement> child;
        if (FAILED(walker->GetFirstChildElement(node, &child))) return children;
        while (child && children.size() < limit) {
            if (GetTickCount64() - started > 1500) { outOfTime = true; break; }
            children.push_back(child);
            ComPtr<IUIAutomationElement> next;
            if (FAILED(walker->GetNextSiblingElement(child.Get(), &next))) break;
            child = next;
        }
        return children;
    }
    struct WalkFrame { RECT window; double hiddenThickness; };
    // Text of a heading, link or row gathered from what is under it, as the walk reads it:
    // its text, its fields' and in a page its controls' captions. None when a page of an
    // excluded website is among them.
    bool subtreeText(IUIAutomationElement* root, IUIAutomationTreeWalker* walker, SemanticText& reducer, bool web,
                                           IUIAutomationTextPattern* document, const WalkFrame& within, ULONGLONG started,
                                           const ScreenExclusions& exclusions, VisibleContext& context) {
        bool outOfTime = false;
        std::vector<ComPtr<IUIAutomationElement>> stack;
        const auto push = [&](IUIAutomationElement* parent) {
            auto children = childrenOf(walker, parent, 5001 - std::min<size_t>(context.nodes, 5000), started, outOfTime);
            for (auto child = children.rbegin(); child != children.rend(); ++child) stack.push_back(std::move(*child));
        };
        if (context.nodes < 5000 && GetTickCount64() - started <= 1500) push(root);
        else outOfTime = GetTickCount64() - started > 1500;
        while (!stack.empty() && reducer.decision() == SemanticText::Decision::descendants && context.nodes < 5000 && !outOfTime) {
            if (GetTickCount64() - started > 1500) { outOfTime = true; break; }
            const auto element = std::move(stack.back());
            stack.pop_back();
            ++context.nodes;
            auto* node = element.Get();
            BOOL password = TRUE;
            if (FAILED(node->get_CurrentIsPassword(&password)) || password) continue;
            if (const auto page = pageHost(node); page && exclusions.excludes(*page)) return false;
            CONTROLTYPEID type = 0;
            if (FAILED(node->get_CurrentControlType(&type)) || isChrome(type, web)) continue;
            const auto place = placement(node, within.window, within.hiddenThickness);
            // A box that shows nothing is not gone into, as in the walk itself.
            if (!place || !place->shown) continue;
            std::string piece;
            bool read = false;
            if (web && isControl(type)) {
                piece = safeTextSubtree(node, started, 1500) ? controlText(document, node, place->frame, started) : "";
                read = !piece.empty();
            } else if (type == UIA_TextControlTypeId) {
                piece = safeTextSubtree(node, started, 1500) ? elementName(node) : "";
                read = !piece.empty();
            } else if (type == UIA_EditControlTypeId && safeTextSubtree(node, started, 1500)) {
                VisibleContext field;
                appendVisibleField(node, field, {}, started);
                for (const auto& parts : field.fieldSources()) {
                    if (reducer.decision() != SemanticText::Decision::descendants) break;
                    reducer.offerProjected(SemanticText::Event::descendant, parts);
                }
                continue;
            }
            if (!read) { push(node); continue; }
            reducer.offer(SemanticText::Event::descendant, piece);
        }
        if (reducer.decision() == SemanticText::Decision::descendants)
            reducer.offer(stack.empty() && !outOfTime && context.nodes < 5000 ? SemanticText::Event::complete : SemanticText::Event::interrupted);
        if (outOfTime) context.stopped = "time budget";
        else if (!stack.empty() && context.nodes >= 5000) context.stopped = "node budget";
        return true;
    }
    std::optional<nlohmann::json> semanticText(IUIAutomationElement* root, IUIAutomationTreeWalker* walker, SemanticText::Kind kind, bool web,
                                           IUIAutomationTextPattern* document, const WalkFrame& within, ULONGLONG started,
                                           const ScreenExclusions& exclusions, VisibleContext& context) {
        SemanticText reducer(kind);
        const auto rootText = [&] { return safeTextSubtree(root, started, 1500) ? elementName(root) : std::string(); };
        if (reducer.decision() == SemanticText::Decision::root) reducer.offer(SemanticText::Event::root, rootText());
        if (reducer.decision() == SemanticText::Decision::descendants &&
            !subtreeText(root, walker, reducer, web, document, within, started, exclusions, context)) return std::nullopt;
        if (reducer.decision() == SemanticText::Decision::root) reducer.offer(SemanticText::Event::root, rootText());
        return std::optional<nlohmann::json>(std::in_place, reducer.projectedSource());
    }
    JSON readTerminalScreen(HWND window, IUIAutomationElement* focus, const std::wstring& app,
                            const ScreenExclusions& exclusions, ULONGLONG started) {
        ComPtr<IUIAutomationElement> root;
        require(automation->ElementFromHandle(window, &root));
        ComPtr<IUIAutomationTreeWalker> walker;
        require(automation->get_RawViewWalker(&walker));
        RECT windowFrame{};
        if (!root || !GetWindowRect(window, &windowFrame)) return nullptr;
        const auto valid = [&] {
            RECT currentFrame{};
            auto current = ownedFocus(window);
            return GetTickCount64()-started<=1500 && GetForegroundWindow()==window &&
                GetWindowRect(window,&currentFrame) && EqualRect(&windowFrame,&currentFrame) &&
                ((focus && current && same(focus,current.Get())) || (!focus && !current));
        };
        PageTree privacyTree{this,walker,started,1500};
        if (privacy::holdsExcludedPage(privacyTree,root,exclusions,true)) return hiddenScreen();
        std::vector<ComPtr<IUIAutomationElement>> focusPath;
        ComPtr<IUIAutomationElement> ancestor=focus;
        while (ancestor && focusPath.size()<200 && valid()) {
            focusPath.push_back(ancestor);
            if (same(ancestor.Get(),root.Get())) break;
            ComPtr<IUIAutomationElement> parent;
            require(walker->GetParentElement(ancestor.Get(),&parent)); ancestor=parent;
        }
        const auto limits=core::request({{"limits",true}},voice_core_viewport_json);
        size_t remaining=limits.at("bytes").get<size_t>(),visited=0;
        const size_t maxSurfaces=limits.at("surfaces").get<size_t>();
        struct Entry { ComPtr<IUIAutomationElement> node; RECT clip; };
        struct Capture { ComPtr<IUIAutomationElement> node; ComPtr<IUIAutomationTextPattern> pattern; ContextFrame frame; bool focused; JSON value; };
        std::vector<Entry> stack{{root,windowFrame}},geometry;
        std::vector<ComPtr<IUIAutomationElement>> seen;
        std::vector<Capture> captures;
        JSON surfaces=JSON::array(),focusedID=nullptr,caret={{"status","unavailable"}};
        bool complete=true;
        const auto geometryStable=[&] {
            for (const auto& item:geometry) {
                RECT now{}; BOOL offscreen=TRUE;
                if (FAILED(item.node->get_CurrentBoundingRectangle(&now)) || !EqualRect(&now,&item.clip) ||
                    FAILED(item.node->get_CurrentIsOffscreen(&offscreen)) || offscreen) return false;
            }
            return valid();
        };
        while (!stack.empty()) {
            if (!valid() || visited>=5000) { complete=false;break; }
            auto entry=std::move(stack.back()); stack.pop_back();
            if (std::any_of(seen.begin(),seen.end(),[&](const auto& prior){return same(prior.Get(),entry.node.Get());})) continue;
            seen.push_back(entry.node);++visited;
            BOOL password=TRUE; require(entry.node->get_CurrentIsPassword(&password));
            if (password) {complete=false;continue;}
            const auto place=placement(entry.node.Get(),entry.clip,GetDpiForWindow(window)/96.0);
            if (!place || !place->shown || !place->geometry) continue;
            geometry.push_back({entry.node,place->frame});
            RECT clip{};
            if (!IntersectRect(&clip,&entry.clip,&place->frame)) continue;
            if (const auto page=pageHost(entry.node.Get());page && exclusions.excludes(*page)) return hiddenScreen();
            ComPtr<IUIAutomationTextPattern> pattern;
            if (SUCCEEDED(entry.node->GetCurrentPatternAs(UIA_TextPatternId,IID_PPV_ARGS(&pattern))) && pattern) {
                // A clipped ancestor cannot be trusted solely from GetVisibleRanges.
                // Refuse this aggregate until a provider-specific range clip is proven.
                if (!EqualRect(&clip,&place->frame) || !safeTextSubtree(entry.node.Get(),started,1500)) {complete=false;continue;}
                if (surfaces.size()>=maxSurfaces || remaining==0) {complete=false;break;}
                if (!geometryStable()) return nullptr;
                const bool ownsFocus=std::any_of(focusPath.begin(),focusPath.end(),[&](const auto& node){return same(node.Get(),entry.node.Get());});
                JSON value;
                try { value=UiaCaretSource::viewportSurface(pattern.Get(),surfaces.size(),*place->geometry,ownsFocus,remaining,started); }
                catch(const std::exception&) {complete=false;continue;}
                for (const auto& run:value.at("surface").at("runs")) {
                    const auto bytes=run.at("text").get_ref<const std::string&>().size();
                    if(bytes>remaining) return nullptr;
                    remaining-=bytes;
                }
                if(ownsFocus) {focusedID=surfaces.size();caret=value.at("caret");}
                surfaces.push_back(value.at("surface"));
                captures.push_back({entry.node,pattern,*place->geometry,ownsFocus,value});
                continue;
            }
            if(stack.size()>=5000-visited) {complete=false;break;}
            auto children=privacyTree.children(entry.node,5000-visited-stack.size());
            for(auto child=children.rbegin();child!=children.rend();++child) stack.push_back({*child,clip});
        }
        for(size_t i=0;i<captures.size();++i) {
            const auto& capture=captures[i];
            if(!geometryStable() || !safeTextSubtree(capture.node.Get(),started,1500)) return nullptr;
            try {
                if(UiaCaretSource::viewportSurface(capture.pattern.Get(),i,capture.frame,capture.focused,limits.at("bytes").get<size_t>(),started)!=capture.value) return nullptr;
            } catch(const std::exception&) {return nullptr;}
        }
        if(!geometryStable()) return nullptr;
        if(privacy::holdsExcludedPage(privacyTree,root,exclusions,true)) return hiddenScreen();
        for(const auto& capture:captures) if(!safeTextSubtree(capture.node.Get(),started,1500)) return nullptr;
        wchar_t title[513]{};GetWindowTextW(window,title,513);
        if(!valid()) return nullptr;
        const auto projected=core::request({{"surfaces",surfaces},{"focusedSurface",focusedID},{"caret",caret},
            {"complete",complete && !surfaces.empty()}},voice_core_viewport_json);
        const auto rendered=projected.at("renderedText").get<std::string>();
        return {{"appName",utf8(app)},{"bundleID",nullptr},{"windowTitle",privacy::ScreenPrivacy::redact(utf8(title))},
            {"host",nullptr},{"terminalProgram",nullptr},{"focusedRole","terminal"},{"textBeforeCaret",""},{"textAfterCaret",""},
            {"selectedText",projected.at("selectedText")},{"selectionRedacted",!projected.at("selectionComplete").get<bool>()},
            {"terminalViewport",projected},{"renderedText",rendered},{"logDescription",rendered},
            {"summary","terminal surfaces="+std::to_string(surfaces.size())+" nodes="+std::to_string(visited)}};
    }
    // The focused element as the walk treats it. `element` is null when the window has none.
    struct FocusRead {
        IUIAutomationElement* element;
        bool terminal;      // In a terminal app: never a caret block (see readScreen).
        bool field;         // The caret's field: its caret text was read, or it is a protected field.
        bool pageSelected;  // A page that has the focus itself, with something selected in it.
    };
    // Depth-first in the provider's child order, as the Mac walk: chrome and anything outside
    // the window are skipped, each piece of text keeps its frame, and the focused element
    // field becomes the caret block at its place (a page in focus is walked into, after its
    // selection). The focused element's ancestors are always walked into and never read.
    // Two rules differ from the Mac. A box that shows nothing is not walked into here: on
    // Windows a clipped one-pixel box's children report their full size, so walking in would
    // read text that is not on screen. And a focused element that is no field is read like
    // any other, where the Mac leaves it out.
    bool readVisible(HWND window, const FocusRead& target, const std::string& caretText,
                     ULONGLONG started, VisibleContext& context, const ScreenExclusions& exclusions, bool& hiddenPage,
                     std::optional<std::wstring>& walkedHost) {
        auto* const focus = target.element;
        ComPtr<IUIAutomationElement> root;
        require(automation->ElementFromHandle(window, &root));
        if (!root) return true;
        ComPtr<IUIAutomationTreeWalker> walker;
        require(automation->get_RawViewWalker(&walker));
        WalkFrame within{{}, GetDpiForWindow(window) / 96.0};
        if (!GetWindowRect(window, &within.window)) return true;
        std::vector<ComPtr<IUIAutomationElement>> focusPath;
        ComPtr<IUIAutomationElement> ancestor;
        if (focus && SUCCEEDED(walker->GetParentElement(focus, &ancestor))) {
            while (ancestor && focusPath.size() < 200 && GetTickCount64() - started <= 1500) {
                focusPath.push_back(ancestor);
                if (same(ancestor.Get(), root.Get())) break;
                ComPtr<IUIAutomationElement> parent;
                if (FAILED(walker->GetParentElement(ancestor.Get(), &parent))) break;
                ancestor = parent;
            }
        }
        const auto refuse = [&] {
            std::cerr << "debug screen access: excluded or unknown page not read\n";
            hiddenPage = true;
            return false;
        };
        // Walk only this window. Its desktop siblings are never queried. An explicit
        // continuation stack preserves provider child order without recursive depth.
        struct Entry { ComPtr<IUIAutomationElement> element; bool web; ComPtr<IUIAutomationTextPattern> document; };
        std::vector<Entry> stack{{root, false, {}}};
        while (!stack.empty()) {
            if (context.nodes >= 5000) { context.stopped = "node budget"; break; }
            if (GetTickCount64() - started > 1500) { context.stopped = "time budget"; break; }
            if (!context.stopped.empty()) break;
            if (GetForegroundWindow() != window) return false;
            auto entry = std::move(stack.back());
            stack.pop_back();
            ++context.nodes;
            auto* node = entry.element.Get();
            const bool isFocus = focus && same(node, focus);
            BOOL password = TRUE;
            if (FAILED(node->get_CurrentIsPassword(&password))) continue;
            if (password) {
                if (isFocus && target.field) context.append(ContextKind::caret, "‸");
                continue; // No name, value, text pattern, or child access.
            }
            const bool onFocusPath = std::any_of(focusPath.begin(), focusPath.end(),
                [&](const auto& parent) { return same(node, parent.Get()); });
            const bool onPath = isFocus || onFocusPath;
            if (const auto page = pageHost(node); page) {
                if (exclusions.excludes(*page)) return refuse();
                // The first page the walk reaches off the focus's own path, as on the Mac.
                if (!onPath && !walkedHost && page->kind == PageHost::Kind::host) walkedHost = page->name;
            }
            const auto place = placement(node, within.window, within.hiddenThickness);
            if (!place) continue;
            // Hidden containers can still expose children with large text bounds (for
            // example a 1px clipped accessibility-only label). Never descend into
            // their subtree just because a child claims to be visible.
            if (!place->shown && !onPath) continue;
            const auto& geometry = place->geometry;
            if (isFocus && target.field) {
                context.append(ContextKind::caret, caretText, geometry);
                continue;
            }
            // A page in focus with a selection: the selection, then the page like any page.
            if (isFocus && target.pageSelected) context.append(ContextKind::caret, caretText, geometry);
            CONTROLTYPEID type = 0;
            if (FAILED(node->get_CurrentControlType(&type))) continue;
            const bool web = entry.web || type == UIA_DocumentControlTypeId;
            if (!onFocusPath && isChrome(type, web)) continue;
            if (type == UIA_DocumentControlTypeId) {
                ComPtr<IUIAutomationTextPattern> document;
                if (SUCCEEDED(node->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&document)))) entry.document = document;
            }
            const bool control = isControl(type);
            if (isFocus && target.terminal && type != UIA_EditControlTypeId) {
                // A terminal's pane: the lines in view, as a field.
                ComPtr<IUIAutomationTextPattern> pane;
                if (SUCCEEDED(node->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pane))) && pane) {
                    if (place->shown && safeTextSubtree(node, started, 1500)) appendVisibleField(node, context, geometry, started);
                    continue;
                }
            }
            if (place->shown && !onFocusPath) {
                const bool row = isRow(type, web);
                if ((web && control) || row || type == UIA_EditControlTypeId || type == UIA_TextControlTypeId || type == UIA_HyperlinkControlTypeId) {
                    PageTree tree{this, walker, started, 1500};
                    if (privacy::holdsExcludedPage(tree, entry.element, exclusions, true)) return refuse();
                }
                if (web && control) {
                    const auto caption = safeTextSubtree(node, started, 1500) ? controlText(entry.document.Get(), node, place->frame, started) : "";
                    if (!caption.empty()) {
                        context.append(ContextKind::text, caption, geometry);
                        continue;
                    }
                }
                if (type == UIA_EditControlTypeId) {
                    if (safeTextSubtree(node, started, 1500)) {
                        appendVisibleField(node, context, geometry, started);
                        continue;
                    }
                    // Descend safely instead of aggregating a protected child.
                }
                if (row) {
                    // Its cells as one block; a row that gives none is read by its name.
                    auto cells = semanticText(node, walker.Get(), SemanticText::Kind::row, web, entry.document.Get(), within, started, exclusions, context);
                    if (!cells) return refuse();
                    context.appendSemantic(ContextKind::row, *cells, geometry);
                    continue;
                }
                // A web control's Name can be an undrawn aria-label. Read its
                // visible text descendants instead, as the Mac reference does
                // for controls whose accessibility title is a description.
                if (type == UIA_TextControlTypeId || type == UIA_HyperlinkControlTypeId) {
                    VARIANT heading;
                    VariantInit(&heading);
                    const HRESULT status = node->GetCurrentPropertyValue(UIA_HeadingLevelPropertyId, &heading);
                    const bool isHeading = SUCCEEDED(status) && heading.vt == VT_I4 &&
                        heading.lVal >= HeadingLevel1 && heading.lVal <= HeadingLevel9;
                    VariantClear(&heading);
                    const bool isLink = type == UIA_HyperlinkControlTypeId;
                    if (isHeading || isLink) {
                        const auto gathered = semanticText(node, walker.Get(), isHeading ? SemanticText::Kind::heading : SemanticText::Kind::link,
                                                           web, entry.document.Get(), within, started, exclusions, context);
                        if (!gathered) return refuse();
                        context.appendSemantic(isHeading ? ContextKind::heading : ContextKind::link, *gathered, geometry);
                        continue;
                    }
                    const auto name = safeTextSubtree(node, started, 1500) ? elementName(node) : "";
                    context.append(ContextKind::text, name, geometry);
                    if (!normalizedContextText(name).empty()) continue;
                }
            }
            bool outOfTime = false;
            auto children = childrenOf(walker.Get(), node, 5001 - std::min<size_t>(context.nodes, 5000), started, outOfTime);
            if (outOfTime) context.stopped = "time budget";
            for (auto child = children.rbegin(); child != children.rend(); ++child) stack.push_back({std::move(*child), web, entry.document});
        }
        // A provider may omit the focus node from its tree. Retain the independently
        // bounded caret context rather than dropping it from a partial screen read.
        if ((target.field || target.pageSelected) && !context.hasCaret) context.append(ContextKind::caret, caretText);
        return true;
    }
    static JSON rectangle(double x, double y, double width, double height) {
        if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height) ||
            std::abs(x) > 1'000'000 || std::abs(y) > 1'000'000 || width < 0 || width > 32768 || height <= 0 || height > 32768) return nullptr;
        RECT frame{static_cast<LONG>(std::floor(x)), static_cast<LONG>(std::floor(y)),
            static_cast<LONG>(std::ceil(x + std::max(width, 1.0))), static_cast<LONG>(std::ceil(y + height))};
        if (!MonitorFromRect(&frame, MONITOR_DEFAULTTONULL)) return nullptr;
        return {{"x", x}, {"y", y}, {"width", width}, {"height", height}};
    }
    static JSON rangeRect(IUIAutomationTextRange* range) {
        SAFEARRAY* rectangles = nullptr;
        require(range->GetBoundingRectangles(&rectangles));
        if (!rectangles) return nullptr;
        JSON result = nullptr;
        LONG first = 0, last = -1;
        if (SafeArrayGetDim(rectangles) == 1 && SUCCEEDED(SafeArrayGetLBound(rectangles, 1, &first)) &&
            SUCCEEDED(SafeArrayGetUBound(rectangles, 1, &last)) && last - first >= 3) {
            double values[4]{};
            bool valid = true;
            for (LONG index = 0; index < 4; ++index) {
                LONG position = first + index;
                if (FAILED(SafeArrayGetElement(rectangles, &position, &values[index]))) valid = false;
            }
            if (valid) result = rectangle(values[0], values[1], values[2], values[3]);
        }
        SafeArrayDestroy(rectangles);
        return result;
    }
    static bool emptyValue(IUIAutomationElement* element) {
        ComPtr<IUIAutomationValuePattern> value;
        if (FAILED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&value))) || !value) return false;
        BSTR text = nullptr;
        require(value->get_CurrentValue(&text));
        const bool empty = !text || SysStringLen(text) == 0;
        SysFreeString(text);
        return empty;
    }
    static void clampRange(IUIAutomationTextRange* range, IUIAutomationTextRange* document) {
        // Chromium can normalize a collapsed end selection to the next page node.
        // Clamp provider ranges before querying text or geometry so every read stays
        // inside the original focused field, including selections spanning its boundary.
        int relative = 0;
        require(range->CompareEndpoints(TextPatternRangeEndpoint_Start, document, TextPatternRangeEndpoint_Start, &relative));
        if (relative < 0) require(range->MoveEndpointByRange(TextPatternRangeEndpoint_Start, document, TextPatternRangeEndpoint_Start));
        require(range->CompareEndpoints(TextPatternRangeEndpoint_End, document, TextPatternRangeEndpoint_End, &relative));
        if (relative > 0) require(range->MoveEndpointByRange(TextPatternRangeEndpoint_End, document, TextPatternRangeEndpoint_End));
    }
    static JSON textAnchor(IUIAutomationElement* element, bool collapsedOnly = false) {
        ComPtr<IUIAutomationTextPattern> pattern;
        if (FAILED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern))) || !pattern) return nullptr;
        ComPtr<IUIAutomationTextRangeArray> selections;
        require(pattern->GetSelection(&selections));
        if (!selections) return nullptr;
        int count = 0;
        require(selections->get_Length(&count));
        if (count != 1) return nullptr;
        ComPtr<IUIAutomationTextRange> selected, document, range;
        require(selections->GetElement(0, &selected));
        require(pattern->get_DocumentRange(&document));
        if (!selected || !document) return nullptr;
        if (collapsedOnly) {
            int length = 0;
            require(selected->CompareEndpoints(TextPatternRangeEndpoint_Start, selected.Get(), TextPatternRangeEndpoint_End, &length));
            // Without an editable-value contract, require an insertion point;
            // selected document/output text alone does not establish a caret.
            if (length != 0) return nullptr;
        }
        require(selected->Clone(&range));
        clampRange(range.Get(), document.Get());
        // Keep the insertion point used by adjacent-character fallback bounded too.
        require(range->Clone(&selected));
        int relative = 0;
        int selectionLength = 0;
        require(range->CompareEndpoints(TextPatternRangeEndpoint_Start, range.Get(), TextPatternRangeEndpoint_End, &selectionLength));
        // Some providers return the field's leading edge for a collapsed range,
        // even when its endpoints correctly identify the end of the text. Prefer
        // adjacent-character geometry for insertion points; retain a direct
        // collapsed rectangle when a neighboring glyph supports its affinity,
        // or when neither adjacent character has geometry.
        const JSON direct = rangeRect(range.Get());
        JSON result = selectionLength == 0 ? JSON(nullptr) : direct;
        bool trailing = false;
        bool adjacent = false;
        if (result.is_null()) {
            adjacent = true;
            // Empty ranges legitimately have no rectangles. Query one adjacent character,
            // clamped to the focused field, without changing the application's selection.
            require(range->MoveEndpointByRange(TextPatternRangeEndpoint_End, range.Get(), TextPatternRangeEndpoint_Start));
            require(range->CompareEndpoints(TextPatternRangeEndpoint_Start, document.Get(), TextPatternRangeEndpoint_End, &relative));
            int moved = 0;
            if (relative < 0) {
                require(range->MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, 1, &moved));
                require(range->CompareEndpoints(TextPatternRangeEndpoint_End, document.Get(), TextPatternRangeEndpoint_End, &relative));
                if (relative > 0) require(range->MoveEndpointByRange(TextPatternRangeEndpoint_End, document.Get(), TextPatternRangeEndpoint_End));
            } else {
                trailing = true;
                require(range->MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -1, &moved));
                require(range->CompareEndpoints(TextPatternRangeEndpoint_Start, document.Get(), TextPatternRangeEndpoint_Start, &relative));
                if (relative < 0) require(range->MoveEndpointByRange(TextPatternRangeEndpoint_Start, document.Get(), TextPatternRangeEndpoint_Start));
            }
            result = rangeRect(range.Get());
            if (result.is_null() && !trailing) {
                // Chromium may expose a trailing paragraph separator with no geometry.
                // At that insertion point use the preceding visible character instead.
                require(range->MoveEndpointByRange(TextPatternRangeEndpoint_End, selected.Get(), TextPatternRangeEndpoint_Start));
                require(range->MoveEndpointByRange(TextPatternRangeEndpoint_Start, selected.Get(), TextPatternRangeEndpoint_Start));
                require(range->MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -1, &moved));
                require(range->CompareEndpoints(TextPatternRangeEndpoint_Start, document.Get(), TextPatternRangeEndpoint_Start, &relative));
                if (relative < 0) require(range->MoveEndpointByRange(TextPatternRangeEndpoint_Start, document.Get(), TextPatternRangeEndpoint_Start));
                result = rangeRect(range.Get());
                trailing = true;
            }
        }
        if (selectionLength == 0 && adjacent && !direct.is_null()) {
            // Preserve the provider's caret affinity at bidi and wrapped-line boundaries
            // when it lies beside a real neighboring glyph. A collapsed field-origin
            // rectangle (as exposed by some URL editors) fails this local check.
            const auto supportsCaret = [&](const JSON& glyph) {
                if (glyph.is_null()) return false;
                const double x = direct["x"].get<double>(), y = direct["y"].get<double>();
                const double left = glyph["x"].get<double>(), top = glyph["y"].get<double>();
                return x >= left - 2 && x <= left + glyph["width"].get<double>() + 2 &&
                    std::abs(y - top) <= 2;
            };
            bool supported = supportsCaret(result);
            if (!supported && !trailing) {
                ComPtr<IUIAutomationTextRange> previous;
                require(selected->Clone(&previous));
                int moved = 0;
                require(previous->MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -1, &moved));
                clampRange(previous.Get(), document.Get());
                if (moved) supported = supportsCaret(rangeRect(previous.Get()));
            }
            if (supported) { result = direct; trailing = false; adjacent = false; }
        }
        if (result.is_null()) { result = direct; trailing = false; adjacent = false; }
        if (!result.is_null()) {
            const double width = result["width"].get<double>();
            bool rightToLeft = false;
            if (adjacent) {
                VARIANT direction;
                VariantInit(&direction);
                const HRESULT status = range->GetAttributeValue(UIA_TextFlowDirectionsAttributeId, &direction);
                if (SUCCEEDED(status) && direction.vt == VT_I4) {
                    rightToLeft = (direction.lVal & FlowDirections_RightToLeft) != 0;
                }
                VariantClear(&direction);
            }
            // The Mac locator also anchors a line/selection box at its leading edge.
            // Adjacent glyphs run in logical text order, which can reverse their edges.
            if (trailing != rightToLeft) result["x"] = result["x"].get<double>() + width;
            if (width > 4 || adjacent) result["width"] = 0;
        }
        return result;
    }
    static JSON accessibleCaret(IUIAutomationElement* element, HWND expected) {
        GUITHREADINFO info{}; info.cbSize = sizeof(info);
        if (!GetGUIThreadInfo(GetWindowThreadProcessId(expected, nullptr), &info) ||
            !info.hwndFocus || GetAncestor(info.hwndFocus, GA_ROOT) != expected) return nullptr;
        ComPtr<IAccessible> caret;
        if (FAILED(AccessibleObjectFromWindow(info.hwndFocus, static_cast<DWORD>(OBJID_CARET),
            IID_PPV_ARGS(&caret))) || !caret) return nullptr;
        VARIANT child; VariantInit(&child); child.vt = VT_I4; child.lVal = CHILDID_SELF;
        VARIANT state; VariantInit(&state);
        const HRESULT status = caret->get_accState(child, &state);
        const bool visible = SUCCEEDED(status) && state.vt == VT_I4 &&
            !(state.lVal & (STATE_SYSTEM_INVISIBLE | STATE_SYSTEM_OFFSCREEN));
        VariantClear(&state);
        if (!visible) return nullptr;
        long x = 0, y = 0, width = 0, height = 0;
        if (FAILED(caret->accLocation(&x, &y, &width, &height, child)) ||
            width < 0 || height <= 0 || GetForegroundWindow() != expected) return nullptr;
        RECT frame{};
        require(element->get_CurrentBoundingRectangle(&frame));
        // A window-level caret must belong to the already validated focused field.
        if (x < frame.left - 2 || x > frame.right + 2 || y < frame.top - 2 ||
            static_cast<double>(y) + height > static_cast<double>(frame.bottom) + 2) return nullptr;
        return rectangle(x, y, width, height);
    }
    static JSON editCaret(IUIAutomationElement* element, HWND expected) {
        UIA_HWND native = nullptr;
        require(element->get_CurrentNativeWindowHandle(&native));
        const HWND edit = static_cast<HWND>(native);
        wchar_t name[16]{};
        if (!edit || !GetClassNameW(edit, name, 16) || _wcsicmp(name, L"Edit") != 0) return nullptr;
        if (GetWindowLongPtrW(edit, GWL_STYLE) & (ES_PASSWORD | ES_READONLY)) return nullptr;
        GUITHREADINFO info{};
        info.cbSize = sizeof(info);
        if (!GetGUIThreadInfo(GetWindowThreadProcessId(edit, nullptr), &info) || info.hwndFocus != edit || info.hwndCaret != edit) return nullptr;
        POINT corners[] = {{info.rcCaret.left, info.rcCaret.top}, {info.rcCaret.right, info.rcCaret.bottom}};
        if (!ClientToScreen(edit, &corners[0]) || !ClientToScreen(edit, &corners[1])) return nullptr;
        if (GetForegroundWindow() != expected || corners[1].y <= corners[0].y || corners[1].x < corners[0].x) return nullptr;
        return {{"x", corners[0].x}, {"y", corners[0].y}, {"width", corners[1].x - corners[0].x}, {"height", corners[1].y - corners[0].y}};
    }
    static std::optional<std::wstring> editValue(IUIAutomationElement* element, unsigned maxLength) {
        UIA_HWND native = nullptr;
        require(element->get_CurrentNativeWindowHandle(&native));
        const HWND edit = static_cast<HWND>(native);
        wchar_t name[16]{};
        if (!edit || !GetClassNameW(edit, name, 16) || _wcsicmp(name, L"Edit") != 0) return std::nullopt;
        if ((GetWindowLongPtrW(edit, GWL_STYLE) & (ES_PASSWORD | ES_READONLY)) || !IsWindowEnabled(edit)) return std::nullopt;
        const auto send = [edit](UINT message, WPARAM value, LPARAM data) {
            DWORD_PTR result = 0;
            if (!SendMessageTimeoutW(edit, message, value, data, SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT, 200, &result)) {
                throw std::runtime_error("edit control did not answer");
            }
            return result;
        };
        if (send(WM_GETTEXTLENGTH, 0, 0) > maxLength) return std::nullopt;
        std::wstring text(static_cast<size_t>(maxLength) + 2, L'\0');
        const auto count = send(WM_GETTEXT, static_cast<WPARAM>(text.size()), reinterpret_cast<LPARAM>(text.data()));
        if (count > maxLength || send(WM_GETTEXTLENGTH, 0, 0) > maxLength ||
            (GetWindowLongPtrW(edit, GWL_STYLE) & (ES_PASSWORD | ES_READONLY))) return std::nullopt;
        text.resize(static_cast<size_t>(count));
        return text;
    }

    static std::optional<std::array<std::string, 3>> editText(IUIAutomationElement* element, bool& selectionUnavailable, ULONGLONG started) {
        UIA_HWND native = nullptr;
        require(element->get_CurrentNativeWindowHandle(&native));
        const auto result = EditCaretSource::read(static_cast<HWND>(native), started);
        if (!result) return std::nullopt;
        selectionUnavailable = result->selectionUnavailable;
        return result->parts;
    }
    static std::optional<std::array<std::string, 3>> textParts(IUIAutomationElement* element, bool& selectionUnavailable, ULONGLONG started) {
        ComPtr<IUIAutomationTextPattern> pattern;
        if (FAILED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern))) || !pattern) return editText(element, selectionUnavailable, started);
        auto result = UiaCaretSource::read(pattern.Get(), started);
        selectionUnavailable = result.selectionUnavailable;
        if (!result.selectionUnavailable && result.parts[0] + result.parts[1] + result.parts[2] == "\xEF\xBF\xBC" && emptyValue(element))
            return std::array<std::string, 3>{};
        return result.parts;
    }
    ComPtr<IUIAutomation> automation;
};
}
