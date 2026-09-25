// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#if DEBUG
import SwiftUI

/// Debug builds only: shows the last captured screen context, to judge what phase 2 would see.
struct ScreenContextDebugView: View {
    let probe: ScreenContextProbe

    static let windowID = "screen-context"

    var body: some View {
        ScrollView {
            if let context = probe.lastContext {
                VStack(alignment: .leading, spacing: 12) {
                    section("Summary", context.summary)
                    section("Window title", context.windowTitle ?? "")
                    section("Before caret", context.textBeforeCaret)
                    section("Selected", context.selectedText)
                    section("After caret", context.textAfterCaret)
                    section("Visible text", context.renderedText())
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("Dictate once to capture the screen context.")
                    .padding()
            }
        }
        .frame(minWidth: 600, minHeight: 500)
    }

    private func section(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.headline)
            Text(text.isEmpty ? "—" : text)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
        }
    }
}
#endif
