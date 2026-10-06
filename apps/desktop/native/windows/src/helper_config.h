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
// A terminal read has no deadline (ms): it runs while the user speaks, in voice-screen-reader.exe,
// a program of its own, so it holds up nothing else; a dictation uses it only if it is done in
// time, and the app ends that process when the read is no longer wanted (owner, 2026-10-05).
inline constexpr unsigned long long terminalReadBudgetMs = (std::numeric_limits<unsigned long long>::max)();
// Longest one accessibility request may run before the helper ends itself, so a provider that
// stops answering can't hold the queue (ms).
inline constexpr unsigned long long accessibilityWatchdogMs = 2500;
// Longest a paste waits for another program to close the clipboard (ms), never past the paste's
// deadline. A paste's watchdog gets this on top of its deadline, so the wait is never what ends the helper.
inline constexpr unsigned long long clipboardOpenWaitMs = 500;
// The UI Automation frameworks (UIA_FrameworkIdPropertyId) of an app's own native controls, never
// web content: a document of one of these (Notepad's and Word's text are Win32) is no web page and
// is read like the rest of the screen. Every other document is a web page whose address is checked
// against the excluded sites: a browser engine's (Chrome, Gecko, InternetExplorer), an unknown
// framework's, and one with no framework or none that can be read.
inline constexpr const wchar_t* nativeDocumentFrameworks[] = {L"Win32", L"WinForm", L"WPF", L"XAML", L"DirectUI"};
// Terminal apps use visible-range acquisition and shared viewport projection. A console
// window belongs to the program running in it, so the shells are listed too.
inline constexpr const wchar_t* terminalApps[] = {
    L"WindowsTerminal.exe", L"conhost.exe", L"cmd.exe", L"powershell.exe", L"pwsh.exe", L"wsl.exe",
};
}
