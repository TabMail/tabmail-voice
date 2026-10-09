// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ClipboardKeeper's put-back, with a paste written as `paste` writes it. The test VM's clipboard
// only: these tests never run on a user's machine.
#include <windows.h>
#include <functional>
#include <mutex>
#include <utility>

namespace {
// Run once by the next close of the clipboard, right after it: another program's copy, landing as
// the keeper lets the clipboard go.
std::mutex afterCloseMutex;
std::function<void()> afterClose;
std::function<void()> takeAfterClose() {
    std::lock_guard lock(afterCloseMutex);
    return std::exchange(afterClose, nullptr);
}
BOOL closeThenRun() {
    const BOOL closed = CloseClipboard();
    if (auto run = takeAfterClose()) run();
    return closed;
}
} // namespace
#define CloseClipboard closeThenRun
#include "clipboard.h"
#undef CloseClipboard
#include <cstdlib>
#include <iostream>
#include <string>

using voice::Clipboard;
using voice::ClipboardKeeper;

namespace {
// Long enough for a save, or a put-back `restoreDelay` after the paste, on its own thread.
constexpr DWORD settle = 1000;

void check(bool condition, const char* what) {
    if (!condition) { std::cerr << "failed: " << what << "\n"; std::exit(1); }
}

// Another program's copy: plain text, unmarked.
void copy(const std::wstring& text) {
    Clipboard clipboard;
    clipboard.open();
    check(EmptyClipboard(), "empty");
    const size_t bytes = (text.size() + 1) * sizeof(wchar_t);
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
    check(memory, "alloc");
    std::memcpy(GlobalLock(memory), text.c_str(), bytes);
    GlobalUnlock(memory);
    check(SetClipboardData(CF_UNICODETEXT, memory), "set");
}

std::wstring text() {
    Clipboard clipboard;
    clipboard.open();
    const HANDLE data = GetClipboardData(CF_UNICODETEXT);
    if (!data) return L"";
    std::wstring result(static_cast<const wchar_t*>(GlobalLock(data)));
    GlobalUnlock(data);
    return result;
}

// A save, then a paste of `dictated`; `between` copies after the paste closes the clipboard and
// before it reads its sequence number. The clipboard once the put-back has had its time.
std::wstring pasteAndPutBack(bool between) {
    const std::wstring dictated = L"Dictated text";
    copy(L"Original copy");
    ClipboardKeeper keeper(voice::ClipboardRules{10, 1 << 20, 64});
    keeper.save();
    Sleep(settle);
    DWORD ours = 0;
    {
        Clipboard clipboard;
        clipboard.open();
        const DWORD before = GetClipboardSequenceNumber();
        clipboard.putText(dictated);
        clipboard.close();
        if (between) copy(L"Newer copy");
        ours = GetClipboardSequenceNumber();
        keeper.wrote(before, ours);
    }
    check(text() == (between ? L"Newer copy" : dictated), "the clipboard at the paste keys");
    keeper.restore(ours, dictated);
    Sleep(settle);
    return text();
}
} // namespace

// Two saves, as the app asks for them again and again until the paste, then a paste of `dictated`;
// another program copies as the first save (`atRelease`: the last one, of a copy made in between)
// lets the clipboard go. The clipboard once the put-back has had its time.
std::wstring copiedAsSaved(bool atRelease) {
    const std::wstring dictated = L"Dictated text";
    copy(L"Original copy");
    ClipboardKeeper keeper(voice::ClipboardRules{10, 1 << 20, 64});
    const auto save = [&](bool copying) {
        if (copying) {
            std::lock_guard lock(afterCloseMutex);
            afterClose = [] { copy(L"Copied as saved"); };
        }
        keeper.save();
        Sleep(settle);
        check(!takeAfterClose(), "the copy as the save let go");
    };
    save(!atRelease);
    if (atRelease) copy(L"Copied during the hold");
    save(atRelease);
    DWORD ours = 0;
    {
        Clipboard clipboard;
        clipboard.open();
        const DWORD before = GetClipboardSequenceNumber();
        clipboard.putText(dictated);
        clipboard.close();
        ours = GetClipboardSequenceNumber();
        keeper.wrote(before, ours);
    }
    keeper.restore(ours, dictated);
    Sleep(settle);
    return text();
}

int main() {
    // The clipboard as it was goes back.
    check(pasteAndPutBack(false) == L"Original copy", "put back after the paste");
    // A copy made as the paste closed the clipboard, its number taken for the paste's, stays.
    check(pasteAndPutBack(true) == L"Newer copy", "a newer copy kept");
    // A copy made as the save at key-down let the clipboard go is saved at the release, and goes back.
    check(copiedAsSaved(false) == L"Copied as saved", "a copy made as the first save let go put back");
    // One made as the save at the release let it go was never saved: the paste's text stays.
    check(copiedAsSaved(true) == L"Dictated text", "a copy made as the last save let go not overwritten");
    std::cout << "clipboard keeper: ok\n";
    return 0;
}
