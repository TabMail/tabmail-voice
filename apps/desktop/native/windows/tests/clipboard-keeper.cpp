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
// Long enough for a save, or a put-back `restoreDelay` after an app reads the paste, on its own thread.
constexpr DWORD settle = 1000;
// The keeper's waits: `readWait` longer than a busy app's late read below, and longer than `settle`.
const voice::ClipboardRules rules{1500, 10, 1 << 20, 64};
// A busy app handling the paste keys late: past `restoreDelay`, within `readWait`.
constexpr DWORD lateRead = 300;

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

// A paste's sequence number and the number `offer` gave it, as `paste` hands them to the put-back.
struct Written {
    DWORD ours;
    uint64_t paste;
};

// Offers `dictated` as `paste` does, through the keeper's owner; `between` copies after the paste
// closes the clipboard and before it reads its sequence number.
Written write(ClipboardKeeper& keeper, const std::wstring& dictated, bool between = false) {
    Clipboard clipboard(keeper.owner());
    clipboard.open();
    const DWORD before = GetClipboardSequenceNumber();
    clipboard.offerText();
    const auto paste = keeper.offer(dictated);
    clipboard.close();
    if (between) copy(L"Newer copy");
    const DWORD ours = GetClipboardSequenceNumber();
    keeper.wrote(before, ours);
    return {ours, paste};
}

// A save, then a paste of `dictated`, which the target app reads as it handles the keys; `between`
// copies after the paste closes the clipboard and before it reads its sequence number. The
// clipboard once the put-back has had its time.
std::wstring pasteAndPutBack(bool between) {
    const std::wstring dictated = L"Dictated text";
    copy(L"Original copy");
    ClipboardKeeper keeper(rules);
    keeper.save();
    Sleep(settle);
    const auto written = write(keeper, dictated, between);
    check(text() == (between ? L"Newer copy" : dictated), "the clipboard at the paste keys");
    keeper.restore(written.ours, written.paste, true);
    // A newer copy is never read as the paste's text, so its put-back decides only once `readWait` passes.
    Sleep(between ? rules.readWait + settle : settle);
    return text();
}

// A save, then a paste whose keys went (`keysSent`) or were refused, read by no app until `readAt`
// (never, for 0). What the app read, and the clipboard once the put-back has had its time.
std::pair<std::wstring, std::wstring> pasteReadLate(DWORD readAt, bool keysSent = true) {
    copy(L"Original copy");
    ClipboardKeeper keeper(rules);
    keeper.save();
    Sleep(settle);
    const auto written = write(keeper, L"Dictated text");
    keeper.restore(written.ours, written.paste, keysSent);
    std::wstring read;
    if (readAt) { Sleep(readAt); read = text(); }
    else {
        // Unread past `restoreDelay`: still the paste's, asked of no one (reading would hand it over).
        Sleep(lateRead);
        check(GetClipboardOwner() == keeper.owner(), "an unread paste stays past restoreDelay");
        Sleep(rules.readWait);
    }
    Sleep(settle);
    return {read, text()};
}

// A refused paste whose put-back starts only once a second paste has offered its text: that
// put-back is the first paste's, so it leaves the second's unread text, which its target then
// reads; the clipboard as it was goes back after that read. What the second target read, and
// the clipboard once its put-back has had its time.
std::pair<std::wstring, std::wstring> refusedPasteOvertaken() {
    copy(L"Original copy");
    ClipboardKeeper keeper(rules);
    keeper.save();
    Sleep(settle);
    const auto first = write(keeper, L"First dictation");
    const auto second = write(keeper, L"Second dictation");
    keeper.restore(first.ours, first.paste, false);
    Sleep(settle);
    const std::wstring read = text();
    keeper.restore(second.ours, second.paste, true);
    Sleep(settle);
    return {read, text()};
}
} // namespace

// Two saves, as the app asks for them again and again until the paste, then a paste of `dictated`;
// another program copies as the first save (`atRelease`: the last one, of a copy made in between)
// lets the clipboard go. The clipboard once the put-back has had its time.
std::wstring copiedAsSaved(bool atRelease) {
    const std::wstring dictated = L"Dictated text";
    copy(L"Original copy");
    ClipboardKeeper keeper(rules);
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
    const auto written = write(keeper, dictated);
    check(text() == dictated, "the target app reads the paste's text");
    keeper.restore(written.ours, written.paste, true);
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
    // A busy app reading only after `restoreDelay` still gets the paste's text, and the clipboard as
    // it was goes back after its read.
    check(pasteReadLate(lateRead) == std::pair<std::wstring, std::wstring>{L"Dictated text", L"Original copy"}, "a late reader gets the paste's text");
    // A paste no app reads goes back once `readWait` passes.
    check(pasteReadLate(0).second == L"Original copy", "an unread paste put back after readWait");
    // A paste refused before its keys goes back at once: no app is going to read it.
    check(pasteReadLate(lateRead, false).first == L"Original copy", "a refused paste put back at once");
    // An older paste's put-back never puts the clipboard back over a newer paste's unread text.
    check(refusedPasteOvertaken() == std::pair<std::wstring, std::wstring>{L"Second dictation", L"Original copy"}, "an overtaken put-back leaves the newer paste");
    // A paste's text no app has read is handed over as the keeper ends (the helper's exit): the
    // clipboard still holds it.
    {
        copy(L"Original copy");
        ClipboardKeeper keeper(rules);
        write(keeper, L"Dictated text");
    }
    check(text() == L"Dictated text", "an unread paste's text kept once the keeper ends");
    std::cout << "clipboard keeper: ok\n";
    return 0;
}
