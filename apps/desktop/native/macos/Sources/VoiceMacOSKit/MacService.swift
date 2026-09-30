// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import ApplicationServices
import VoiceHelperSupport

/// `voice-macos`'s requests, over `HelperChannel`. Rects are in screen points with the origin at the
/// primary screen's top-left and y down: Accessibility's coordinates and Electron's alike.
///
/// - `frontmostApp` → `{pid, name, bundleIdentifier, path}` or null.
/// - `readScreen` → the screen context of the app in front (`ScreenContext.json`), or null without one.
/// - `caretAnchor {pid}` → the caret's (or the focused field's) rect, or null.
/// - `focusedFieldValue {pid, maxLength}` → `{value}`: the text of the app's focused field, null for
///   none, a password field, or one longer than `maxLength` UTF-16 code units (`FocusedField`).
/// - `captureTarget {session}` → `{captured}`: keeps the frontmost app's focused field and its caret
///   for the dictation `session` (`InsertionTarget`), replacing any other's; `captured` is whether a
///   field was found.
/// - `insert {text, restoreDelay, session?}` → `{outcome}`: pastes `text` into the focused field, then
///   restores the clipboard after `restoreDelay` seconds; `outcome` is `pasted`. With `session`, first
///   puts back that dictation's field and caret, and pastes nothing if it can't: `outcome` is then
///   `appChanged` or `caretMoved` (ADR-DESK-042).
/// - `keyboardLanguage` → `{code}`: the active keyboard input source's language, or null.
/// - `fullUserName` → `{name}`: the user account's full name, empty when it has none.
/// - `globeRead` → `{value}` (null when this macOS lacks the calls); `globeUpdate {value}` → `{}`.
/// - `startActivator` → `{}`: asks Gecko and Electron apps to build their accessibility tree as they
///   come to the front. Again after the Accessibility grant.
/// - `emailApps {bundleIdentifiers}` → `{systemDefault, installed}`.
/// - `appIcon {path, pixels}` → `{png}`: the app's icon, `pixels` square, as base64 PNG; null when
///   it can't be drawn.
/// - `appPath {bundleIdentifier}` → `{path}`; `isRunning`, `hasWindow`, `isFrontmost` → `{value}`;
///   `launch {path}`, `activate {bundleIdentifier}` → `{}`; `focusedElement {bundleIdentifier}` →
///   `{role, windowTitle}` or null; `openTabMailChat`, `pressReturn` → `{}`.
/// - `calendarEvents {start, end}` → `{events}`: the events overlapping the range, oldest first;
///   `calendarAdd {title, start, end, isAllDay, location, notes}` → the event as saved in the default
///   calendar; `reminders {dueBefore}` → `{reminders}`: the open ones, due before `dueBefore` unless
///   null; `reminderAdd {title, due, dueHasTime, notes}` → the reminder as saved in the default list.
///   Times are milliseconds since 1970 (`EventWire`); the first request asks macOS for access, and one
///   that can't be carried out fails with an `EventKitStore.Failure` name.
/// - `contactsSearch {query, limit}` → `{contacts}`: at most `limit` contacts the query matches
///   (`ContactMatch`), in the user's sort order; `contactsAdd {firstName, lastName, organization,
///   emails, phones}` → the contact as saved in the default container. The first request asks macOS
///   for access, and one without it fails with `ContactsFrameworkStore.Failure.contactsNoAccess`.
/// - `filesSearch {words, kind, changedAfter, changedBefore, limit}` → `{items}`: at most `limit`
///   items in the home folder Spotlight finds (`SpotlightQuery`), newest first, the dates in
///   milliseconds or null; `fileOpen {path, reveal}` → `{opened}`: the item opened in its usual app,
///   or shown in the Finder (with `reveal`, or when `OpenPolicy` says it can run something). A
///   failure is a `Files.Failure` name.
/// - `microphonePrepare` → `{}`: the microphone-off setup, ahead of the first dictation.
/// - `microphoneStart {session, sampleRate}` → `{}` once the microphone runs; then events
///   `{"event": "microphoneChunk", session, samples}`, `samples` being base64 of little-endian
///   32-bit float mono samples at `sampleRate`, and `{"event": "microphoneLost", session}` should the
///   microphone stop by itself. `microphoneStop {session}` → `{}`: the microphone off.
public enum MacService {
    static let microphoneChunkEvent = "microphoneChunk"
    static let microphoneLostEvent = "microphoneLost"
    /// `insert`'s outcome when it pasted.
    static let pastedOutcome = "pasted"

    /// A chunk event's fields: its session, and its samples as base64 of little-endian 32-bit floats.
    static func microphoneChunk(session: Int, samples: [Float]) -> [String: JSON] {
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        return ["session": .number(Double(session)), "samples": .string(data.base64EncodedString())]
    }

    /// A lost event's fields: the session whose microphone stopped by itself.
    static func microphoneLost(session: Int) -> [String: JSON] {
        ["session": .number(Double(session))]
    }

    @MainActor
    public static func register(on channel: HelperChannel) -> AnyObject {
        register(on: channel, eventStore: EventKitStore(), contactStore: ContactsFrameworkStore())
    }

    /// `eventStore` and `contactStore` are the user's calendars and contacts, `fileSearch` Spotlight
    /// and `fileOpener` the Finder, or a test's stand-ins.
    @MainActor
    static func register(
        on channel: HelperChannel, eventStore: EventKitStore, contactStore: ContactsFrameworkStore,
        fileSearch: @escaping @Sendable (SpotlightQuery, Int) async throws -> [FoundItem] = Files.search, fileOpener: FileOpener = .workspace
    ) -> AnyObject {
        let activator = AccessibilityActivator()
        let targets = InsertionTargets()
        // Off the render thread: encoding and writing a chunk must never hold up the audio.
        let chunkQueue = DispatchQueue(label: "ai.tabmail.voice.helper.microphoneChunks", qos: .userInitiated)
        let microphone = MicrophoneCapture(
            onSamples: { session, samples in
                chunkQueue.async {
                    channel.emit(microphoneChunkEvent, microphoneChunk(session: session, samples: samples))
                }
            },
            // After the chunks already queued, so the app has all that was heard.
            onLost: { session in
                chunkQueue.async {
                    channel.emit(microphoneLostEvent, microphoneLost(session: session))
                }
            }
        )

        channel.on("frontmostApp") { _ in await MainActor.run { Apps.frontmost() } }
        channel.on("readScreen") { _ in
            let target: (pid_t, String, String?)? = await MainActor.run {
                NSWorkspace.shared.frontmostApplication.map { ($0.processIdentifier, $0.localizedName ?? "", $0.bundleIdentifier) }
            }
            guard let (pid, name, bundleID) = target else { return .null }
            // Blocking Accessibility calls: off the main thread, where the activator's notifications run.
            return await Task.detached { ScreenContextReader.read(pid: pid, appName: name, bundleID: bundleID).json }.value
        }
        channel.on("caretAnchor") { params in
            guard let pid = params["pid"]?.integer.flatMap({ pid_t(exactly: $0) }) else { throw HelperError("caretAnchor needs pid") }
            return await Task.detached { () -> JSON in
                guard let cocoa = CaretLocator.anchorRect(inApp: pid),
                      let primaryHeight = NSScreen.screens.first?.frame.height else { return .null }
                // The flip is its own inverse: back to Accessibility's top-left coordinates.
                return .rect(CaretLocator.cocoaRect(fromAccessibility: cocoa, primaryScreenHeight: primaryHeight))
            }.value
        }
        channel.on("focusedFieldValue") { params in
            guard let pid = params["pid"]?.integer.flatMap({ pid_t(exactly: $0) }),
                  let maxLength = params["maxLength"]?.integer, maxLength >= 0 else {
                throw HelperError("focusedFieldValue needs pid and maxLength")
            }
            return await Task.detached { ["value": FocusedField.value(inApp: pid, maxLength: maxLength).map(JSON.string) ?? .null] }.value
        }
        channel.on("captureTarget") { params in
            guard let session = params["session"]?.integer else { throw HelperError("captureTarget needs session") }
            guard let pid = await MainActor.run(body: { NSWorkspace.shared.frontmostApplication?.processIdentifier }) else {
                return ["captured": .bool(false)]
            }
            // Blocking Accessibility calls: off the main thread.
            let captured = await Task.detached {
                InsertionTargets.Captured(target: .capture(inApp: pid, access: AXTextFieldAccess()))
            }.value
            await MainActor.run { targets.keep(captured, session: session) }
            HelperLog.debug("captureTarget: app \(pid), field \(captured.target.element != nil), caret \(captured.target.selection != nil)")
            return ["captured": .bool(captured.target.element != nil)]
        }
        channel.on("insert") { params in
            guard let text = params["text"]?.string, let delay = params["restoreDelay"]?.number,
                  let milliseconds = Int(exactly: (delay * 1000).rounded()), milliseconds >= 0 else {
                throw HelperError("insert needs text and restoreDelay")
            }
            if let session = params["session"]?.integer {
                let outcome = await restoreTarget(targets, session: session)
                guard outcome == .inPlace else { return ["outcome": .string(outcome.rawValue)] }
            }
            await TextInserter(restoreDelay: .milliseconds(milliseconds)).insert(text)
            return ["outcome": .string(pastedOutcome)]
        }
        channel.on("keyboardLanguage") { _ in
            await MainActor.run { ["code": KeyboardLanguage.current().map(JSON.string) ?? .null] }
        }
        channel.on("fullUserName") { _ in
            ["name": .string(NSFullUserName())]
        }
        channel.on("globeRead") { _ in
            ["value": GlobeKey.live.map { .number(Double($0.read())) } ?? .null]
        }
        channel.on("globeUpdate") { params in
            guard let value = params["value"]?.integer.flatMap({ Int32(exactly: $0) }) else { throw HelperError("globeUpdate needs value") }
            guard let globe = GlobeKey.live else { throw HelperError("TISUpdateFnUsageType unavailable") }
            globe.update(value)
            return [:]
        }
        channel.on("startActivator") { _ in
            await MainActor.run { activator.start() }
            return [:]
        }
        channel.on("emailApps") { params in
            let ids = params["bundleIdentifiers"]?.array?.compactMap(\.string) ?? []
            return await MainActor.run {
                [
                    "systemDefault": Apps.systemEmailApp()?.json ?? .null,
                    "installed": .array(Apps.installed(ids).map(\.json)),
                ]
            }
        }
        channel.on("appIcon") { params in
            guard let path = params["path"]?.string, let pixels = params["pixels"]?.number,
                  pixels == pixels.rounded(), (1...HelperConfig.appIconMaxPixels).contains(pixels) else {
                throw HelperError("appIcon needs path and a whole number of pixels")
            }
            return await MainActor.run { ["png": Apps.iconPNG(path, pixels: Int(pixels)).map { .string($0.base64EncodedString()) } ?? .null] }
        }
        channel.on("appPath") { params in
            let id = try bundleIdentifier(params)
            return await MainActor.run { ["path": NSWorkspace.shared.urlForApplication(withBundleIdentifier: id).map { .string($0.path) } ?? .null] }
        }
        channel.on("isRunning") { params in ["value": .bool(Apps.running(try bundleIdentifier(params)) != nil)] }
        channel.on("launch") { params in
            guard let path = params["path"]?.string else { throw HelperError("launch needs path") }
            try await Apps.launch(path)
            return [:]
        }
        channel.on("hasWindow") { params in ["value": .bool(await Apps.hasWindow(try bundleIdentifier(params)))] }
        channel.on("activate") { params in
            await Apps.activate(try bundleIdentifier(params))
            return [:]
        }
        channel.on("isFrontmost") { params in
            let id = try bundleIdentifier(params)
            return await MainActor.run { ["value": .bool(Apps.isFrontmost(id))] }
        }
        channel.on("focusedElement") { params in await Apps.focusedElement(try bundleIdentifier(params)) }
        channel.on("openTabMailChat") { _ in
            await Apps.postOpenChat()
            return [:]
        }
        channel.on("calendarEvents") { params in
            guard let start = params["start"]?.number, let end = params["end"]?.number else { throw HelperError("calendarEvents needs start and end") }
            return ["events": .array(try await eventStore.events(from: EventWire.date(start), to: EventWire.date(end)).map(\.json))]
        }
        channel.on("calendarAdd") { params in
            guard let title = params["title"]?.string, let start = params["start"]?.number, let end = params["end"]?.number,
                  let isAllDay = params["isAllDay"]?.bool else {
                throw HelperError("calendarAdd needs title, start, end and isAllDay")
            }
            let event = CalendarEvent(
                title: title, start: EventWire.date(start), end: EventWire.date(end), isAllDay: isAllDay,
                calendar: "", location: params["location"]?.string, notes: params["notes"]?.string
            )
            return try await eventStore.add(event).json
        }
        channel.on("reminders") { params in
            let dueBefore = params["dueBefore"]?.number.map(EventWire.date)
            return ["reminders": .array(try await eventStore.openReminders(dueBefore: dueBefore).map(\.json))]
        }
        channel.on("reminderAdd") { params in
            guard let title = params["title"]?.string, let dueHasTime = params["dueHasTime"]?.bool else { throw HelperError("reminderAdd needs title and dueHasTime") }
            let reminder = ReminderItem(title: title, list: "", due: params["due"]?.number.map(EventWire.date), dueHasTime: dueHasTime, notes: params["notes"]?.string)
            return try await eventStore.add(reminder).json
        }
        channel.on("contactsSearch") { params in
            guard let query = params["query"]?.string, let limit = params["limit"]?.integer, limit > 0 else {
                throw HelperError("contactsSearch needs query and a positive limit")
            }
            return ["contacts": .array(try await contactStore.search(query, limit: limit).map(\.json))]
        }
        channel.on("contactsAdd") { params in
            guard let firstName = params["firstName"]?.string, let lastName = params["lastName"]?.string,
                  let organization = params["organization"]?.string,
                  let emails = params["emails"]?.array?.compactMap(\.string), let phones = params["phones"]?.array?.compactMap(\.string)
            else {
                throw HelperError("contactsAdd needs firstName, lastName, organization, emails and phones")
            }
            let contact = ContactCard(firstName: firstName, lastName: lastName, organization: organization, emails: emails, phones: phones)
            return try await contactStore.add(contact).json
        }
        channel.on("filesSearch") { params in
            guard let words = params["words"]?.array?.compactMap(\.string), let rawKind = params["kind"]?.string,
                  let kind = SpotlightQuery.Kind(rawValue: rawKind), let limit = params["limit"]?.integer, limit > 0
            else {
                throw HelperError("filesSearch needs words, a known kind and a positive limit")
            }
            let query = SpotlightQuery(
                words: words, kind: kind,
                changedAfter: params["changedAfter"]?.number.map(EventWire.date), changedBefore: params["changedBefore"]?.number.map(EventWire.date)
            )
            return ["items": .array(try await fileSearch(query, limit).map(\.json))]
        }
        channel.on("fileOpen") { params in
            guard let path = params["path"]?.string, path.hasPrefix("/"), let reveal = params["reveal"]?.bool else {
                throw HelperError("fileOpen needs an absolute path and reveal")
            }
            return ["opened": .bool(try await Files.open(path, reveal: reveal, opener: fileOpener))]
        }
        channel.on("microphonePrepare") { _ in
            await microphone.prepare()
            return [:]
        }
        channel.on("microphoneStart") { params in
            guard let session = params["session"]?.integer, let sampleRate = params["sampleRate"]?.number, sampleRate > 0 else {
                throw HelperError("microphoneStart needs session and sampleRate")
            }
            do {
                try await microphone.start(session: session, sampleRate: sampleRate)
            } catch {
                throw HelperError("microphone: \(type(of: error))")
            }
            return [:]
        }
        channel.on("microphoneStop") { params in
            guard let session = params["session"]?.integer else { throw HelperError("microphoneStop needs session") }
            await microphone.stop(session: session)
            return [:]
        }
        channel.on("pressReturn") { _ in
            await Apps.postReturn()
            return [:]
        }
        return [activator, microphone, eventStore, contactStore] as NSArray
    }

    /// Puts back the field and caret captured for `session`, with the app in front now.
    private static func restoreTarget(_ targets: InsertionTargets, session: Int) async -> InsertionOutcome {
        let (captured, frontmost) = await MainActor.run {
            (targets.target(session: session), NSWorkspace.shared.frontmostApplication?.processIdentifier)
        }
        guard let captured else {
            HelperLog.debug("insert: no target captured for session \(session)")
            return .caretMoved
        }
        // Blocking Accessibility calls: off the main thread.
        return await Task.detached { captured.target.restore(frontmost: frontmost, access: AXTextFieldAccess()) }.value
    }

    private static func bundleIdentifier(_ params: JSON) throws -> String {
        guard let id = params["bundleIdentifier"]?.string else { throw HelperError("bundleIdentifier missing") }
        return id
    }
}

extension ScreenContext {
    /// What the app receives: the fields, and the text already rendered for the prompts and the logs.
    var json: JSON {
        func optional(_ value: String?) -> JSON { value.map(JSON.string) ?? .null }
        return [
            "appName": .string(appName),
            "bundleID": optional(bundleID),
            "windowTitle": optional(windowTitle),
            "host": optional(host),
            "terminalProgram": optional(terminalProgram),
            "focusedRole": optional(focusedRole),
            "textBeforeCaret": .string(textBeforeCaret),
            "selectedText": .string(selectedText),
            "textAfterCaret": .string(textAfterCaret),
            "renderedText": .string(renderedText()),
            "summary": .string(summary),
            "logDescription": .string(logDescription),
        ]
    }
}
