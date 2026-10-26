// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The window a whole-window read is bound to (`walk::LastReadWindow`), the guard both C++ screen
// readers (Windows, Linux) keep: a read bound to an earlier one (`sameWindowAs`) reads that read's
// window only while it was the last numbered read and its window is still the one in front.
#include <nlohmann/json.hpp>
#include <cstdint>
#include <iostream>
#include "walk.h"

namespace {
using voice::walk::LastReadWindow;
using voice::walk::ScreenRead;

ScreenRead shown(int64_t number) { return {number, false, 0}; }
ScreenRead bound(int64_t number, int64_t to) { return {number, true, to}; }

bool check(bool ok, const char* name) {
    if (!ok) std::cerr << "failed: " << name << '\n';
    return ok;
}

// `first` and `second` are two windows by the OS's name for them.
template<class Window>
bool cases(Window first, Window second) {
    bool ok = true;
    {
        LastReadWindow<Window> last;
        ok &= check(!last.admits(bound(1, 1), first), "a reader that has read nothing (a restarted one) reads no bound window");
        ok &= check(last.admits(shown(2), first), "an unbound read goes on");
        ok &= check(last.admits(bound(3, 2), first), "the last read's window, still in front, is read");
        ok &= check(last.admits(bound(4, 3), first), "a bound read that went on is the last read");
        ok &= check(!last.admits(bound(5, 2), first), "a read bound to one no longer the last is not read");
    }
    {
        LastReadWindow<Window> last;
        ok &= check(last.admits(shown(1), first), "the first read");
        ok &= check(!last.admits(bound(2, 1), second), "another window in front is not read in its place");
        ok &= check(last.admits(bound(3, 1), first), "a refused read does not become the last; the read's window in front again is read");
    }
    {
        LastReadWindow<Window> last;
        ok &= check(last.admits(shown(1), first), "the first read");
        ok &= check(last.admits(shown(2), first), "an intervening numbered read");
        ok &= check(!last.admits(bound(3, 1), first), "a read bound to one before the intervening read is not read");
    }
    {
        LastReadWindow<Window> last;
        ok &= check(last.admits(shown(1), first), "the first read");
        ok &= check(last.admits(shown(0), second), "a read with no number goes on");
        ok &= check(last.admits(bound(2, 1), first), "a read with no number is no last read");
    }
    return ok;
}
}

int main() {
    bool ok = cases<uint64_t>(7000, 7001);
    static int windows[2];
    ok &= cases<const void*>(&windows[0], &windows[1]);
    // The request as the core accepts it: a bound read keeps its number and the read it is bound to.
    const auto read = voice::walk::screenRead({{"read", 2}, {"wholeWindow", true}, {"sameWindowAs", 1}});
    ok &= check(read.number == 2 && read.wholeWindow && read.sameWindowAs == 1, "the core's bound read");
    const auto plain = voice::walk::screenRead(nlohmann::json::object());
    ok &= check(plain.number == 0 && !plain.wholeWindow && plain.sameWindowAs == 0, "the core's plain read");
    return ok ? 0 : 1;
}
