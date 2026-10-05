// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <cstddef>
#include <cstdint>
#include <limits>
namespace voice::HelperConfig {
inline constexpr uint32_t accessibilityRequestTimeoutMs = 1000;
inline constexpr uint32_t accessibilityRetryIntervalMs = 1000;
inline constexpr unsigned accessibilityMaxAttempts = 5;
// Longest visible text kept from one text field or terminal (UTF-16 units).
// Longest text gathered for one heading, link or table row (bytes of UTF-8).
// Longest the look through what holds a selection, before its text is asked for (ms).
inline constexpr unsigned long long contextSelectionScanMs = 200;
// A terminal read has no deadline: it runs while the user speaks, and the app decides how long to
// wait for it when it sends (owner, 2026-10-05).
inline constexpr unsigned long long terminalReadBudgetMs = (std::numeric_limits<unsigned long long>::max)();
// Longest a paste waits to save the clipboard before typing the text instead (ms). An owner that
// renders late (a VM's clipboard agent) can hold the clipboard open for up to 30 s.
inline constexpr unsigned clipboardSnapshotWaitMs = 500;
// The UI Automation frameworks of web content (UIA_FrameworkIdPropertyId): Chromium's, in every
// Chromium browser and Electron app, and Gecko's (Firefox and its forks). Only their documents are
// web pages with an address to check against the excluded sites; any other document (Notepad's,
// Word's) is read like the rest of the screen.
inline constexpr const wchar_t* webFrameworks[] = {L"Chrome", L"Gecko"};
// Terminal apps use visible-range acquisition and shared viewport projection. A console
// window belongs to the program running in it, so the shells are listed too.
inline constexpr const wchar_t* terminalApps[] = {
    L"WindowsTerminal.exe", L"conhost.exe", L"cmd.exe", L"powershell.exe", L"pwsh.exe", L"wsl.exe",
};
}
