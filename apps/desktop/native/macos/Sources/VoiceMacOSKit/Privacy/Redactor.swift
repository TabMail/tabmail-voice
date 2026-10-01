// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// One kind of secret-looking text and what replaces it (ADR-DESK-046). The list (`Redactor.all`)
/// is generated from `native/shared/privacy/redactors.json`, the one definition every platform's
/// helper shares, and checked against `redaction-cases.json`.
struct Redactor: Sendable {
    let name: String
    let regex: NSRegularExpression
    /// What a match becomes: `$1`, `$2` are the pattern's groups.
    let replacement: String

    init(name: String, pattern: String, ignoreCase: Bool, replacement: String) {
        self.name = name
        // The patterns are generated and checked by the tests: one that doesn't compile is a build defect.
        regex = try! NSRegularExpression(pattern: pattern, options: ignoreCase ? [.caseInsensitive] : [])
        self.replacement = replacement
    }

    /// `text` with what looks like a secret replaced: every redactor, in order. A safety net for
    /// text read off the screen: it catches the common shapes, not every secret.
    static func redact(_ text: String) -> String {
        all.reduce(text) { text, redactor in
            redactor.regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: redactor.replacement)
        }
    }
}

extension ScreenContext {
    /// The context with secret-looking text taken out of everything read off the screen, before it
    /// leaves the helper.
    var redacted: ScreenContext {
        var context = self
        context.windowTitle = windowTitle.map(Redactor.redact)
        context.textBeforeCaret = Redactor.redact(textBeforeCaret)
        context.selectedText = Redactor.redact(selectedText)
        context.textAfterCaret = Redactor.redact(textAfterCaret)
        context.blocks = blocks.map { block in
            var block = block
            block.text = Redactor.redact(block.text)
            return block
        }
        return context
    }
}
