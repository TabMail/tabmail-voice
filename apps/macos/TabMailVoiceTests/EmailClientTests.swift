// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Testing
@testable import TabMailVoice

/// Which email app mail and calendar requests go to: the one chosen in Settings, else the default
/// email app if TabMail's add-on runs in it, else none; none at all while no Thunderbird profile
/// has the add-on.
@MainActor
struct EmailClientTests {
    private let thunderbird = "org.mozilla.thunderbird"
    private let beta = "org.mozilla.thunderbirdbeta"
    private let appleMail = "com.apple.mail"
    private let otherAddon = Fixtures.addon(id: "other@example.com")

    @Test func theChosenAppWinsOverTheDefault() {
        #expect(EmailClient.resolve(chosen: beta, systemDefault: thunderbird, hasTabMail: true) == beta)
        #expect(EmailClient.resolve(chosen: thunderbird, systemDefault: appleMail, hasTabMail: true) == thunderbird)
    }

    @Test func aDefaultThunderbirdIsUsedWhenNothingIsChosen() {
        #expect(EmailClient.resolve(chosen: nil, systemDefault: thunderbird, hasTabMail: true) == thunderbird)
        #expect(EmailClient.resolve(chosen: nil, systemDefault: beta, hasTabMail: true) == beta)
    }

    /// Another default email app gets nothing: the Thunderbird tool is left out.
    @Test func anUnsupportedOrMissingDefaultMeansNone() {
        #expect(EmailClient.resolve(chosen: nil, systemDefault: appleMail, hasTabMail: true) == nil)
        #expect(EmailClient.resolve(chosen: nil, systemDefault: nil, hasTabMail: true) == nil)
    }

    /// Without TabMail's add-on nothing is offered, whether Thunderbird is chosen or the default.
    @Test func withoutTheAddonThereIsNoEmailApp() {
        #expect(EmailClient.resolve(chosen: beta, systemDefault: thunderbird, hasTabMail: false) == nil)
        #expect(EmailClient.resolve(chosen: nil, systemDefault: thunderbird, hasTabMail: false) == nil)
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

    /// The add-on counts in any profile, not only the first one listed.
    @Test func anEnabledAddonInAnyProfileCounts() throws {
        let folder = try Fixtures.thunderbirdFolder(profiles: [[otherAddon], [otherAddon, Fixtures.addon()]])
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(EmailClient.hasTabMail(in: folder))
    }

    /// A disabled add-on, or only other add-ons, is no TabMail.
    @Test(arguments: [
        (DictationConfig.tabMailAddonID, true, false),
        (DictationConfig.tabMailAddonID, false, true),
        ("other@example.com", false, false),
    ])
    func aDisabledOrMissingAddonDoesNotCount(id: String, userDisabled: Bool, appDisabled: Bool) throws {
        let folder = try Fixtures.thunderbirdFolder(profiles: [[Fixtures.addon(id: id, userDisabled: userDisabled, appDisabled: appDisabled)]])
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(!EmailClient.hasTabMail(in: folder))
    }

    /// A profile stored outside the Thunderbird folder (`IsRelative=0`) is read at its absolute path.
    @Test func anAbsoluteProfilePathIsFollowed() throws {
        let folder = try Fixtures.thunderbirdFolder(profiles: [])
        defer { try? FileManager.default.removeItem(at: folder) }
        let profile = folder.appending(path: "elsewhere/test.profile")
        try Fixtures.writeExtensions([Fixtures.addon()], in: profile)
        try "[Profile0]\nName=profile-0\nIsRelative=0\nPath=\(profile.path)\n"
            .write(to: folder.appending(path: "profiles.ini"), atomically: true, encoding: .utf8)
        #expect(EmailClient.hasTabMail(in: folder))
    }

    /// No Thunderbird folder, or a profile whose `extensions.json` is missing or unreadable, is no
    /// TabMail.
    @Test func missingOrUnreadableFilesMeanNoAddon() throws {
        #expect(!EmailClient.hasTabMail(in: FileManager.default.temporaryDirectory.appending(path: "TabMailVoiceTests-\(UUID().uuidString)")))

        let folder = try Fixtures.thunderbirdFolder(profiles: [[Fixtures.addon()], [Fixtures.addon()]])
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.removeItem(at: folder.appending(path: "Profiles/test.profile-0/extensions.json"))
        try Data("not json".utf8).write(to: folder.appending(path: "Profiles/test.profile-1/extensions.json"))
        #expect(!EmailClient.hasTabMail(in: folder))
    }
}
