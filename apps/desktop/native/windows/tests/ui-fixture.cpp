// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include <windows.h>
#include <nlohmann/json.hpp>
#include <iostream>
#include <string>
#include <thread>
#include <optional>
#include <atomic>
#include <cwchar>
#include "../src/clipboard.h"
#include "../src/text.h"

namespace {
HWND edit = nullptr, button = nullptr;
voice::Clipboard* original = nullptr;
bool delayedClipboard = false;
// "racing": a copy made by another program just after the helper saved the clipboard, before it
// writes. The clipboard holds text and a private format rendered on demand, which only a reader
// saving every format asks for (a VM's clipboard agent reads text only). When the helper asks for
// it, the racer takes the clipboard the moment the save lets it go. `raceWon` says the copy landed
// in that gap (and not after the write); an attempt the helper didn't start is not won.
UINT raceFormat = 0;
bool racingClipboard = false;
std::atomic<int> raceGeneration{0}, raceStarted{0};
std::atomic<bool> raceWon{false};
bool helperReading() {
    DWORD pid = 0;
    GetWindowThreadProcessId(GetOpenClipboardWindow(), &pid);
    const HANDLE process = pid ? OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) : nullptr;
    if (!process) return false;
    wchar_t path[MAX_PATH]{}; DWORD size = MAX_PATH;
    const bool named = QueryFullProcessImageNameW(process, 0, path, &size) != FALSE;
    CloseHandle(process);
    const std::wstring name(path, size), helper = L"\\voice-windows.exe";
    return named && name.size() > helper.size() && _wcsicmp(name.c_str() + name.size() - helper.size(), helper.c_str()) == 0;
}
void racer(int generation) {
    HWND owner = CreateWindowExW(0, L"STATIC", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!owner) ExitProcess(1);
    const auto end = GetTickCount64() + 3000;
    while (raceStarted.load() != generation) {
        if (raceGeneration.load() != generation || GetTickCount64() >= end) { DestroyWindow(owner); return; }
        Sleep(0);
    }
    while (!OpenClipboard(owner)) { if (GetTickCount64() >= end) ExitProcess(1); }
    // The helper's own text carries this format: the write came first, and this copy is not made.
    if (!IsClipboardFormatAvailable(RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing"))) {
        if (!EmptyClipboard()) ExitProcess(1);
        const std::wstring text = L"Synthetic newer copy";
        voice::ClipboardItem content(CF_UNICODETEXT, voice::memoryCopy(text.c_str(), (text.size() + 1) * sizeof(wchar_t)));
        content.publish();
        raceWon = true;
    }
    CloseClipboard();
    DestroyWindow(owner);
}
void ready(HWND window, const char* mode) {
    std::cout << nlohmann::json({{"window", reinterpret_cast<uintptr_t>(window)}, {"mode", mode}}).dump() << '\n' << std::flush;
}
LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM value, LPARAM data) {
    if (message == WM_RENDERFORMAT && racingClipboard && value == raceFormat) {
        const char bytes[] = "synthetic race format";
        voice::ClipboardItem content(raceFormat, voice::memoryCopy(bytes, sizeof(bytes)));
        content.publish();
        racingClipboard = false;
        if (helperReading()) raceStarted = raceGeneration.load();
        return 0;
    }
    if (message == WM_RENDERFORMAT && delayedClipboard && value == CF_UNICODETEXT) {
        // Simulate a clipboard owner materializing data on demand. GetClipboardData
        // legitimately waits for this synchronous response while the caller holds it open.
        Sleep(2100);
        const std::wstring text = L"Synthetic delayed clipboard";
        voice::ClipboardItem content(CF_UNICODETEXT, voice::memoryCopy(text.c_str(), (text.size() + 1) * sizeof(wchar_t)));
        content.publish();
        delayedClipboard = false;
        return 0;
    }
    if (message == WM_APP + 2) {
        if (!original) ExitProcess(2); // Read-only accessibility fixtures never use the clipboard.
        if (value == 7) {
            if (!OpenClipboard(window) || !EmptyClipboard()) ExitProcess(1);
            delayedClipboard = true;
            SetClipboardData(CF_UNICODETEXT, nullptr);
            CloseClipboard();
            std::cout << nlohmann::json({{"command", "delayed"}}).dump() << '\n' << std::flush;
        } else if (value == 8) {
            raceFormat = RegisterClipboardFormatW(L"TabMailVoiceSyntheticRace");
            if (!raceFormat || !OpenClipboard(window) || !EmptyClipboard()) ExitProcess(1);
            const std::wstring text = L"Synthetic racing original";
            voice::ClipboardItem content(CF_UNICODETEXT, voice::memoryCopy(text.c_str(), (text.size() + 1) * sizeof(wchar_t)));
            content.publish();
            racingClipboard = true;
            SetClipboardData(raceFormat, nullptr);
            CloseClipboard();
            raceWon = false;
            std::thread(racer, ++raceGeneration).detach();
            std::cout << nlohmann::json({{"command", "racing"}}).dump() << '\n' << std::flush;
        } else if (value == 9) {
            std::cout << nlohmann::json({{"command", "race"}, {"won", raceWon.load()}}).dump() << '\n' << std::flush;
        } else if (value == 1 || value == 2) {
            if (!OpenClipboard(window)) ExitProcess(1);
            if (!EmptyClipboard()) ExitProcess(1);
            const std::wstring text = value == 1 ? L"Synthetic clipboard original" : L"Synthetic newer copy";
            voice::ClipboardItem content(CF_UNICODETEXT, voice::memoryCopy(text.c_str(), (text.size() + 1) * sizeof(wchar_t)));
            content.publish();
            const char bytes[] = "synthetic binary format";
            voice::ClipboardItem binary(RegisterClipboardFormatW(L"TabMailVoiceSyntheticBinary"), voice::memoryCopy(bytes, sizeof(bytes)));
            binary.publish();
            CloseClipboard();
            std::cout << nlohmann::json({{"command", value == 1 ? "seed" : "copy"}}).dump() << '\n' << std::flush;
        } else if (value == 3) {
            wchar_t text[2048]{}; GetWindowTextW(edit, text, 2048);
            std::cout << nlohmann::json({{"command", "value"}, {"text", voice::utf8(text)}}).dump() << '\n' << std::flush;
        } else if (value == 5 || value == 6) {
            if (value == 5 && !OpenClipboard(window)) ExitProcess(1);
            if (value == 6) CloseClipboard();
            std::cout << nlohmann::json({{"command", value == 5 ? "lock" : "unlock"}}).dump() << '\n' << std::flush;
        } else if (value == 4) {
            if (!OpenClipboard(window)) {
                std::cout << nlohmann::json({{"command", "clipboard"}, {"busy", true}}).dump() << '\n' << std::flush;
                return 0;
            }
            const auto content = GetClipboardData(CF_UNICODETEXT);
            const auto text = content ? static_cast<const wchar_t*>(GlobalLock(content)) : nullptr;
            const auto binary = GetClipboardData(RegisterClipboardFormatW(L"TabMailVoiceSyntheticBinary"));
            const auto bytes = binary ? static_cast<const char*>(GlobalLock(binary)) : nullptr;
            nlohmann::json reply = {{"command", "clipboard"}, {"text", text ? voice::utf8(text) : ""},
                {"binary", bytes ? std::string(bytes) : ""},
                {"excluded", IsClipboardFormatAvailable(RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing")) != FALSE}};
            if (content && text) GlobalUnlock(content);
            if (binary && bytes) GlobalUnlock(binary);
            CloseClipboard();
            std::cout << reply.dump() << '\n' << std::flush;
        }
        return 0;
    }
    if (message == WM_APP + 1) {
        if (value == 5) { DestroyWindow(window); return 0; }
        const std::wstring text = value == 6 ? std::wstring(20001, L'x') : value == 7 ? std::wstring(20000, L'x') :
            value == 8 ? L"Before Xyvora \U0001F642 after." : value == 9 ? L"" : value == 10 ? L"password: synthetic" L"value123" : L"Before selected after.";
        SetWindowTextW(window, value == 10 ? L"password: synthetic" L"title123" : L"Native editor integration test");
        SetWindowTextW(edit, text.c_str());
        LONG_PTR style = GetWindowLongPtrW(edit, GWL_STYLE);
        style = value == 2 ? style | ES_PASSWORD : style & ~static_cast<LONG_PTR>(ES_PASSWORD);
        SetWindowLongPtrW(edit, GWL_STYLE, style);
        SendMessageW(edit, EM_SETPASSWORDCHAR, value == 2 ? '*' : 0, 0);
        SendMessageW(edit, EM_SETREADONLY, value == 3, 0);
        SetForegroundWindow(window);
        SetFocus(value == 4 ? button : edit);
        SendMessageW(edit, EM_SETSEL, 7, 15);
        ready(window, value == 2 ? "password" : value == 3 ? "readOnly" : value == 4 ? "button" : value == 6 ? "long" : value == 7 ? "limit" : value == 8 ? "unicode" : value == 9 ? "empty" : value == 10 ? "secret" : "editable");
        return 0;
    }
    if (message == WM_DESTROY) { if (original) original->restoreSnapshot(); PostQuitMessage(0); return 0; }
    return DefWindowProcW(window, message, value, data);
}
}
int run(bool preservesClipboard) {
    WNDCLASSW type{};
    type.lpfnWndProc = procedure;
    type.hInstance = GetModuleHandleW(nullptr);
    type.lpszClassName = L"TabMailVoiceSyntheticFields";
    if (!RegisterClassW(&type)) return 1;
    HWND window = CreateWindowExW(0, type.lpszClassName, L"Synthetic TabMail Voice fields", WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 640, 240, nullptr, nullptr, type.hInstance, nullptr);
    if (!window) return 1;
    edit = CreateWindowExW(0, L"EDIT", L"Before selected after.", WS_CHILD | WS_VISIBLE | WS_BORDER | ES_AUTOHSCROLL,
        20, 20, 550, 40, window, nullptr, type.hInstance, nullptr);
    button = CreateWindowExW(0, L"BUTTON", L"Synthetic button", WS_CHILD | WS_VISIBLE,
        20, 80, 180, 40, window, nullptr, type.hInstance, nullptr);
    if (!edit || !button) return 1;
    std::optional<voice::Clipboard> saved;
    if (preservesClipboard) {
        saved.emplace(); original = &*saved;
        saved->open(); saved->snapshot(); saved->close();
    }
    ShowWindow(window, SW_SHOW);
    SendMessageW(window, WM_APP + 1, 1, 0);
    std::thread([window] {
        std::string command;
        while (std::getline(std::cin, command)) {
            if (command == "seed" || command == "copy" || command == "value" || command == "clipboard" || command == "lock" || command == "unlock" || command == "delayed" || command == "racing" || command == "race") {
                PostMessageW(window, WM_APP + 2, command == "seed" ? 1 : command == "copy" ? 2 : command == "value" ? 3 : command == "clipboard" ? 4 : command == "lock" ? 5 : command == "delayed" ? 7 : command == "racing" ? 8 : command == "race" ? 9 : 6, 0);
                continue;
            }
            const WPARAM mode = command == "password" ? 2 : command == "readOnly" ? 3 : command == "button" ? 4 : command == "close" ? 5 : command == "long" ? 6 : command == "limit" ? 7 : command == "unicode" ? 8 : command == "empty" ? 9 : command == "secret" ? 10 : 1;
            if (!PostMessageW(window, WM_APP + 1, mode, 0)) ExitProcess(1);
        }
        PostMessageW(window, WM_APP + 1, 5, 0);
    }).detach();
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    ExitProcess(0);
}

int main(int argc, char** argv) {
    if (argc > 2 || (argc == 2 && std::string(argv[1]) != "--read-only")) return 2;
    try { return run(argc == 1); }
    catch (const std::exception& error) {
        // Only fixed internal clipboard errors; no captured clipboard contents.
        std::cerr << "Synthetic fixture: " << error.what() << '\n';
        return 1;
    }
}
