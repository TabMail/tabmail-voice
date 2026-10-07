// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <cstddef>
#include <cstdint>
namespace voice::HelperConfig {
inline constexpr uint32_t accessibilityRequestTimeoutMs = 1000;
inline constexpr uint32_t accessibilityRetryIntervalMs = 1000;
inline constexpr unsigned accessibilityMaxAttempts = 5;
// Longest the look through what holds a selection, before its text is asked for (ms).
inline constexpr unsigned long long contextSelectionScanMs = 200;
// Longest one accessibility request may run before the helper ends itself, so a provider that
// stops answering can't hold the queue (ms).
inline constexpr unsigned long long accessibilityWatchdogMs = 2500;
// Longest a terminal's field read for corrections may take (ms), well under the watchdog: the app
// asks for one every half second while it watches the field, and a read cut short gives no field.
inline constexpr unsigned long long terminalFieldReadMs = 1000;
// Longest a paste waits for another program to close the clipboard (ms), never past the paste's
// deadline. A paste's watchdog gets this on top of its deadline, so the wait is never what ends the helper.
inline constexpr unsigned long long clipboardOpenWaitMs = 500;
// The control types that lay their text out as a block of its own (a rich editor's paragraph is a
// group), as the Mac's block roles; Chromium gives a heading the text type and a level. The UI
// Automation ids of group, list, list item and table (this header stays free of Windows headers;
// uia_caret_source.h checks them against UIAutomation.h).
inline constexpr int blockControlTypes[] = {50026, 50008, 50007, 50036};
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
