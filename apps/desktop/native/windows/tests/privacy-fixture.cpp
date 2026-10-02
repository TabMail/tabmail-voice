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
#include <algorithm>

namespace {
using JSON = nlohmann::json;
HWND window = nullptr;
int focus = 1;
std::atomic<unsigned> forbiddenReads{0}, textReads{0};
struct Node;
std::vector<std::unique_ptr<Node>> nodes;
struct Node final : IRawElementProviderSimple, IRawElementProviderFragment, IRawElementProviderFragmentRoot, IValueProvider {
    int id, parent = -1;
    CONTROLTYPEID type = UIA_TextControlTypeId;
    bool password = false, forbidden = false, unknownAddress = false;
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
        else if (property == UIA_IsEnabledPropertyId || property == UIA_IsControlElementPropertyId || property == UIA_IsContentElementPropertyId || property == UIA_IsKeyboardFocusablePropertyId) boolean(true);
        else if (property == UIA_IsOffscreenPropertyId) boolean(false);
        else if (property == UIA_HasKeyboardFocusPropertyId) boolean(id == focus);
        else if (property == UIA_ControlTypePropertyId) number(type);
        else if (property == UIA_ProcessIdPropertyId) number(static_cast<LONG>(GetCurrentProcessId()));
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
        RECT frame{}; GetWindowRect(window, &frame);
        *result = {static_cast<double>(frame.left + 20), static_cast<double>(frame.top + 40 + id * 25), 400, 24};
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetEmbeddedFragmentRoots(SAFEARRAY** result) override { *result = nullptr; return S_OK; }
    HRESULT STDMETHODCALLTYPE SetFocus() override { focus = id; ::SetFocus(window); return S_OK; }
    HRESULT STDMETHODCALLTYPE get_FragmentRoot(IRawElementProviderFragmentRoot** result) override { *result = nodes.front().get(); (*result)->AddRef(); return S_OK; }
    HRESULT STDMETHODCALLTYPE ElementProviderFromPoint(double, double, IRawElementProviderFragment** result) override { *result = nodes.at(focus).get(); (*result)->AddRef(); return S_OK; }
    HRESULT STDMETHODCALLTYPE GetFocus(IRawElementProviderFragment** result) override { *result = nodes.at(focus).get(); (*result)->AddRef(); return S_OK; }
    HRESULT STDMETHODCALLTYPE SetValue(LPCWSTR) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_Value(BSTR* result) override {
        *result = nullptr;
        if (type == UIA_DocumentControlTypeId) {
            if (unknownAddress) return E_FAIL;
            *result = SysAllocString(address.c_str());
        } else { read(); *result = SysAllocString(text.c_str()); }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_IsReadOnly(BOOL* result) override { *result = FALSE; return S_OK; }
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
    if (mode == "password-focus") {
        nodes.at(1)->password = true; nodes.at(1)->type = UIA_EditControlTypeId;
        nodes.at(1)->text = L"DO_NOT_READ_SYNTHETIC_PASSWORD";
        add(1, UIA_TextControlTypeId); nodes.back()->forbidden = true;
    } else if (mode.starts_with("password-")) {
        int container = 0;
        if (mode == "password-row") container = add(0, UIA_DataItemControlTypeId);
        if (mode == "password-link") container = add(0, UIA_HyperlinkControlTypeId);
        if (mode == "password-web-control") { const int page = add(0, UIA_DocumentControlTypeId); container = add(page, UIA_ButtonControlTypeId); }
        add(container, UIA_TextControlTypeId);
        const int secret = add(container, UIA_EditControlTypeId, true);
        add(secret, UIA_TextControlTypeId); nodes.back()->forbidden = true;
    } else {
        int parent = 0;
        if (mode == "page-frame") parent = add(0, UIA_DocumentControlTypeId);
        if (mode == "page-row") parent = add(0, UIA_DataItemControlTypeId);
        if (mode == "page-in-focus") parent = 1;
        const int page = add(parent, UIA_DocumentControlTypeId);
        nodes.at(page)->address = L"https://blocked.example/synthetic";
        if (mode == "page-no-address") nodes.at(page)->address.clear();
        if (mode == "page-unknown") nodes.at(page)->unknownAddress = true;
        // Querying a refused page's address is permitted; its contents are not.
        nodes.at(page)->forbidden = mode != "page-no-address";
        const int child = add(page, mode == "page-focus-child" ? UIA_EditControlTypeId : UIA_TextControlTypeId);
        nodes.at(child)->forbidden = mode != "page-no-address";
        if (mode == "page-focus") focus = page;
        if (mode == "page-focus-child" || mode == "page-no-address" || mode == "page-unknown") focus = child;
        if (mode == "page-address-bar") nodes.at(1)->type = UIA_EditControlTypeId;
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
    if (message == WM_CLOSE) { UiaDisconnectAllProviders(); DestroyWindow(handle); return 0; }
    if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
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
    ShowWindow(window, SW_SHOW); SendMessageW(window, WM_APP + 1, 1, 0);
    std::thread([] {
        std::string command;
        while (std::getline(std::cin, command)) PostMessageW(window, WM_APP + 1, command == "reset" ? 1 : 0, 0);
        PostMessageW(window, WM_CLOSE, 0, 0);
    }).detach();
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    CoUninitialize();
    return 0;
}
