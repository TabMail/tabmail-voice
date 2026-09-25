// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Testing
@testable import TabMail

struct DictationCleanupTests {
    @Test func sendsTheDictationWithWhereItGoesAndWhatIsOnScreen() {
        var context = ScreenContext(appName: "Example Notes", bundleID: "com.example.notes")
        context.host = "notes.example.com"
        context.terminalProgram = "example-shell"
        context.windowTitle = "Weekly sync"
        context.textBeforeCaret = "Ask Jordan about the "
        context.append(.heading, "Agenda")
        context.appendCaret()

        let message = DictationCleanup.message(dictation: "quarterly road map", context: context)

        #expect(message.role == "system")
        #expect(message.content == DictationConfig.cleanupPrompt)
        #expect(message.vars == [
            "dictation": "quarterly road map",
            "app_name": "Example Notes",
            "web_host": "notes.example.com",
            "terminal_program": "example-shell",
            "window_title": "Weekly sync",
            "screen_text": "## Agenda\n» Ask Jordan about the ‸",
        ])
    }

    /// Without Accessibility access there is no context: the prompt still gets every field, empty.
    @Test func withoutContextEveryFieldIsEmpty() {
        let message = DictationCleanup.message(dictation: "hello", context: nil)
        #expect(message.vars == [
            "dictation": "hello", "app_name": "", "web_host": "", "terminal_program": "", "window_title": "", "screen_text": "",
        ])
    }
}
