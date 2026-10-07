// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A synthetic UIA server, not a mock of Automation. The shipped helper crosses
// the real COM boundary; counters expose forbidden reads even if replies drop them.
#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>
#include <nlohmann/json.hpp>
#include <atomic>
#include <iostream>
#include <string>
#include <thread>
#include <vector>
#include <memory>
#include <cstring>
#include "saved-clipboard.h"
#include <algorithm>

namespace {
using JSON = nlohmann::json;
HWND window = nullptr;
int focus = 1;
bool pasteMode = false, clipboardHeld = false;
std::wstring pasted[2];
std::unique_ptr<voice::SavedClipboard> savedClipboard;
std::atomic<unsigned> forbiddenReads{0}, textReads{0};
// The UI framework every element reports: a browser engine's, unless the mode says otherwise.
std::wstring framework = L"Chrome";
bool frameworkFails = false;
// A provider that stops answering: asked for its focus, it holds the call past the helper's watchdog (ms).
bool stalled = false;
constexpr DWORD stallMs = 3000;
struct Node;
std::vector<std::unique_ptr<Node>> nodes;
struct Node final : IRawElementProviderSimple, IRawElementProviderFragment, IRawElementProviderFragmentRoot, IValueProvider {
    int id, parent = -1;
    CONTROLTYPEID type = UIA_TextControlTypeId;
    bool password = false, forbidden = false, unknownAddress = false, readOnly = false, thin = false, rawOnly = false, outside = false, placeFails = false;
    std::wstring text = L"Synthetic safe label", address;
    std::vector<int> children;
    explicit Node(int index) : id(index) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** result) override {
        *result = nullptr;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IRawElementProviderSimple)) *result = static_cast<IRawElementProviderSimple*>(this);
        else if (iid == __uuidof(IRawElementProviderFragment)) *result = static_cast<IRawElementProviderFragment*>(this);
        else if (iid == __uuidof(IRawElementProviderFragmentRoot) && id == 0) *result = static_cast<IRawElementProviderFragmentRoot*>(this);
        else if (iid == __uuidof(IValueProvider) && (type == UIA_EditControlTypeId || type == UIA_DocumentControlTypeId)) *result = static_cast<IValueProvider*>(this);
        if (!*result) return E_NOINTERFACE;
        AddRef(); return S_OK;
    }
    // The fixture owns a stable tree for its entire process lifetime.
    ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }
    bool protectedSubtree() const {
        if (forbidden || password) return true;
        return std::any_of(children.begin(), children.end(), [](int child) { return nodes.at(child)->protectedSubtree(); });
    }
    void read() const { ++textReads; if ((id != 0 && protectedSubtree()) || forbidden || password) ++forbiddenReads; }
    HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions* result) override { *result = ProviderOptions_ServerSideProvider; return S_OK; }
    HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID pattern, IUnknown** result) override {
        *result = nullptr;
        if (pattern == UIA_ValuePatternId && (type == UIA_EditControlTypeId || type == UIA_DocumentControlTypeId)) {
            if (password || (forbidden && type == UIA_EditControlTypeId)) ++forbiddenReads;
            *result = static_cast<IValueProvider*>(this); AddRef();
        }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID property, VARIANT* result) override {
        VariantInit(result);
        const auto boolean = [&](bool value) { result->vt = VT_BOOL; result->boolVal = value ? VARIANT_TRUE : VARIANT_FALSE; };
        const auto number = [&](LONG value) { result->vt = VT_I4; result->lVal = value; };
        if (property == UIA_IsPasswordPropertyId) boolean(password);
        else if (property == UIA_IsControlElementPropertyId || property == UIA_IsContentElementPropertyId) boolean(!rawOnly);
        else if (property == UIA_IsEnabledPropertyId || property == UIA_IsKeyboardFocusablePropertyId) boolean(true);
        else if (property == UIA_IsOffscreenPropertyId) boolean(false);
        else if (property == UIA_HasKeyboardFocusPropertyId) boolean(id == focus);
        else if (property == UIA_ControlTypePropertyId) number(type);
        else if (property == UIA_ProcessIdPropertyId) number(static_cast<LONG>(GetCurrentProcessId()));
        else if (property == UIA_FrameworkIdPropertyId) {
            if (frameworkFails && type == UIA_DocumentControlTypeId) return E_FAIL;
            result->vt = VT_BSTR; result->bstrVal = SysAllocString(framework.c_str());
        }
        else if (property == UIA_NativeWindowHandlePropertyId && id == 0) number(static_cast<LONG>(reinterpret_cast<LONG_PTR>(window)));
        else if (property == UIA_NamePropertyId) { read(); result->vt = VT_BSTR; result->bstrVal = SysAllocString(text.c_str()); }
        else if (property == UIA_ValueValuePropertyId && type == UIA_DocumentControlTypeId) {
            if (unknownAddress) return E_FAIL;
            result->vt = VT_BSTR; result->bstrVal = SysAllocString(address.c_str());
        }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple** result) override {
        *result = nullptr;
        return id == 0 ? UiaHostProviderFromHwnd(window, result) : S_OK;
    }
    HRESULT STDMETHODCALLTYPE Navigate(NavigateDirection direction, IRawElementProviderFragment** result) override {
        *result = nullptr;
        int target = -1;
        if (direction == NavigateDirection_Parent) target = parent;
        else if (direction == NavigateDirection_FirstChild || direction == NavigateDirection_LastChild) {
            if (forbidden || password) ++forbiddenReads;
            if (!children.empty()) target = direction == NavigateDirection_FirstChild ? children.front() : children.back();
        } else if (parent >= 0) {
            const auto& siblings = nodes.at(parent)->children;
            const auto here = std::find(siblings.begin(), siblings.end(), id);
            if (direction == NavigateDirection_NextSibling && here != siblings.end() && here + 1 != siblings.end()) target = *(here + 1);
            if (direction == NavigateDirection_PreviousSibling && here != siblings.begin() && here != siblings.end()) target = *(here - 1);
        }
        if (target >= 0) { *result = nodes.at(target).get(); (*result)->AddRef(); }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetRuntimeId(SAFEARRAY** result) override {
        *result = nullptr;
        if (id == 0) return S_OK;
        *result = SafeArrayCreateVector(VT_I4, 0, 2);
        LONG zero = 0, one = 1, prefix = UiaAppendRuntimeId, identifier = id;
        SafeArrayPutElement(*result, &zero, &prefix); SafeArrayPutElement(*result, &one, &identifier);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_BoundingRectangle(UiaRect* result) override {
        if (placeFails) return UIA_E_ELEMENTNOTAVAILABLE; // What UI Automation passes back for an element gone.
        RECT frame{}; GetWindowRect(window, &frame);
        // A thin box shows nothing; what is under it still reports its full size. A box outside
        // sits above the window.
        const double top = outside ? frame.top - 1000.0 : static_cast<double>(frame.top + 40 + id * 25);
        *result = {static_cast<double>(frame.left + 20), top, thin ? 1.0 : 400.0, thin ? 1.0 : 24.0};
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetEmbeddedFragmentRoots(SAFEARRAY** result) override { *result = nullptr; return S_OK; }
    HRESULT STDMETHODCALLTYPE SetFocus() override { focus = id; ::SetFocus(window); return S_OK; }
    HRESULT STDMETHODCALLTYPE get_FragmentRoot(IRawElementProviderFragmentRoot** result) override { *result = nodes.front().get(); (*result)->AddRef(); return S_OK; }
    HRESULT STDMETHODCALLTYPE ElementProviderFromPoint(double, double, IRawElementProviderFragment** result) override { *result = nodes.at(focus).get(); (*result)->AddRef(); return S_OK; }
    HRESULT STDMETHODCALLTYPE GetFocus(IRawElementProviderFragment** result) override {
        if (stalled) Sleep(stallMs);
        *result = nodes.at(focus).get(); (*result)->AddRef(); return S_OK;
    }
    HRESULT STDMETHODCALLTYPE SetValue(LPCWSTR) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_Value(BSTR* result) override {
        *result = nullptr;
        if (type == UIA_DocumentControlTypeId) {
            if (unknownAddress) return E_FAIL;
            *result = SysAllocString(address.c_str());
        } else { read(); *result = SysAllocString(text.c_str()); }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_IsReadOnly(BOOL* result) override { *result = readOnly ? TRUE : FALSE; return S_OK; }
};
int add(int parent, CONTROLTYPEID type, bool password = false) {
    const int id = static_cast<int>(nodes.size());
    auto node = std::make_unique<Node>(id);
    node->parent = parent; node->type = type; node->password = password;
    if (password) node->text = L"DO_NOT_READ_SYNTHETIC_PASSWORD";
    nodes.push_back(std::move(node));
    if (parent >= 0) nodes.at(parent)->children.push_back(id);
    return id;
}
void configure(const std::string& mode) {
    add(-1, UIA_WindowControlTypeId); nodes.front()->text = L"Synthetic provider root";
    add(0, UIA_TextControlTypeId); // A non-editable focus keeps unrelated text paths out of the test.
    if (mode == "stalled-focus") {
        stalled = true;
    } else if (mode == "paste-focus") {
        pasteMode = true; add(0, UIA_TextControlTypeId);
    } else if (mode == "password-focus") {
        nodes.at(1)->password = true; nodes.at(1)->type = UIA_EditControlTypeId;
        nodes.at(1)->text = L"DO_NOT_READ_SYNTHETIC_PASSWORD";
        add(1, UIA_TextControlTypeId); nodes.back()->forbidden = true;
    } else if (mode == "row-hidden") {
        // A row with one cell on screen and one in a box that shows nothing.
        const int row = add(0, UIA_DataItemControlTypeId);
        nodes.at(add(row, UIA_TextControlTypeId))->text = L"Synthetic cell text";
        const int box = add(row, UIA_GroupControlTypeId);
        nodes.at(box)->thin = true;
        nodes.at(add(box, UIA_TextControlTypeId))->text = L"Synthetic hidden text";
    } else if (mode == "hidden-box") {
        // A container that shows nothing, with a child reporting a full size, is walked into; a
        // text box that shows nothing is skipped with what it holds (ADR-DESK-054).
        const int box = add(0, UIA_GroupControlTypeId);
        nodes.at(box)->thin = true;
        nodes.at(add(box, UIA_TextControlTypeId))->text = L"Synthetic hidden-box text";
        const int thinText = add(0, UIA_TextControlTypeId);
        nodes.at(thinText)->thin = true;
        nodes.at(thinText)->text = L"Synthetic thin box text";
        nodes.at(add(thinText, UIA_TextControlTypeId))->text = L"Synthetic under thin text";
    } else if (mode == "terminal-wide") {
        // Run under a terminal's name: a window wider than the look's node budget.
        for (int i = 0; i < 5000; ++i) add(0, UIA_GroupControlTypeId);
    } else if (mode == "large-text") {
        // Text read in one piece that holds more than the look takes in (one element past its
        // budget): withheld behind the marker.
        const int large = add(0, UIA_TextControlTypeId);
        nodes.at(large)->text = L"Synthetic large text";
        for (int i = 0; i < 5001; ++i) add(large, UIA_GroupControlTypeId);
    } else if (mode == "large-row" || mode == "large-link") {
        // A row or link that holds more than the look takes in: a row's cells are each looked
        // through and read; a link's name, read whole, is withheld behind the marker.
        const int large = add(0, mode == "large-row" ? UIA_DataItemControlTypeId : UIA_HyperlinkControlTypeId);
        nodes.at(large)->text = L"Synthetic large name";
        nodes.at(add(large, UIA_TextControlTypeId))->text = L"Synthetic cell text";
        for (int i = 0; i < 5000; ++i) add(large, UIA_GroupControlTypeId);
    } else if (mode == "large-field" || mode == "large-web-control") {
        // A field, and a page's control, that hold more than the look takes in (one element past
        // its budget): withheld behind the marker, the field's as a field.
        int parent = 0;
        if (mode == "large-web-control") {
            parent = add(0, UIA_DocumentControlTypeId);
            nodes.at(parent)->address = L"https://open.example/synthetic";
        }
        const int large = add(parent, mode == "large-field" ? UIA_EditControlTypeId : UIA_ButtonControlTypeId);
        nodes.at(large)->text = L"Synthetic large name";
        for (int i = 0; i < 5001; ++i) add(large, UIA_GroupControlTypeId);
    } else if (mode == "large-focus") {
        // A focus that holds more than the look takes in: the window is still read, not hidden,
        // and the focus itself is not.
        nodes.at(1)->text = L"Synthetic large text";
        for (int i = 0; i < 5000; ++i) add(1, UIA_GroupControlTypeId);
    } else if (mode == "large-window-field") {
        // A field in a window that holds more than the look takes in: not refused for corrections.
        nodes.at(1)->type = UIA_EditControlTypeId;
        for (int i = 0; i < 5000; ++i) add(0, UIA_GroupControlTypeId);
    } else if (mode == "bare-page-control") {
        // A page's control with no caption is walked into, and what it holds is in the page: a
        // control under it gives its drawn caption, never its Name, and with none is walked into
        // too (outside a page a control is skipped with what it holds).
        const int page = add(0, UIA_DocumentControlTypeId);
        nodes.at(page)->address = L"https://open.example/synthetic";
        const int bare = add(page, UIA_ButtonControlTypeId);
        const int nested = add(bare, UIA_CheckBoxControlTypeId);
        nodes.at(nested)->text = L"Synthetic undrawn label";
        nodes.at(add(nested, UIA_TextControlTypeId))->text = L"Synthetic nested option";
    } else if (mode == "outside-page") {
        // An excluded page wholly outside the window: skipped with what it holds.
        const int page = add(0, UIA_DocumentControlTypeId);
        nodes.at(page)->address = L"https://blocked.example/synthetic";
        nodes.at(page)->outside = nodes.at(page)->forbidden = true;
        nodes.at(add(page, UIA_TextControlTypeId))->forbidden = true;
    } else if (mode == "page-place-fails") {
        // An excluded page whose place can't be read may be in view: the window is refused.
        const int page = add(0, UIA_DocumentControlTypeId);
        nodes.at(page)->address = L"https://blocked.example/synthetic";
        nodes.at(page)->placeFails = nodes.at(page)->forbidden = true;
        nodes.at(add(page, UIA_TextControlTypeId))->forbidden = true;
    } else if (mode == "page-under-thin-row" || mode == "page-under-thin-part") {
        // An excluded page under a row that shows nothing, or under a row's part that shows
        // nothing, may still be on screen: looked for first, it refuses the window.
        const int row = add(0, UIA_DataItemControlTypeId);
        int holder = row;
        if (mode == "page-under-thin-row") nodes.at(row)->thin = true;
        else {
            nodes.at(add(row, UIA_TextControlTypeId))->text = L"Synthetic cell text";
            holder = add(row, UIA_GroupControlTypeId);
            nodes.at(holder)->thin = true;
        }
        const int page = add(holder, UIA_DocumentControlTypeId);
        nodes.at(page)->address = L"https://blocked.example/synthetic";
        nodes.at(page)->forbidden = true;
        nodes.at(add(page, UIA_TextControlTypeId))->forbidden = true;
    } else if (mode == "page-in-text" || mode == "page-in-control") {
        // A piece of text, or a page's control, holding an excluded page refuses the window.
        int parent = 0;
        if (mode == "page-in-control") {
            parent = add(0, UIA_DocumentControlTypeId);
            nodes.at(parent)->address = L"https://open.example/synthetic";
        }
        const int holder = add(parent, mode == "page-in-text" ? UIA_TextControlTypeId : UIA_ButtonControlTypeId);
        nodes.at(holder)->text = L"Synthetic holder";
        const int page = add(holder, UIA_DocumentControlTypeId);
        nodes.at(page)->address = L"https://blocked.example/synthetic";
        nodes.at(page)->forbidden = true;
        nodes.at(add(page, UIA_TextControlTypeId))->forbidden = true;
    } else if (mode == "text-full") {
        // Text past the read's byte budget: the walk stops there, not after every element.
        std::wstring filler;
        while (filler.size() < 20000) filler += L"Synthetic filler words ";
        for (int i = 0; i < 14; ++i) nodes.at(add(0, UIA_TextControlTypeId))->text = L"Block " + std::to_wstring(i) + L" " + filler;
        for (int i = 0; i < 300; ++i) add(0, UIA_GroupControlTypeId);
    } else if (mode == "outside-window") {
        // A container wholly outside the window, holding more than the walk's node budget,
        // before text in view: skipped with what it holds, so the text is read.
        const int text = add(0, UIA_TextControlTypeId);
        nodes.at(text)->text = L"Synthetic visible text";
        const int outside = add(0, UIA_GroupControlTypeId);
        nodes.at(outside)->outside = true;
        for (int i = 0; i < 5000; ++i) add(outside, UIA_GroupControlTypeId);
        auto& order = nodes.front()->children;
        std::swap(order[1], order[2]);
    } else if (mode.starts_with("password-")) {
        int container = 0;
        if (mode == "password-row") container = add(0, UIA_DataItemControlTypeId);
        if (mode.starts_with("password-link")) container = add(0, UIA_HyperlinkControlTypeId);
        if (mode == "password-web-control") { const int page = add(0, UIA_DocumentControlTypeId); container = add(page, UIA_ButtonControlTypeId); }
        const int label = add(container, UIA_TextControlTypeId);
        // Its own text: a block that repeats the one before it is left out of the read.
        if (mode == "password-row" || mode.starts_with("password-link")) nodes.at(label)->text = L"Synthetic cell text";
        const int secret = add(container, UIA_EditControlTypeId, true);
        if (mode == "password-link-raw") nodes.at(secret)->rawOnly = true;
        add(secret, UIA_TextControlTypeId); nodes.back()->forbidden = true;
    } else {
        int parent = 0;
        if (mode == "page-frame") parent = add(0, UIA_DocumentControlTypeId);
        if (mode == "page-row") parent = add(0, UIA_DataItemControlTypeId);
        // A page inside a link: refused where the walk looks into a link before reading its name.
        if (mode == "page-link") parent = add(0, UIA_HyperlinkControlTypeId);
        if (mode == "page-in-focus") parent = 1;
        const int page = add(parent, UIA_DocumentControlTypeId);
        nodes.at(page)->address = L"https://blocked.example/synthetic";
        // A page that may be read: with the focus outside it, and as the focus itself (a
        // page that can't be edited, as a browser gives one that was clicked on).
        const bool open = mode.starts_with("open-page");
        if (open) nodes.at(page)->address = L"https://open.example/synthetic";
        if (mode == "page-no-address") nodes.at(page)->address.clear();
        if (mode == "page-unknown") nodes.at(page)->unknownAddress = true;
        // Querying a refused page's address is permitted; its contents are not.
        nodes.at(page)->forbidden = mode != "page-no-address" && !open;
        const int child = add(page, mode == "page-focus-child" ? UIA_EditControlTypeId : UIA_TextControlTypeId);
        nodes.at(child)->forbidden = mode != "page-no-address" && !open;
        if (open) nodes.at(child)->text = L"Synthetic page text";
        if (mode == "page-focus" || mode == "open-page-focus") focus = page;
        if (mode == "open-page-focus") nodes.at(page)->readOnly = true;
        if (mode == "page-focus-child" || mode == "page-no-address" || mode == "page-unknown") focus = child;
        if (mode == "page-address-bar") nodes.at(1)->type = UIA_EditControlTypeId;
        // Firefox and its forks: Gecko's documents are pages too; so are those of an engine not
        // known (Internet Explorer mode), of a provider that gives no framework (UI Automation's
        // default is empty) and of one whose framework can't be read.
        if (mode == "page-gecko") framework = L"Gecko";
        if (mode == "page-ie") framework = L"InternetExplorer";
        if (mode == "page-no-framework") framework.clear();
        if (mode == "page-framework-fails") frameworkFails = true;
        // Notepad's text area is a document whose value is its text, not an address. Not web
        // content, it is no page and is read.
        if (mode == "text-document") {
            framework = L"Win32";
            nodes.at(page)->address = L"Synthetic note line\nSynthetic second line";
            nodes.at(page)->forbidden = nodes.at(child)->forbidden = false;
            nodes.at(child)->text = L"Synthetic page text"; focus = page;
        }
    }
}
LRESULT CALLBACK procedure(HWND handle, UINT message, WPARAM value, LPARAM data) {
    if (message == WM_GETOBJECT && static_cast<LONG>(data) == UiaRootObjectId)
        return UiaReturnRawElementProvider(handle, value, data, nodes.front().get());
    if (message == WM_APP + 1) {
        if (value == 1) {
            SetForegroundWindow(handle); ::SetFocus(handle);
            UiaRaiseAutomationEvent(nodes.at(focus).get(), UIA_AutomationFocusChangedEventId);
            forbiddenReads = 0; textReads = 0;
        }
        std::cout << JSON({{"window", reinterpret_cast<uintptr_t>(handle)}, {"forbiddenReads", forbiddenReads.load()}, {"textReads", textReads.load()}}).dump() << '\n' << std::flush;
        return 0;
    }
    if (pasteMode && message == WM_KEYDOWN && value == 'V' && (GetKeyState(VK_CONTROL) & 0x8000)) {
        if (!OpenClipboard(handle)) ExitProcess(6);
        const auto content = GetClipboardData(CF_UNICODETEXT);
        const auto text = content ? static_cast<const wchar_t*>(GlobalLock(content)) : nullptr;
        if (text) { pasted[focus - 1] += text; GlobalUnlock(content); }
        CloseClipboard(); return 0;
    }
    if (pasteMode && message == WM_APP + 2) {
        if (value == 1) {
            if (!OpenClipboard(handle) || !EmptyClipboard()) ExitProcess(6);
            const wchar_t text[] = L"Synthetic focus clipboard";
            const auto content = GlobalAlloc(GMEM_MOVEABLE, sizeof(text));
            const auto bytes = content ? GlobalLock(content) : nullptr;
            if (!bytes) ExitProcess(6);
            memcpy(bytes, text, sizeof(text)); GlobalUnlock(content);
            if (!SetClipboardData(CF_UNICODETEXT, content)) ExitProcess(6);
            CloseClipboard();
        } else if (value == 2) {
            if (!OpenClipboard(handle)) ExitProcess(6);
            clipboardHeld = true;
        } else if (value == 3) {
            CloseClipboard(); clipboardHeld = false;
        } else if (value == 4) {
            focus = 2;
            UiaRaiseAutomationEvent(nodes.at(focus).get(), UIA_AutomationFocusChangedEventId);
        }
        JSON reply = {{"focus", focus}, {"nativeFocus", reinterpret_cast<uintptr_t>(::GetFocus())},
            {"firstEmpty", pasted[0].empty()}, {"secondEmpty", pasted[1].empty()},
            {"firstExact", pasted[0] == L"Synthetic focus paste"}, {"secondExact", pasted[1] == L"Synthetic focus paste"}};
        if (value == 5) {
            if (!OpenClipboard(handle)) ExitProcess(6);
            const auto content = GetClipboardData(CF_UNICODETEXT);
            const auto text = content ? static_cast<const wchar_t*>(GlobalLock(content)) : nullptr;
            reply["clipboardOriginal"] = text && std::wstring(text) == L"Synthetic focus clipboard";
            reply["clipboardPasted"] = text && std::wstring(text) == L"Synthetic focus paste";
            if (text) GlobalUnlock(content);
            CloseClipboard();
        }
        std::cout << reply.dump() << '\n' << std::flush;
        return 0;
    }
    if (message == WM_CLOSE) { if (clipboardHeld) CloseClipboard(); UiaDisconnectAllProviders(); DestroyWindow(handle); return 0; }
    if (message == WM_DESTROY) { if (savedClipboard) savedClipboard->restore(); PostQuitMessage(0); return 0; }
    return DefWindowProcW(handle, message, value, data);
}
}
int main(int argc, char** argv) {
    if (argc != 2) return 2;
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 3;
    configure(argv[1]);
    WNDCLASSW type{}; type.lpfnWndProc = procedure; type.hInstance = GetModuleHandleW(nullptr); type.lpszClassName = L"TabMailSyntheticPrivacyProvider";
    if (!RegisterClassW(&type)) return 4;
    window = CreateWindowExW(0, type.lpszClassName, L"Synthetic privacy test", WS_OVERLAPPEDWINDOW,
        100, 100, 640, 480, nullptr, nullptr, type.hInstance, nullptr);
    if (!window) return 5;
    if (pasteMode) {
        savedClipboard = std::make_unique<voice::SavedClipboard>();
    }
    ShowWindow(window, SW_SHOW); SendMessageW(window, WM_APP + 1, 1, 0);
    std::thread([] {
        std::string command;
        while (std::getline(std::cin, command)) {
            if (pasteMode) PostMessageW(window, WM_APP + 2,
                command == "seed" ? 1 : command == "lock" ? 2 : command == "unlock" ? 3 : command == "switch" ? 4 : 5, 0);
            else PostMessageW(window, WM_APP + 1, command == "reset" ? 1 : 0, 0);
        }
        PostMessageW(window, WM_CLOSE, 0, 0);
    }).detach();
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    CoUninitialize();
    return 0;
}
