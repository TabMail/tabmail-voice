// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Carbon.HIToolbox
import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceHotkeyKit

/// `HotkeyService` over its wire, with no event tap: a request the app sends reaches the monitor.
/// One test at a time: an app switch is posted to the shared workspace notification center, which every
/// open chat window's monitor hears.
@MainActor
@Suite(.serialized)
struct HotkeyServiceTests {
    final class Lines: Sendable {
        private let lines = OSAllocatedUnfairLock<[JSON]>(initialState: [])
        var all: [JSON] { lines.withLock { $0 } }
        func append(_ data: Data) {
            let value = try! JSONDecoder().decode(JSON.self, from: data)
            lines.withLock { $0.append(value) }
        }
    }

    private let rightOption = UInt16(kVK_RightOption)
    private let space = UInt16(kVK_Space)
    private let escape = UInt16(kVK_Escape)

    /// A dictation that ended without the hotkey (the length cap, a failure, the menu) ends hands-free
    /// listening: once the app says so, Space reaches the app in front again. The gesture's actions
    /// reach the app as events, in order, each named as the app reads it.
    @Test func dictationEndedEndsHandsFreeListening() async {
        let lines = Lines()
        let channel = HelperChannel(output: { lines.append($0) })
        let monitor = HotkeyService.register(on: channel)
        monitor.configure(PushToTalkGesture(hotkey: .rightOption, tapMaxDuration: tapMaxDuration, doubleTapWindow: doubleTapWindow))
        // A double tap: listening hands-free.
        for (down, time) in [(true, 0.0), (false, 0.05), (true, 0.1), (false, 0.15)] {
            _ = monitor.handle(.flagsChanged, keyCode: rightOption, flags: down ? .maskAlternate : [], isRepeat: false, at: time)
        }
        #expect(!monitor.handle(.keyDown, keyCode: space, flags: [], isRepeat: false, at: 0.2), "Space reached the app while listening hands-free")
        _ = monitor.handle(.keyUp, keyCode: space, flags: [], isRepeat: false, at: 0.25)
        // The actions are sent from the main queue, after the event tap returns.
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in DispatchQueue.main.async { done.resume() } }
        #expect(lines.all.compactMap { $0["action"]?.string } == ["start", "finish", "startHandsFree", "listenHandsFree", "toggleMode"])

        await channel.handle(line: Data(#"{"id":1,"method":"dictationEnded"}"#.utf8))

        #expect(lines.all.contains(["id": 1, "result": [:]]))
        #expect(monitor.handle(.keyDown, keyCode: space, flags: [], isRepeat: false, at: 0.3), "Space kept from the app after the dictation ended")
    }

    /// The app says when the chat window opens and closes: while it is open Escape is kept from the app
    /// and reaches it as `closeChat`; a request without `isOpen` fails and changes nothing.
    @Test func setChatOpenGivesEscapeToTheChatWindow() async {
        let lines = Lines()
        let channel = HelperChannel(output: { lines.append($0) })
        let monitor = HotkeyService.register(on: channel)
        monitor.configure(PushToTalkGesture(hotkey: .rightOption, tapMaxDuration: tapMaxDuration, doubleTapWindow: doubleTapWindow))

        await channel.handle(line: Data(#"{"id":1,"method":"setChatOpen","params":{}}"#.utf8))
        #expect(lines.all.contains { $0["id"] == 1 && $0["error"] != nil })
        #expect(monitor.handle(.keyDown, keyCode: escape, flags: [], isRepeat: false, at: 0.1), "Escape kept without the chat window open")

        await channel.handle(line: Data(#"{"id":2,"method":"setChatOpen","params":{"isOpen":true}}"#.utf8))
        #expect(lines.all.contains(["id": 2, "result": [:]]))
        #expect(!monitor.handle(.keyDown, keyCode: escape, flags: [], isRepeat: false, at: 0.2), "Escape reached the app with the chat window open")
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in DispatchQueue.main.async { done.resume() } }
        #expect(lines.all.compactMap { $0["action"]?.string } == ["closeChat"])

        await channel.handle(line: Data(#"{"id":3,"method":"setChatOpen","params":{"isOpen":false}}"#.utf8))
        #expect(monitor.handle(.keyDown, keyCode: escape, flags: [], isRepeat: false, at: 0.3), "Escape kept after the chat window closed")
    }

    /// While the chat window is open, a click and another app coming to the front reach the app as
    /// events, so it can close the chat window; before it opens and after it closes, neither does.
    @Test func clicksAndAppSwitchesAreToldOnlyWhileTheChatWindowIsOpen() async {
        let lines = Lines()
        let channel = HelperChannel(output: { lines.append($0) })
        let monitor = HotkeyService.register(on: channel)
        let events = { lines.all.compactMap { $0["event"]?.string }.filter { $0.hasPrefix("chat") } }
        let appSwitch = {
            NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didActivateApplicationNotification, object: nil)
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in DispatchQueue.main.async { done.resume() } }
        }

        monitor.mouseWentDown()
        await appSwitch()
        #expect(events().isEmpty, "told with the chat window closed")

        await channel.handle(line: Data(#"{"id":1,"method":"setChatOpen","params":{"isOpen":true}}"#.utf8))
        monitor.mouseWentDown()
        #expect(events().contains("chatMouseDown"))
        await appSwitch()
        #expect(events().contains("chatFocusChanged"))

        await channel.handle(line: Data(#"{"id":2,"method":"setChatOpen","params":{"isOpen":false}}"#.utf8))
        let told = events().count
        monitor.mouseWentDown()
        await appSwitch()
        #expect(events().count == told, "told after the chat window closed")
    }

    /// The clicks' tap hears each mouse button going down and nothing else; its callback passes the
    /// click on untouched, tells it once while the chat window is open, and tells nothing when macOS
    /// switches the tap off.
    @Test func theClickTapHearsButtonsGoingDownAndPassesThemOn() async throws {
        let downs: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        for type in downs { #expect(chatTapMask & (CGEventMask(1) << type.rawValue) != 0, "\(type.rawValue) not heard") }
        let others: [CGEventType] = [.leftMouseUp, .rightMouseUp, .otherMouseUp, .mouseMoved, .leftMouseDragged, .scrollWheel, .keyDown]
        for type in others { #expect(chatTapMask & (CGEventMask(1) << type.rawValue) == 0, "\(type.rawValue) heard") }

        let lines = Lines()
        let channel = HelperChannel(output: { lines.append($0) })
        let monitor = HotkeyService.register(on: channel)
        let events = { lines.all.compactMap { $0["event"]?.string }.filter { $0.hasPrefix("chat") } }
        await channel.handle(line: Data(#"{"id":1,"method":"setChatOpen","params":{"isOpen":true}}"#.utf8))
        defer { monitor.setChatOpen(false) }
        // Made, never posted: nothing reaches the desktop.
        let click = try #require(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: .zero, mouseButton: .left))
        let proxy = try #require(OpaquePointer(bitPattern: 1))
        let userInfo = Unmanaged.passUnretained(monitor).toOpaque()

        let passed = chatTapCallback(proxy: proxy, type: .leftMouseDown, event: click, userInfo: userInfo)
        #expect(passed?.takeUnretainedValue() === click, "the click not passed on")
        #expect(events() == ["chatMouseDown"])
        _ = chatTapCallback(proxy: proxy, type: .tapDisabledByTimeout, event: click, userInfo: userInfo)
        _ = chatTapCallback(proxy: proxy, type: .tapDisabledByUserInput, event: click, userInfo: userInfo)
        #expect(events() == ["chatMouseDown"], "a switched-off tap told as a click")
    }

    /// Closed and opened again, the chat window hears each app switch once: closing it stops watching.
    @Test func reopeningTheChatWindowTellsEachAppSwitchOnce() async {
        let lines = Lines()
        let channel = HelperChannel(output: { lines.append($0) })
        let monitor = HotkeyService.register(on: channel)
        defer { monitor.setChatOpen(false) }
        let switches = { lines.all.compactMap { $0["event"]?.string }.filter { $0 == "chatFocusChanged" }.count }
        let appSwitch = {
            NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didActivateApplicationNotification, object: nil)
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in DispatchQueue.main.async { done.resume() } }
        }
        for id in 1...3 {
            await channel.handle(line: Data(#"{"id":\#(2 * id),"method":"setChatOpen","params":{"isOpen":true}}"#.utf8))
            await channel.handle(line: Data(#"{"id":\#(2 * id + 1),"method":"setChatOpen","params":{"isOpen":false}}"#.utf8))
        }
        await channel.handle(line: Data(#"{"id":9,"method":"setChatOpen","params":{"isOpen":true}}"#.utf8))
        await appSwitch()
        #expect(switches() == 1, "\(switches()) switches told")
    }
}
