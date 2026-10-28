// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <cstddef>
namespace voice::HelperConfig {
inline constexpr unsigned targetActivationWaitMs = 1000;
inline constexpr unsigned targetActivationPollMs = 20;
// An occurrence named by its original start is found within this of it, searched for this far
// either side (the macOS helper's eventOccurrenceTolerance and eventOccurrenceSearchSpan).
inline constexpr long long eventOccurrenceToleranceMs = 2LL * 60 * 60 * 1000;
inline constexpr long long eventOccurrenceSearchSpanMs = 31LL * 24 * 60 * 60 * 1000;
// A read of calendars, memos or tasks that a change interrupts is made this many times in all.
inline constexpr unsigned calendarReadAttempts = 3;
// The most bytes of rows one calendarEvents reply carries: its 1000 rows with the editor's fields
// and some attendees each (a row with ten is about 1.4 KB). The app reads up to productivityReplyMaxBytes.
inline constexpr size_t calendarEventsMaxBytes = 2 * 1024 * 1024;
}
