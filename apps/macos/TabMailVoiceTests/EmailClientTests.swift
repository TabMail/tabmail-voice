// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMailVoice

/// Which email app mail and calendar requests go to: the one chosen in Settings, else the default
/// email app if TabMail's add-on runs in it, else none.
@MainActor
struct EmailClientTests {
    private let thunderbird = "org.mozilla.thunderbird"
    private let beta = "org.mozilla.thunderbirdbeta"
    private let appleMail = "com.apple.mail"

    @Test func theChosenAppWinsOverTheDefault() {
        #expect(EmailClient.resolve(chosen: beta, systemDefault: thunderbird) == beta)
        #expect(EmailClient.resolve(chosen: thunderbird, systemDefault: appleMail) == thunderbird)
    }

    @Test func aDefaultThunderbirdIsUsedWhenNothingIsChosen() {
        #expect(EmailClient.resolve(chosen: nil, systemDefault: thunderbird) == thunderbird)
        #expect(EmailClient.resolve(chosen: nil, systemDefault: beta) == beta)
    }

    /// Another default email app gets nothing: the Thunderbird tool is left out.
    @Test func anUnsupportedOrMissingDefaultMeansNone() {
        #expect(EmailClient.resolve(chosen: nil, systemDefault: appleMail) == nil)
        #expect(EmailClient.resolve(chosen: nil, systemDefault: nil) == nil)
    }

    /// The choice survives a relaunch, and going back to the default forgets it.
    @Test func theChoiceIsPersisted() {
        let defaults = InMemoryDefaults()
        let settings = AppSettings(defaults: defaults)
        #expect(settings.emailClient == nil)

        settings.emailClient = beta
        #expect(AppSettings(defaults: defaults).emailClient == beta)

        settings.emailClient = nil
        #expect(AppSettings(defaults: defaults).emailClient == nil)
    }
}
