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
/// it (`ScreenReaderService`).
/// - `caretAnchor {pid}` → the caret's (or the focused field's) rect, or null.
/// - `focusedFieldValue {pid, maxLength, excludedAppIDs, excludedHosts}` → `{value}`: the text of
///   the app's focused field, null for none, a password field, one longer than `maxLength` UTF-16
///   code units (`FocusedField`), or one in an app or on a website the user excludes from screen
///   reading, which is not read. Secret-looking text is taken out of it (`Redactor`).
/// - `insert {text, restoreDelay}` → `{}`: pastes `text` into the focused field, then restores the
///   clipboard after `restoreDelay` seconds.
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

    /// `eventStore` and `contactStore` are the user's calendars and contacts, `fileSearch` Spotlight
    /// and `fileOpener` the Finder, or a test's stand-ins.
    @MainActor
    static func register(
        on channel: HelperChannel, eventStore: EventKitStore, contactStore: ContactsFrameworkStore,
        fileSearch: @escaping @Sendable (SpotlightQuery, Int) async throws -> [FoundItem] = Files.search, fileOpener: FileOpener = .workspace,
        screen: ScreenAccess = .accessibility
    ) -> AnyObject {
        let activator = AccessibilityActivator()
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
        channel.on("focusedFieldValue") { params in
            guard let pid = params["pid"]?.integer.flatMap({ pid_t(exactly: $0) }),
                  let maxLength = params["maxLength"]?.integer, maxLength >= 0 else {
                throw HelperError("focusedFieldValue needs pid and maxLength")
            }
            let exclusions = try ScreenExclusions(params: params, method: "focusedFieldValue")
            if exclusions.excludesApp(screen.bundleIdentifier(pid)) {
                HelperLog.debug("FocusedField: the app is excluded from screen reading; not read")
                return ["value": .null]
            }
            return await Task.detached { ["value": screen.focusedField(pid, maxLength, exclusions).flatMap { try? Redactor.redact($0) }.map(JSON.string) ?? .null] }.value
        }
        channel.on("insert") { params in
            guard let text = params["text"]?.string, let delay = params["restoreDelay"]?.number,
                  let milliseconds = Int(exactly: (delay * 1000).rounded()), milliseconds >= 0 else {
                throw HelperError("insert needs text and restoreDelay")
            }
            await TextInserter(restoreDelay: .milliseconds(milliseconds)).insert(text)
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
    /// The text of the app's focused field, up to a length (`FocusedField`); none in an excluded website.
    var focusedField: @Sendable (pid_t, Int, ScreenExclusions) -> String?

    static let accessibility = ScreenAccess(
        frontmost: { NSWorkspace.shared.frontmostApplication.map { ($0.processIdentifier, $0.localizedName ?? "", $0.bundleIdentifier) } },
        bundleIdentifier: { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier },
        read: { ScreenContextReader.read(pid: $0, appName: $1, bundleID: $2, excluding: $3) },
        focusedField: { FocusedField.value(inApp: $0, maxLength: $1, excluding: $2) }
    )
}

extension ScreenContext {
    /// What the app receives: the fields, and the text already rendered for the prompts and the logs,
    /// all of it with secret-looking text taken out (`redacted`: ADR-DESK-046).
    var json: JSON {
        guard let context = try? redacted else { return ["hidden": .bool(true)] }
        return (try? context.json(selectionRedacted: selectionUnavailable || context.selectedText != selectedText)) ?? ["hidden": .bool(true)]
    }

    private func json(selectionRedacted: Bool) throws -> JSON {
        func optional(_ value: String?) -> JSON { value.map(JSON.string) ?? .null }
        var fields: [String: JSON] = [
            "appName": .string(appName),
            "bundleID": optional(bundleID),
            "windowTitle": optional(windowTitle),
            "host": optional(host),
            "terminalProgram": optional(terminalProgram),
            "focusedRole": optional(focusedRole),
            "textBeforeCaret": .string(textBeforeCaret),
            "selectedText": .string(selectedText),
            // The selection as sent is not the user's text: the app must not paste a rewrite of it
            // over the real one.
            "selectionRedacted": .bool(selectionRedacted),
            "textAfterCaret": .string(textAfterCaret),
            "renderedText": .string(try renderedText()),
            "summary": .string(summary),
            "logDescription": .string(try logDescription),
        ]
        if let terminalViewport { fields["terminalViewport"] = terminalViewport }
        return .object(fields)
    }
}
