// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import EventKit
import Foundation
import VoiceHelperSupport

/// An event in the user's calendars, as the app's calendar tools read, create and change them. An
/// occurrence of a repeating event carries the series' `id` and its own `occurrence` start, the
/// pair that names it to `EventKitStore.event(id:occurrence:)`.
struct CalendarEvent: Equatable, Sendable {
    var title: String
    var start: Date
    var end: Date
    var isAllDay: Bool
    var calendar: String
    var location: String?
    var notes: String?
    var id: String? = nil
    var occurrence: Date? = nil
    var calendarId: String? = nil
    /// "busy" or "free".
    var availability: String = "busy"
    var attendees: [EventAttendee] = []
    var organizer: EventAttendee? = nil
    var recurrence: EventRecurrence? = nil
    /// An occurrence of a repeating event changed on its own.
    var isDetached: Bool = false
    /// The user was invited to it by someone else, who organizes it.
    var isInvitation: Bool = false
    /// The zone its times, and its rule's days, are counted in; nil for one that floats (all day).
    var timeZone: String? = nil

    /// What the app receives: its times in milliseconds since 1970.
    var json: JSON {
        [
            "title": .string(title), "start": EventWire.json(start), "end": EventWire.json(end), "isAllDay": .bool(isAllDay),
            "calendar": .string(calendar), "location": location.map(JSON.string) ?? .null, "notes": notes.map(JSON.string) ?? .null,
            "id": id.map(JSON.string) ?? .null, "occurrence": occurrence.map(EventWire.json) ?? .null,
            "calendarId": calendarId.map(JSON.string) ?? .null, "availability": .string(availability),
            "attendees": .array(attendees.map(\.json)), "organizer": organizer?.json ?? .null,
            "recurrence": recurrence?.json ?? .null, "isDetached": .bool(isDetached), "isInvitation": .bool(isInvitation),
            "timeZone": timeZone.map(JSON.string) ?? .null,
        ]
    }
}

/// Someone invited to an event, or its organizer.
struct EventAttendee: Equatable, Sendable {
    var email: String
    var name: String?
    /// "accepted", "declined", "tentative", "pending" or "unknown".
    var status: String = "unknown"

    var json: JSON { ["email": .string(email), "name": name.map(JSON.string) ?? .null, "status": .string(status)] }
}

/// How an event repeats, as `EKRecurrenceRule` keeps it: the app turns the model's RRULE fields into
/// these and back (weekdays numbered 1, Sunday, to 7; `week` 0 for every week, else which one).
struct EventRecurrence: Equatable, Sendable {
    struct Day: Equatable, Sendable {
        var weekday: Int
        var week: Int
    }

    /// "DAILY", "WEEKLY", "MONTHLY" or "YEARLY".
    var frequency: String
    var interval: Int
    var count: Int?
    var until: Date?
    var days: [Day] = []
    var monthDays: [Int] = []
    var months: [Int] = []
    /// Which of the occurrences the rest selects in each period (-1 the last): "the last weekday" is
    /// Monday to Friday at -1.
    var positions: [Int] = []
    var yearWeeks: [Int] = []
    var yearDays: [Int] = []

    static let frequencies: [String: EKRecurrenceFrequency] = ["DAILY": .daily, "WEEKLY": .weekly, "MONTHLY": .monthly, "YEARLY": .yearly]

    var json: JSON {
        [
            "frequency": .string(frequency), "interval": .number(Double(interval)), "count": count.map { .number(Double($0)) } ?? .null,
            "until": until.map(EventWire.json) ?? .null,
            "days": .array(days.map { ["weekday": .number(Double($0.weekday)), "week": .number(Double($0.week))] }),
            "monthDays": .array(monthDays.map { .number(Double($0)) }), "months": .array(months.map { .number(Double($0)) }),
            "positions": .array(positions.map { .number(Double($0)) }), "yearWeeks": .array(yearWeeks.map { .number(Double($0)) }),
            "yearDays": .array(yearDays.map { .number(Double($0)) }),
        ]
    }

    /// The fields the app sent; nil for anything malformed (the app checks them first).
    init?(json: JSON) {
        guard let frequency = json["frequency"]?.string, Self.frequencies[frequency] != nil, let interval = json["interval"]?.integer, interval > 0 else { return nil }
        // A field sent that doesn't read is refused, never read as absent: a count dropped repeats for
        // ever, and a list of days dropped repeats on more days than asked.
        guard let count = Self.field(json["count"], \.integer), (count ?? 1) > 0,
              let until = Self.field(json["until"], { $0.number.map(EventWire.date) }),
              count == nil || until == nil,
              let days = Self.list(json["days"], { day -> Day? in
                  guard let weekday = day["weekday"]?.integer, (1...7).contains(weekday), let week = day["week"]?.integer else { return nil }
                  return Day(weekday: weekday, week: week)
              }),
              let monthDays = Self.list(json["monthDays"], \.integer), let months = Self.list(json["months"], \.integer),
              let positions = Self.list(json["positions"], \.integer), let yearWeeks = Self.list(json["yearWeeks"], \.integer),
              let yearDays = Self.list(json["yearDays"], \.integer)
        else { return nil }
        self.frequency = frequency
        self.interval = interval
        self.count = count
        self.until = until
        self.days = days
        self.monthDays = monthDays
        self.months = months
        self.positions = positions
        self.yearWeeks = yearWeeks
        self.yearDays = yearDays
    }

    /// `value` read by `read`: `.some(nil)` when it is absent or null, nil when it doesn't read.
    private static func field<T>(_ value: JSON?, _ read: (JSON) -> T?) -> T?? {
        guard let value, value != .null else { return .some(nil) }
        return read(value).map { .some($0) }
    }

    /// Every item of the list `value` read by `read`, nil when one doesn't (or it is no list); empty when
    /// it is absent or null.
    private static func list<T>(_ value: JSON?, _ read: (JSON) -> T?) -> [T]? {
        guard let value, value != .null else { return [] }
        guard let items = value.array else { return nil }
        let read = items.compactMap(read)
        return read.count == items.count ? read : nil
    }

    init(
        frequency: String, interval: Int, count: Int? = nil, until: Date? = nil, days: [Day] = [], monthDays: [Int] = [], months: [Int] = [],
        positions: [Int] = [], yearWeeks: [Int] = [], yearDays: [Int] = []
    ) {
        self.frequency = frequency
        self.interval = interval
        self.count = count
        self.until = until
        self.days = days
        self.monthDays = monthDays
        self.months = months
        self.positions = positions
        self.yearWeeks = yearWeeks
        self.yearDays = yearDays
    }

    init?(_ rule: EKRecurrenceRule) {
        guard let frequency = Self.frequencies.first(where: { $0.value == rule.frequency })?.key else { return nil }
        self.frequency = frequency
        interval = rule.interval
        count = rule.recurrenceEnd.flatMap { $0.occurrenceCount > 0 ? $0.occurrenceCount : nil }
        until = rule.recurrenceEnd?.endDate
        days = (rule.daysOfTheWeek ?? []).map { Day(weekday: $0.dayOfTheWeek.rawValue, week: $0.weekNumber) }
        monthDays = (rule.daysOfTheMonth ?? []).map(\.intValue)
        months = (rule.monthsOfTheYear ?? []).map(\.intValue)
        // Read in full: a rule read without them would say more occurrences than it has.
        positions = (rule.setPositions ?? []).map(\.intValue)
        yearWeeks = (rule.weeksOfTheYear ?? []).map(\.intValue)
        yearDays = (rule.daysOfTheYear ?? []).map(\.intValue)
    }

    var rule: EKRecurrenceRule {
        let end = count.map { EKRecurrenceEnd(occurrenceCount: $0) } ?? until.map { EKRecurrenceEnd(end: $0) }
        return EKRecurrenceRule(
            recurrenceWith: Self.frequencies[frequency] ?? .daily, interval: interval,
            daysOfTheWeek: days.isEmpty ? nil : days.compactMap { day in EKWeekday(rawValue: day.weekday).map { EKRecurrenceDayOfWeek($0, weekNumber: day.week) } },
            daysOfTheMonth: monthDays.isEmpty ? nil : monthDays.map { NSNumber(value: $0) },
            monthsOfTheYear: months.isEmpty ? nil : months.map { NSNumber(value: $0) },
            weeksOfTheYear: yearWeeks.isEmpty ? nil : yearWeeks.map { NSNumber(value: $0) },
            daysOfTheYear: yearDays.isEmpty ? nil : yearDays.map { NSNumber(value: $0) },
            setPositions: positions.isEmpty ? nil : positions.map { NSNumber(value: $0) }, end: end
        )
    }
}

/// Which occurrences of a repeating event a change or a deletion covers.
enum EventScope: String, Sendable {
    /// The whole series (or the one event).
    case all
    /// Only the occurrence named.
    case thisOnly
    /// The occurrence named and every one after it, split off as a series of their own.
    case thisAndFollowing
}

/// A calendar events can be added to.
struct EventCalendar: Equatable, Sendable {
    var id: String
    var title: String
    /// The account it belongs to, as Calendar's sidebar heads it ("iCloud", an email address).
    var account: String
    var isDefault: Bool

    var json: JSON { ["id": .string(id), "title": .string(title), "account": .string(account), "isDefault": .bool(isDefault)] }
}

/// What a change to an event sets; nil leaves a field as it is.
struct EventChanges: Sendable {
    enum Recurrence: Sendable, Equatable {
        case keep
        case clear
        case set(EventRecurrence)
    }

    var title: String?
    var start: Date?
    var end: Date?
    var isAllDay: Bool?
    /// Set to the text, or cleared with "".
    var location: String?
    var notes: String?
    var availability: String?
    var invite: [EventAttendee] = []
    /// Lowercased emails.
    var uninvite: [String] = []
    var recurrence: Recurrence = .keep
    /// Occurrences dropped from the series, by their starts.
    var exclude: [Date] = []
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
        case noSuchEvent
        case noSuchCalendar
        case calendarReadOnly
        case calendarNoInvitations
        case invitationsUnavailable
        case notOrganizer

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

    /// The event `id` names; of a repeating one, the occurrence that started at `occurrence`, or the
    /// first without it.
    func event(id: String, occurrence: Date?) async throws -> CalendarEvent {
        try await requireAccess(to: .event)
        return Self.calendarEvent(try find(id: id, occurrence: occurrence))
    }

    /// The calendars events can be added to, in Calendar's order.
    func calendars() async throws -> [EventCalendar] {
        try await requireAccess(to: .event)
        return store.calendars(for: .event).filter(\.allowsContentModifications).map { calendar in
            EventCalendar(id: calendar.calendarIdentifier, title: calendar.title, account: calendar.source?.title ?? "", isDefault: calendar.calendarIdentifier == store.defaultCalendarForNewEvents?.calendarIdentifier)
        }
    }

    /// Adds `event` to the calendar its `calendarId` names, or the default one, inviting its
    /// `attendees`, and returns it as saved.
    func add(_ event: CalendarEvent) async throws -> CalendarEvent {
        try await requireAccess(to: .event)
        let calendar: EKCalendar
        if let id = event.calendarId {
            calendar = try writableCalendar(id)
        } else {
            guard let fallback = store.defaultCalendarForNewEvents else { throw Failure.noDefaultCalendar.helperError }
            calendar = fallback
        }
        if !event.attendees.isEmpty { try requireInvitations(in: calendar) }
        let saved = EKEvent(eventStore: store)
        saved.calendar = calendar
        Self.fill(saved, from: event)
        for attendee in event.attendees where !Invitations.invite(attendee.email, name: attendee.name, to: saved) {
            throw Failure.invitationsUnavailable.helperError
        }
        try store.save(saved, span: event.recurrence == nil ? .thisEvent : .futureEvents, commit: true)
        return Self.calendarEvent(saved)
    }

    /// Changes the event `id` names (the occurrence at `occurrence` of a repeating one) as `changes`
    /// says, over the occurrences `scope` covers, and returns it as saved. Its `start` and `end` are
    /// the named occurrence's: for the whole series, every occurrence moves by as many days, to the
    /// same time of day. The occurrences `changes.exclude` names are deleted first, at the times the
    /// user read them, once everything the edit needs has been checked.
    func edit(id: String, occurrence: Date?, scope: EventScope, changes: EventChanges) async throws -> CalendarEvent {
        try await requireAccess(to: .event)
        let named = try find(id: id, occurrence: occurrence)
        try requireEditable(named)
        if !changes.invite.isEmpty { try requireInvitations(in: named.calendar) }
        if !changes.uninvite.isEmpty && !Invitations.available { throw Failure.invitationsUnavailable.helperError }
        // Each still an occurrence of this series, all found before any is deleted: a refusal deletes
        // none, and an occurrence named before the event stopped repeating deletes nothing.
        let excluded = try changes.exclude.map { start in
            let found = try find(id: id, occurrence: start)
            guard found.hasRecurrenceRules else { throw Failure.noSuchEvent.helperError }
            return found
        }
        // Each committed as it goes, never left for a later save to commit.
        for occurrence in excluded { try store.remove(occurrence, span: .thisEvent, commit: true) }
        // Found again: the deletions changed the series.
        let target = try find(id: id, occurrence: occurrence)
        // An occurrence changed on its own is changed alone, as it is deleted: saved for the following
        // events, it would be saved over every later occurrence.
        let repeats = target.hasRecurrenceRules && !target.isDetached
        let edited = repeats && scope == .all ? try find(id: id, occurrence: nil) : target
        var span: EKSpan = repeats && scope != .thisOnly ? .futureEvents : .thisEvent

        if let title = changes.title { edited.title = title }
        if let isAllDay = changes.isAllDay { edited.isAllDay = isAllDay }
        if changes.start != nil || changes.end != nil {
            let start = changes.start ?? target.startDate!
            let end = changes.end ?? target.endDate!
            var calendar = Calendar.current
            calendar.timeZone = edited.timeZone ?? .current
            let editedStart = Self.moved(edited.startDate, as: target.startDate, moves: start, in: calendar)
            edited.startDate = editedStart
            edited.endDate = Self.moved(editedStart, as: start, moves: end, in: calendar)
        }
        if let location = changes.location { edited.location = location.isEmpty ? nil : location }
        if let notes = changes.notes { edited.notes = notes.isEmpty ? nil : notes }
        if let availability = changes.availability { edited.availability = availability == "free" ? .free : .busy }
        switch changes.recurrence {
        case .keep: break
        case .clear: edited.recurrenceRules = nil
        case .set(let recurrence): edited.recurrenceRules = [recurrence.rule]
        }
        // Set with `.thisEvent`, EventKit rewrites a new rule as a daily one.
        if changes.recurrence != .keep { span = .futureEvents }

        if !changes.invite.isEmpty || !changes.uninvite.isEmpty {
            if !changes.invite.isEmpty { try requireInvitations(in: edited.calendar) }
            let removed = Set(changes.uninvite)
            for attendee in edited.attendees ?? [] where Invitations.email(of: attendee).map(removed.contains) == true {
                guard Invitations.uninvite(attendee, from: edited) else { throw Failure.invitationsUnavailable.helperError }
            }
            let present = Set((edited.attendees ?? []).compactMap(Invitations.email(of:)))
            for attendee in changes.invite where !present.contains(attendee.email.lowercased()) {
                guard Invitations.invite(attendee.email, name: attendee.name, to: edited) else { throw Failure.invitationsUnavailable.helperError }
            }
        }
        try store.save(edited, span: span, commit: true)
        return Self.calendarEvent(edited)
    }

    /// Deletes the event `id` names, every occurrence of a repeating one; the calendar's server sends
    /// its attendees the cancellation. An occurrence changed on its own has an id of its own, and is
    /// deleted alone: with every following one, the rest of its series would go too.
    func delete(id: String) async throws {
        try await requireAccess(to: .event)
        let event = try find(id: id, occurrence: nil)
        guard event.calendar?.allowsContentModifications == true else { throw Failure.calendarReadOnly.helperError }
        try store.remove(event, span: event.isDetached ? .thisEvent : .futureEvents, commit: true)
    }

    /// `date` moved by as many calendar days as `from` is from `to`, to `to`'s time of day: across a
    /// daylight-saving change, the same number of seconds would land an hour off, or on the day before.
    static func moved(_ date: Date, as from: Date, moves to: Date, in calendar: Calendar) -> Date {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: from), to: calendar.startOfDay(for: to)).day ?? 0
        let time = calendar.dateComponents([.hour, .minute, .second], from: to)
        let day = calendar.date(byAdding: .day, value: days, to: calendar.startOfDay(for: date))!
        return calendar.date(bySettingHour: time.hour ?? 0, minute: time.minute ?? 0, second: time.second ?? 0, of: day)!
    }

    /// The event `id` names: of a repeating one, the occurrence that started at `occurrence` (its
    /// original start, which a change to it alone leaves), or the first. An occurrence changed on its
    /// own has an id of its own, which names it alone; a single event is found only at its own start.
    private func find(id: String, occurrence: Date?) throws -> EKEvent {
        guard let first = store.event(withIdentifier: id) else { throw Failure.noSuchEvent.helperError }
        guard let occurrence, !first.isDetached else { return first }
        guard first.hasRecurrenceRules else {
            guard abs((first.occurrenceDate ?? first.startDate).timeIntervalSince(occurrence)) <= HelperConfig.eventOccurrenceTolerance else {
                throw Failure.noSuchEvent.helperError
            }
            return first
        }
        let span = HelperConfig.eventOccurrenceSearchSpan
        let predicate = store.predicateForEvents(
            withStart: occurrence.addingTimeInterval(-span), end: occurrence.addingTimeInterval(span), calendars: first.calendar.map { [$0] }
        )
        let found = store.events(matching: predicate).first {
            $0.eventIdentifier == id && abs(($0.occurrenceDate ?? $0.startDate).timeIntervalSince(occurrence)) <= HelperConfig.eventOccurrenceTolerance
        }
        guard let found else { throw Failure.noSuchEvent.helperError }
        return found
    }

    private func writableCalendar(_ id: String) throws -> EKCalendar {
        guard let calendar = store.calendar(withIdentifier: id), calendar.allowedEntityTypes.contains(.event) else { throw Failure.noSuchCalendar.helperError }
        guard calendar.allowsContentModifications else { throw Failure.calendarReadOnly.helperError }
        return calendar
    }

    /// An event the user can change here: in a calendar they can write to, and theirs to organize
    /// (the organizer's server overwrites an invitation's copy).
    private func requireEditable(_ event: EKEvent) throws {
        guard event.calendar?.allowsContentModifications == true else { throw Failure.calendarReadOnly.helperError }
        if Self.isInvitation(event) { throw Failure.notOrganizer.helperError }
    }

    static func isInvitation(_ event: EKEvent) -> Bool {
        guard event.hasAttendees, let organizer = event.organizer else { return false }
        return !organizer.isCurrentUser
    }

    /// Invitations need EventKit's own inviting methods, and a calendar with a server to send them.
    private func requireInvitations(in calendar: EKCalendar?) throws {
        guard Invitations.available else { throw Failure.invitationsUnavailable.helperError }
        guard let calendar, calendar.type == .calDAV || calendar.type == .exchange else { throw Failure.calendarNoInvitations.helperError }
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

    /// `event`'s fields on a new `saved`, all day first: set after the dates, it moves an all-day
    /// event's end back to its start's day.
    static func fill(_ saved: EKEvent, from event: CalendarEvent) {
        saved.title = event.title
        saved.isAllDay = event.isAllDay
        saved.startDate = event.start
        saved.endDate = event.end
        saved.location = event.location
        saved.notes = event.notes
        saved.availability = event.availability == "free" ? .free : .busy
        saved.recurrenceRules = event.recurrence.map { [$0.rule] }
    }

    static func fill(_ saved: EKReminder, from reminder: ReminderItem) {
        saved.title = reminder.title
        saved.notes = reminder.notes
        saved.dueDateComponents = reminder.dueDateComponents
    }

    static func calendarEvent(_ event: EKEvent) -> CalendarEvent {
        let repeats = event.hasRecurrenceRules || event.isDetached
        return CalendarEvent(
            title: event.title ?? "", start: event.startDate, end: event.endDate, isAllDay: event.isAllDay,
            calendar: event.calendar?.title ?? "", location: event.location, notes: event.notes,
            id: event.eventIdentifier, occurrence: repeats ? event.occurrenceDate : nil, calendarId: event.calendar?.calendarIdentifier,
            availability: event.availability == .free ? "free" : "busy",
            attendees: (event.attendees ?? []).compactMap(eventAttendee), organizer: event.organizer.flatMap(eventAttendee),
            recurrence: event.recurrenceRules?.first.flatMap(EventRecurrence.init), isDetached: event.isDetached,
            isInvitation: isInvitation(event), timeZone: event.timeZone?.identifier
        )
    }

    static func eventAttendee(_ participant: EKParticipant) -> EventAttendee? {
        guard let email = Invitations.email(of: participant) else { return nil }
        let statuses: [EKParticipantStatus: String] = [.accepted: "accepted", .declined: "declined", .tentative: "tentative", .pending: "pending"]
        return EventAttendee(email: email, name: participant.name, status: statuses[participant.participantStatus] ?? "unknown")
    }

    nonisolated static func reminderItem(_ reminder: EKReminder) -> ReminderItem {
        let components = reminder.dueDateComponents
        return ReminderItem(
            title: reminder.title ?? "", list: reminder.calendar?.title ?? "",
            due: components.flatMap { ReminderItem.dueCalendar.date(from: $0) }, dueHasTime: components?.hour != nil, notes: reminder.notes
        )
    }
}
