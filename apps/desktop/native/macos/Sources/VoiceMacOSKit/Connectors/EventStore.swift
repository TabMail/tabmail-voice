// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import EventKit
import Foundation
import VoiceHelperSupport

/// An event in the user's calendars, as the app's calendar tools read and create them.
struct CalendarEvent: Equatable, Sendable {
    var title: String
    var start: Date
    var end: Date
    var isAllDay: Bool
    var calendar: String
    var location: String?
    var notes: String?

    /// What the app receives: its times in milliseconds since 1970.
    var json: JSON {
        [
            "title": .string(title), "start": EventWire.json(start), "end": EventWire.json(end), "isAllDay": .bool(isAllDay),
            "calendar": .string(calendar), "location": location.map(JSON.string) ?? .null, "notes": notes.map(JSON.string) ?? .null,
        ]
    }
}

/// An open reminder, as the app's reminders tools read and create them.
struct ReminderItem: Equatable, Sendable {
    var title: String
    var list: String
    /// When it is due, and whether that names a time of day.
    var due: Date?
    var dueHasTime: Bool
    var notes: String?

    /// What the app receives: its due time in milliseconds since 1970.
    var json: JSON {
        [
            "title": .string(title), "list": .string(list), "due": due.map(EventWire.json) ?? .null,
            "dueHasTime": .bool(dueHasTime), "notes": notes.map(JSON.string) ?? .null,
        ]
    }

    /// Its due date as EventKit stores it: the day, and the time only when it names one, in this Mac's
    /// zone (the user's, as the app's).
    var dueDateComponents: DateComponents? {
        due.map { Self.dueCalendar.dateComponents(dueHasTime ? [.year, .month, .day, .hour, .minute] : [.year, .month, .day], from: $0) }
    }

    /// The calendar a due date's components are in: EventKit reads them as Gregorian, whatever calendar
    /// the Mac is set to (a Buddhist year is 543 years ahead), in this Mac's zone.
    static var dueCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }
}

/// Dates on the wire: milliseconds since 1970, as JavaScript's `Date` counts them.
enum EventWire {
    static func date(_ milliseconds: Double) -> Date { Date(timeIntervalSince1970: milliseconds / 1000) }
    static func json(_ date: Date) -> JSON { .number((date.timeIntervalSince1970 * 1000).rounded()) }
}

/// Apple Calendar and Reminders through EventKit, for the Answer tool's calendar and reminders tools
/// (ADR-DESK-024). Access is asked the first time a request needs it: macOS shows its prompt for
/// TabMail Voice, the app that started this helper, with the app's usage strings. Denied, a request
/// fails with a `Failure` the app turns into a message saying where to allow it.
@MainActor
final class EventKitStore {
    /// Why a request can't be carried out, sent as the error's message; the app knows each by name.
    enum Failure: String, Error {
        case calendarNoAccess
        case remindersNoAccess
        case noDefaultCalendar
        case noDefaultList

        var helperError: HelperError { HelperError(rawValue) }
    }

    private let store: EKEventStore
    private let status: (EKEntityType) -> EKAuthorizationStatus

    /// `store` and `status` are EventKit's own; a test gives stand-ins, never the user's calendars.
    init(store: EKEventStore = EKEventStore(), status: @escaping (EKEntityType) -> EKAuthorizationStatus = EKEventStore.authorizationStatus(for:)) {
        self.store = store
        self.status = status
    }

    /// The events overlapping `start` to `end`, oldest first.
    func events(from start: Date, to end: Date) async throws -> [CalendarEvent] {
        try await requireAccess(to: .event)
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        return store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.map(Self.calendarEvent)
    }

    /// Adds `event` to the default calendar and returns it as saved.
    func add(_ event: CalendarEvent) async throws -> CalendarEvent {
        try await requireAccess(to: .event)
        guard let calendar = store.defaultCalendarForNewEvents else { throw Failure.noDefaultCalendar.helperError }
        let saved = EKEvent(eventStore: store)
        saved.calendar = calendar
        Self.fill(saved, from: event)
        try store.save(saved, span: .thisEvent, commit: true)
        return Self.calendarEvent(saved)
    }

    /// Open reminders, due before `dueBefore` when given.
    func openReminders(dueBefore: Date?) async throws -> [ReminderItem] {
        try await requireAccess(to: .reminder)
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: dueBefore, calendars: nil)
        // Converted on EventKit's queue: its reminders are not Sendable.
        return await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { continuation.resume(returning: ($0 ?? []).map(Self.reminderItem)) }
        }
    }

    /// Adds `reminder` to the default list and returns it as saved.
    func add(_ reminder: ReminderItem) async throws -> ReminderItem {
        try await requireAccess(to: .reminder)
        guard let list = store.defaultCalendarForNewReminders() else { throw Failure.noDefaultList.helperError }
        let saved = EKReminder(eventStore: store)
        saved.calendar = list
        Self.fill(saved, from: reminder)
        try store.save(saved, commit: true)
        return Self.reminderItem(saved)
    }

    /// Asks for full access the first time; throws when the user has not allowed it.
    private func requireAccess(to type: EKEntityType) async throws {
        let denied = type == .event ? Failure.calendarNoAccess : Failure.remindersNoAccess
        switch status(type) {
        case .fullAccess:
            return
        case .notDetermined:
            // A request that fails is no access either: the user is told where to allow it.
            let granted = try? await type == .event ? store.requestFullAccessToEvents() : store.requestFullAccessToReminders()
            guard granted == true else { throw denied.helperError }
        default:
            throw denied.helperError
        }
    }

    /// `event`'s fields on `saved`, all day first: set after the dates, it moves an all-day event's
    /// end back to its start's day.
    static func fill(_ saved: EKEvent, from event: CalendarEvent) {
        saved.title = event.title
        saved.isAllDay = event.isAllDay
        saved.startDate = event.start
        saved.endDate = event.end
        saved.location = event.location
        saved.notes = event.notes
    }

    static func fill(_ saved: EKReminder, from reminder: ReminderItem) {
        saved.title = reminder.title
        saved.notes = reminder.notes
        saved.dueDateComponents = reminder.dueDateComponents
    }

    static func calendarEvent(_ event: EKEvent) -> CalendarEvent {
        CalendarEvent(
            title: event.title ?? "", start: event.startDate, end: event.endDate, isAllDay: event.isAllDay,
            calendar: event.calendar?.title ?? "", location: event.location, notes: event.notes
        )
    }

    nonisolated static func reminderItem(_ reminder: EKReminder) -> ReminderItem {
        let components = reminder.dueDateComponents
        return ReminderItem(
            title: reminder.title ?? "", list: reminder.calendar?.title ?? "",
            due: components.flatMap { ReminderItem.dueCalendar.date(from: $0) }, dueHasTime: components?.hour != nil, notes: reminder.notes
        )
    }
}
