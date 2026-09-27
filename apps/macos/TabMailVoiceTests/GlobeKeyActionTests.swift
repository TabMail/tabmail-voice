// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Testing
@testable import TabMailVoice

/// The Globe key's own action while fn is the hotkey (ADR-DESK-022): off meanwhile, the user's
/// choice back afterwards. Against a stand-in for the system setting; no test changes the real one.
@MainActor
struct GlobeKeyActionTests {
    /// Keyboard settings' "Press 🌐 key to", as the system holds it.
    @MainActor
    final class Setting {
        var value: Int32
        var updates: [Int32] = []
        init(_ value: Int32) { self.value = value }
        var system: GlobeKeyAction.System {
            GlobeKeyAction.System(read: { self.value }, update: {
                self.value = $0
                self.updates.append($0)
            })
        }
    }

    /// `AppleFnUsageType`'s Change Input Source, a choice other than Do Nothing.
    private let changeInputSource: Int32 = 1
    /// Show Emoji & Symbols, another.
    private let showEmoji: Int32 = 2
    private let defaults = InMemoryDefaults()

    @Test func fnAsTheHotkeyTurnsTheGlobeActionOffAndAnotherKeyPutsItBack() {
        let setting = Setting(changeInputSource)
        let globe = GlobeKeyAction(system: setting.system, defaults: defaults)

        globe.hotkeyIs(.function)
        #expect(setting.value == GlobeKeyAction.doNothing)
        globe.hotkeyIs(.function)
        #expect(setting.updates == [GlobeKeyAction.doNothing])

        globe.hotkeyIs(.rightOption)
        #expect(setting.value == changeInputSource)
        #expect(defaults.object(forKey: GlobeKeyAction.savedChoiceKey) == nil)
    }

    @Test func quittingPutsTheChoiceBack() {
        let setting = Setting(showEmoji)
        let globe = GlobeKeyAction(system: setting.system, defaults: defaults)

        globe.hotkeyIs(.function)
        globe.restore()

        #expect(setting.value == showEmoji)
        #expect(setting.updates == [GlobeKeyAction.doNothing, showEmoji])
    }

    /// Right Option as the hotkey, or a user who chose Do Nothing themselves: the setting is never touched.
    @Test(arguments: [(DictationHotkey.rightOption, Int32(1)), (.function, GlobeKeyAction.doNothing)])
    func leavesTheSettingAloneWhenThereIsNothingToTurnOff(hotkey: DictationHotkey, value: Int32) {
        let setting = Setting(value)
        let globe = GlobeKeyAction(system: setting.system, defaults: defaults)

        globe.hotkeyIs(hotkey)
        globe.hotkeyIs(.rightOption)
        globe.restore()

        #expect(setting.updates.isEmpty)
        #expect(setting.value == value)
    }

    /// The user picked another action in Keyboard settings while fn was the hotkey: theirs stays.
    @Test func aChoiceMadeMeanwhileIsKept() {
        let setting = Setting(changeInputSource)
        let globe = GlobeKeyAction(system: setting.system, defaults: defaults)

        globe.hotkeyIs(.function)
        setting.value = showEmoji
        globe.hotkeyIs(.rightOption)

        #expect(setting.value == showEmoji)
        #expect(defaults.object(forKey: GlobeKeyAction.savedChoiceKey) == nil)
    }

    /// A run that ended without quitting (a crash) left the setting at Do Nothing: the next launch
    /// puts the choice back if fn is no longer the hotkey, and keeps holding it if it is.
    @Test func theNextLaunchPutsRightARunThatCrashed() {
        let setting = Setting(changeInputSource)
        GlobeKeyAction(system: setting.system, defaults: defaults).hotkeyIs(.function)

        GlobeKeyAction(system: setting.system, defaults: defaults).hotkeyIs(.function)
        #expect(setting.value == GlobeKeyAction.doNothing)

        GlobeKeyAction(system: setting.system, defaults: defaults).hotkeyIs(.rightOption)
        #expect(setting.value == changeInputSource)
    }

    /// Between the crash and the next launch, with fn still the hotkey, the user picked another
    /// action: that is the choice to put back later.
    @Test func aChoiceMadeWhileTheAppWasNotRunningIsTheOneKept() {
        let setting = Setting(changeInputSource)
        GlobeKeyAction(system: setting.system, defaults: defaults).hotkeyIs(.function)
        setting.value = showEmoji

        let globe = GlobeKeyAction(system: setting.system, defaults: defaults)
        globe.hotkeyIs(.function)
        #expect(setting.value == GlobeKeyAction.doNothing)
        globe.restore()

        #expect(setting.value == showEmoji)
    }

    /// Without the system calls nothing is changed or saved.
    @Test func withoutTheSystemCallsNothingIsSaved() {
        let globe = GlobeKeyAction(system: nil, defaults: defaults)
        globe.hotkeyIs(.function)
        #expect(defaults.object(forKey: GlobeKeyAction.savedChoiceKey) == nil)
        globe.restore()
    }

    /// The calls exist on this macOS. Only read: the real setting is never changed by a test.
    @Test func theSystemCallsExist() throws {
        let system = try #require(GlobeKeyAction.System.live)
        #expect((0...3).contains(system.read()))
    }
}
