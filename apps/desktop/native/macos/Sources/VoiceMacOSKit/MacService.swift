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
/// The screen read (`readScreen`) is not here: `voice-screen-reader`, a program of its own, serves
/// it (`ScreenReaderService`); nor is the field read for correction learning (`focusedFieldValue`),
/// which `voice-field-reader` serves (`FieldReaderService`).
/// - `caretAnchor {pid}` → the caret's (or the focused field's) rect, or null.
/// - `clipboardSave` → `{}`: saves the clipboard in the background, for the next paste to put back
///   (`ClipboardKeeper`); the app asks as a dictation starts and as it ends.
/// - `insert {text}` → `{}`: pastes `text` into the focused field once the shared core accepts it,
///   answering once the paste keys are sent; the clipboard as saved goes back after them.
/// - `keyboardLanguage` → `{code}`: the active input source's raw locale, or null; the app normalizes it.
/// - `fullUserName` → `{name}`: the user account's full name, empty when it has none.
/// - `globeRead` → `{value}` (null when this macOS lacks the calls); `globeUpdate {value}` → `{}`.
/// - `startActivator` → `{}`: asks Gecko and Electron apps to build their accessibility tree as they
///   come to the front. Again after the Accessibility grant.
/// - `emailApps {bundleIdentifiers}` → `{systemDefault, installed}`.
/// - `appIcon {path, pixels}` → `{png}`: the app's icon, `pixels` square, as base64 PNG; null when
///   it can't be drawn.
/// - `appInfo {path}` → `{bundleIdentifier, name, path}` of the app at `path`, or null when it is none.
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
public enum MacService {
    @MainActor
    public static func register(on channel: HelperChannel) -> AnyObject {
        register(on: channel, eventStore: EventKitStore(), contactStore: ContactsFrameworkStore())
    }

    /// `eventStore` and `contactStore` are the user's calendars and contacts, `fileSearch` Spotlight,
    /// `fileOpener` the Finder, `clipboard` the pasteboard (one `ClipboardKeeper` for the save and the
    /// paste) and `pasteKeystroke` ⌘V, or a test's stand-ins.
    @MainActor
    static func register(
        on channel: HelperChannel, eventStore: EventKitStore, contactStore: ContactsFrameworkStore,
        fileSearch: @escaping @Sendable (SpotlightQuery, Int) async throws -> [FoundItem] = Files.search, fileOpener: FileOpener = .workspace,
        clipboard: ClipboardKeeper? = nil,
        pasteKeystroke: @escaping @MainActor @Sendable () async -> Void = TextInserter.postCommandV
    ) -> AnyObject {
        let activator = AccessibilityActivator()
        let clipboard = clipboard ?? ClipboardKeeper()
        let paste: @MainActor @Sendable (String) async -> Void = { await TextInserter(clipboard: clipboard, pasteKeystroke: pasteKeystroke).insert($0) }
        channel.on("frontmostApp") { _ in await MainActor.run { Apps.frontmost() } }
        channel.on("redactText") { params in
            let result = try Redactor.request(JSONEncoder().encode(params), operation: .text)
            return try JSONDecoder().decode(JSON.self, from: result)
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
        channel.on("clipboardSave") { _ in
            await clipboard.save()
            return [:]
        }
        channel.on("insert") { params in
            guard let text = params["text"]?.string else { throw HelperError("insert needs text") }
            try SharedRequest.insert(text)
            await paste(text)
            return [:]
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
        channel.on("appInfo") { params in
            guard let path = params["path"]?.string else { throw HelperError("appInfo needs path") }
            return Apps.app(at: URL(fileURLWithPath: path))?.json ?? .null
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
        channel.on("pressReturn") { _ in
            await Apps.postReturn()
            return [:]
        }
        return [activator, eventStore, contactStore] as NSArray
    }

    private static func bundleIdentifier(_ params: JSON) throws -> String {
        guard let id = params["bundleIdentifier"]?.string else { throw HelperError("bundleIdentifier missing") }
        return id
    }
}

/// What `readScreen` and `focusedFieldValue` read of other apps: through Accessibility, or a test's
/// stand-ins that read nothing.
struct ScreenAccess: Sendable {
    /// The app in front: its process, name and bundle identifier.
    var frontmost: @MainActor @Sendable () -> (pid_t, String, String?)?
    /// The bundle identifier of the app `pid`.
    var bundleIdentifier: @Sendable (pid_t) -> String?
    /// The screen context of the app, as read; none when an excluded website is showing.
    var read: @Sendable (pid_t, String, String?, ScreenExclusions) -> ScreenContext?
    /// The app's focused field (`FocusedField`): its text, or a terminal's viewport; none in an
    /// excluded website.
    var focusedField: @Sendable (pid_t, ScreenExclusions) -> FocusedField.Read?

    static let accessibility = ScreenAccess(
        frontmost: { NSWorkspace.shared.frontmostApplication.map { ($0.processIdentifier, $0.localizedName ?? "", $0.bundleIdentifier) } },
        bundleIdentifier: { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier },
        read: { ScreenContextReader.read(pid: $0, appName: $1, bundleID: $2, excluding: $3) },
        focusedField: { FocusedField.read(inApp: $0, bundleID: NSRunningApplication(processIdentifier: $0)?.bundleIdentifier, excluding: $1) }
    )
}

extension ScreenContext {
    /// What the app receives, built by the shared core (`voice_core_screen_json`, ADR-DESK-054): the
    /// fields, the text redacted and rendered for the prompts and the logs, the summary and the log
    /// description; `{hidden: true}` when the page read is on an excluded website, or the core refuses.
    func json(_ exclusions: ScreenExclusions) -> JSON {
        struct Request: Encodable {
            var appName: String
            var bundleID, windowTitle, host, terminalProgram, focusedRole: String?
            var exclusions: [String: [String]]
            var nodes, milliseconds: Int
            var stopped: String?
            var blocks: [SharedContext.Block]?
            var caret: [String]?
            var selectionUnavailable: Bool?
            var viewport: JSON?
        }
        guard !coreFailed else { return ["hidden": .bool(true)] }
        // The read is timed on the wall clock; one set back during the read must not hide it.
        var request = Request(appName: appName, bundleID: bundleID, windowTitle: windowTitle, host: host,
                              terminalProgram: terminalProgram, focusedRole: focusedRole,
                              exclusions: ["excludedAppIDs": exclusions.appIDs, "excludedHosts": exclusions.hosts],
                              nodes: nodesVisited, milliseconds: Int(max(0, seconds) * 1000), stopped: stoppedEarly)
        if let terminalSource {
            request.viewport = terminalSource
        } else {
            request.blocks = blocks.map(SharedContext.Block.init)
            request.caret = [textBeforeCaret, selectedText, textAfterCaret]
            request.selectionUnavailable = selectionUnavailable
        }
        do {
            return try JSONDecoder().decode(JSON.self, from: Redactor.request(JSONEncoder().encode(request), operation: .screen))
        } catch { return ["hidden": .bool(true)] }
    }
}
