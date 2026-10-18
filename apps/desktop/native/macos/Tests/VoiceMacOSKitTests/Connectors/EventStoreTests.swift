// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import EventKit
import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

/// Every test of EventKit, one at a time: run alongside the store's tests, which make many stores and
/// events off the main thread, an all-day event made with a new store sometimes read its day in UTC.
@Suite(.serialized)
enum EventKitTests {}

extension EventKitTests {
    /// Calendar and Reminders as `voice-macos` sends them to the app (the app's `MacSystem.eventStore`
    /// reads them back): times in milliseconds since 1970, absent fields null, and a reminder's due date
    /// stored as EventKit keeps it. Never the user's own calendars: the EventKit items are never saved,
    /// and no access is asked.
    struct EventStoreTests {
        /// A week from now, to the second (a hardcoded date goes stale).
        private let start = Date(timeIntervalSince1970: (Date().timeIntervalSince1970 + 7 * 86_400).rounded())

        @Test
        func anEventCarriesItsTimesInMilliseconds() {
            let end = start + 3600
            let event = CalendarEvent(title: "Launch review", start: start, end: end, isAllDay: false, calendar: "Work", location: "Room 4", notes: nil)

            #expect(event.json == [
                "title": "Launch review", "start": .number(start.timeIntervalSince1970 * 1000), "end": .number(end.timeIntervalSince1970 * 1000),
                "isAllDay": false, "calendar": "Work", "location": "Room 4", "notes": nil, "id": nil, "occurrence": nil, "calendarId": nil,
                "availability": "busy", "attendees": [], "organizer": nil, "recurrence": nil, "isDetached": false, "isInvitation": false,
                "timeZone": nil,
            ])
        }

        /// An occurrence of a repeating event carries its series' id, its original start, who is invited
        /// and how it repeats, as the app reads them.
        @Test
        func anOccurrenceCarriesWhatNamesItAndHowItRepeats() {
            let until = start + 30 * 86_400
            let recurrence = EventRecurrence(frequency: "MONTHLY", interval: 2, until: until, days: [.init(weekday: 6, week: -1)])
            let event = CalendarEvent(
                title: "Review", start: start, end: start + 3600, isAllDay: false, calendar: "Work", location: nil, notes: nil,
                id: "series-1", occurrence: start, calendarId: "calendar-1", availability: "free",
                attendees: [EventAttendee(email: "alex@example.com", name: "Alex", status: "accepted")], organizer: EventAttendee(email: "me@example.com", name: nil),
                recurrence: recurrence, isDetached: true, isInvitation: true, timeZone: "America/Los_Angeles"
            )
            let ms = { (date: Date) in JSON.number(date.timeIntervalSince1970 * 1000) }

            #expect(event.json["id"] == "series-1" && event.json["occurrence"] == ms(start) && event.json["calendarId"] == "calendar-1")
            #expect(event.json["availability"] == "free" && event.json["isDetached"] == true && event.json["isInvitation"] == true)
            #expect(event.json["timeZone"] == "America/Los_Angeles")
            #expect(event.json["attendees"] == [["email": "alex@example.com", "name": "Alex", "status": "accepted"]])
            #expect(event.json["organizer"] == ["email": "me@example.com", "name": nil, "status": "unknown"])
            #expect(event.json["recurrence"] == [
                "frequency": "MONTHLY", "interval": 2, "count": nil, "until": ms(until), "days": [["weekday": 6, "week": -1]], "monthDays": [], "months": [],
                "positions": [], "yearWeeks": [], "yearDays": [],
            ])
            #expect(EventRecurrence(json: event.json["recurrence"]!) == recurrence)
        }

        /// A rule's JSON carries its count and every list, each entry where the app reads it.
        @Test
        func aRuleCarriesItsCountAndEveryList() {
            let rule = EventRecurrence(
                frequency: "YEARLY", interval: 1, count: 4, days: [.init(weekday: 2, week: 1)], monthDays: [1, -1], months: [3, 9], positions: [-1], yearWeeks: [20], yearDays: [100]
            )
            #expect(rule.json == [
                "frequency": "YEARLY", "interval": 1, "count": 4, "until": nil, "days": [["weekday": 2, "week": 1]], "monthDays": [1, -1], "months": [3, 9],
                "positions": [-1], "yearWeeks": [20], "yearDays": [100],
            ])
            #expect(EventRecurrence(json: rule.json) == rule)
        }

        /// A rule as the app sends it becomes EventKit's, and reads back the same.
        @Test(arguments: [
            EventRecurrence(frequency: "MONTHLY", interval: 1, days: (2...6).map { .init(weekday: $0, week: 0) }, positions: [-1]),
            EventRecurrence(frequency: "YEARLY", interval: 1, yearWeeks: [20]),
            EventRecurrence(frequency: "YEARLY", interval: 1, yearDays: [100, -1]),
            EventRecurrence(frequency: "DAILY", interval: 1, count: 5),
            EventRecurrence(frequency: "WEEKLY", interval: 2, days: [.init(weekday: 2, week: 0), .init(weekday: 4, week: 0)]),
            EventRecurrence(frequency: "MONTHLY", interval: 1, monthDays: [1, -1]),
            EventRecurrence(frequency: "YEARLY", interval: 1, until: Date(timeIntervalSince1970: (Date().timeIntervalSince1970 + 400 * 86_400).rounded()), months: [3, 9]),
        ])
        func aRecurrenceBecomesEventKitsRule(recurrence: EventRecurrence) {
            #expect(EventRecurrence(recurrence.rule) == recurrence)
        }

        /// Malformed rules are refused, never guessed.
        @Test(arguments: [
            ["interval": 1] as JSON,
            ["frequency": "HOURLY", "interval": 1],
            ["frequency": "DAILY", "interval": 0],
            ["frequency": "DAILY", "interval": 1, "count": 2, "until": 1_000],
            ["frequency": "WEEKLY", "interval": 1, "days": [["weekday": 8, "week": 0]]],
            ["frequency": "WEEKLY", "interval": 1, "days": [["weekday": 2]]],
            // A field sent that doesn't read is refused, never read as absent: an endless rule, or more days.
            ["frequency": "DAILY", "interval": 1, "count": 1e100],
            ["frequency": "DAILY", "interval": 1, "count": 0],
            ["frequency": "DAILY", "interval": 1, "count": "4"],
            ["frequency": "DAILY", "interval": 1, "until": "soon"],
            ["frequency": "WEEKLY", "interval": 1, "days": "MO"],
            ["frequency": "MONTHLY", "interval": 1, "monthDays": [15, 1e100]],
            ["frequency": "YEARLY", "interval": 1, "months": [3.5]],
            ["frequency": "MONTHLY", "interval": 1, "positions": "-1"],
            ["frequency": "YEARLY", "interval": 1, "yearWeeks": [1e100]],
            ["frequency": "YEARLY", "interval": 1, "yearDays": [nil]],
        ])
        func aMalformedRecurrenceIsRefused(json: JSON) {
            #expect(EventRecurrence(json: json) == nil)
        }

        @Test
        func aReminderCarriesItsDueTimeInMillisecondsOrNull() {
            let due = ReminderItem(title: "Send the deck", list: "Work", due: start, dueHasTime: true, notes: "the short one")
            let undated = ReminderItem(title: "Water the plants", list: "Home", due: nil, dueHasTime: false, notes: nil)

            #expect(due.json == ["title": "Send the deck", "list": "Work", "due": .number(start.timeIntervalSince1970 * 1000), "dueHasTime": true, "notes": "the short one"])
            #expect(undated.json == ["title": "Water the plants", "list": "Home", "due": nil, "dueHasTime": false, "notes": nil])
        }

        /// The app's milliseconds come back as the same instant.
        @Test
        func millisecondsRoundTrip() {
            let milliseconds = start.timeIntervalSince1970 * 1000 + 250
            #expect(EventWire.json(EventWire.date(milliseconds)) == .number(milliseconds))
        }

        /// A reminder due at a time keeps its hour and minute; one due on a day keeps only the day, so
        /// Reminders shows no time for it. Both are Gregorian, as EventKit reads them, in this Mac's zone,
        /// whatever calendar the Mac is set to.
        @Test
        func aReminderIsDueOnADayOrAtATime() throws {
            let timed = try #require(ReminderItem(title: "Call back", list: "", due: start, dueHasTime: true, notes: nil).dueDateComponents)
            let day = try #require(ReminderItem(title: "Call back", list: "", due: start, dueHasTime: false, notes: nil).dueDateComponents)
            var gregorian = Calendar(identifier: .gregorian)
            gregorian.timeZone = .current
            let expected = gregorian.dateComponents([.year, .month, .day, .hour, .minute], from: start)

            #expect(ReminderItem.dueCalendar.identifier == .gregorian && ReminderItem.dueCalendar.timeZone == .current)
            #expect(timed == expected)
            #expect(day == gregorian.dateComponents([.year, .month, .day], from: start))
            #expect(day.hour == nil)
            #expect(ReminderItem(title: "Call back", list: "", due: nil, dueHasTime: false, notes: nil).dueDateComponents == nil)
        }

        /// An all-day event over several days is added through its last day, with the rest of its fields,
        /// and read back as the app sent it.
        @Test
        @MainActor
        func anAllDayEventKeepsItsLastDay() {
            let first = Calendar.current.startOfDay(for: start)
            let last = Calendar.current.date(byAdding: .day, value: 2, to: first)!
            let event = CalendarEvent(title: "Offsite", start: first, end: last, isAllDay: true, calendar: "", location: "Room 4", notes: "the long one")
            let saved = EKEvent(eventStore: EKEventStore())

            EventKitStore.fill(saved, from: event)
            let read = EventKitStore.calendarEvent(saved)

            #expect(saved.isAllDay)
            #expect(Calendar.current.isDate(saved.startDate, inSameDayAs: first))
            #expect(Calendar.current.isDate(saved.endDate, inSameDayAs: last))
            #expect(read.title == "Offsite" && read.isAllDay && read.location == "Room 4" && read.notes == "the long one")
            #expect(Calendar.current.isDate(read.end, inSameDayAs: last))
        }

        /// A timed event keeps its times to the second, in the Mac's zone, where EventKit puts a new one.
        @Test
        @MainActor
        func aTimedEventKeepsItsTimes() {
            let event = CalendarEvent(title: "Launch review", start: start, end: start + 1800, isAllDay: false, calendar: "", location: nil, notes: nil)
            let saved = EKEvent(eventStore: EKEventStore())

            EventKitStore.fill(saved, from: event)

            var read = event
            read.timeZone = TimeZone.current.identifier
            #expect(EventKitStore.calendarEvent(saved) == read)
        }

        /// A reminder is added with its notes and its due date as EventKit keeps it, and read back as the
        /// app sent it.
        @Test
        @MainActor
        func aReminderKeepsItsFields() {
            let reminder = ReminderItem(title: "Call back", list: "", due: Date(timeIntervalSince1970: (start.timeIntervalSince1970 / 60).rounded(.down) * 60), dueHasTime: true, notes: "the short one")
            let saved = EKReminder(eventStore: EKEventStore())

            EventKitStore.fill(saved, from: reminder)

            #expect(EventKitStore.reminderItem(saved) == reminder)
        }

        /// A reminder due on a day, with no time, reads back as due that day with no time.
        @Test
        @MainActor
        func aDayReminderKeepsNoTime() {
            let reminder = ReminderItem(title: "Call back", list: "", due: Calendar.current.startOfDay(for: start), dueHasTime: false, notes: nil)
            let saved = EKReminder(eventStore: EKEventStore())

            EventKitStore.fill(saved, from: reminder)

            #expect(EventKitStore.reminderItem(saved) == reminder)
        }

        /// An attendee is read with their answer to the invitation, any other as unknown.
        @Test(arguments: [
            (EKParticipantStatus.accepted, "accepted"), (.declined, "declined"), (.tentative, "tentative"), (.pending, "pending"), (.delegated, "unknown"), (.unknown, "unknown"),
        ])
        @MainActor
        func anAttendeeIsReadWithTheirAnswer(status: EKParticipantStatus, read: String) throws {
            let alex = answering(try #require(participant("alex@example.com")), status)
            #expect(EventKitStore.eventAttendee(alex) == EventAttendee(email: "alex@example.com", name: nil, status: read))
        }

        /// An event's free or busy, how it repeats and the people invited to it read back as saved.
        @Test
        @MainActor
        func anEventKeepsItsAvailabilityRepeatingAndInvitations() throws {
            let fake = FakeEventStore()
            let recurrence = EventRecurrence(frequency: "WEEKLY", interval: 1, days: [.init(weekday: 2, week: 0)])
            let event = CalendarEvent(title: "Sync", start: start, end: start + 1800, isAllDay: false, calendar: "", location: nil, notes: nil, availability: "free", recurrence: recurrence)
            let saved = EKEvent(eventStore: fake)
            saved.calendar = fake.sharedCalendar

            EventKitStore.fill(saved, from: event)
            #expect(Invitations.available)
            #expect(Invitations.invite("Alex@Example.com", name: "Alex", to: saved))
            let read = EventKitStore.calendarEvent(saved)

            #expect(saved.availability == .free)
            #expect(read.availability == "free" && read.recurrence == recurrence)
            #expect(read.attendees.contains { $0.email == "alex@example.com" && $0.name == "Alex" })
            let alex = try #require(saved.attendees?.first { Invitations.email(of: $0) == "alex@example.com" })
            #expect(Invitations.uninvite(alex, from: saved))
            #expect(EventKitStore.calendarEvent(saved).attendees.contains { $0.email == "alex@example.com" } == false)
        }

        /// Each refusal goes to the app by the name it knows (`EventStoreFailure`'s kinds).
        @Test
        func refusalsGoByName() {
            #expect(EventKitStore.Failure.calendarNoAccess.helperError == HelperError("calendarNoAccess"))
            #expect(EventKitStore.Failure.noDefaultList.helperError == HelperError("noDefaultList"))
        }
    }
}

/// EventKit standing in for the user's calendars and reminders: it records what `EventKitStore` asks
/// and saves, returns the events and reminders a test gives it, and asks macOS for nothing.
final class FakeEventStore: EKEventStore, @unchecked Sendable {
    /// What a request for access answers: granted, refused, or (nil) failing.
    var grants: Bool? = true
    var hasDefaults = true
    var events: [EKEvent] = []
    var reminders: [EKReminder] = []
    private(set) var accessRequests: [EKEntityType] = []
    private(set) var eventRanges: [ClosedRange<Date>] = []
    /// The calendars the last event predicate covers (nil: every one).
    private var eventCalendars: [EKCalendar]?
    private(set) var reminderDueBefore: [Date?] = []
    private(set) var fetches = 0
    private(set) var saved: [EKCalendarItem] = []

    lazy var calendar: EKCalendar = {
        let calendar = EKCalendar(for: .event, eventStore: self)
        calendar.title = "Work"
        return calendar
    }()

    lazy var list: EKCalendar = {
        let list = EKCalendar(for: .reminder, eventStore: self)
        list.title = "Errands"
        return list
    }()

    /// A calendar on a server, which can send invitations.
    lazy var sharedCalendar: EKCalendar = {
        let calendar = EKCalendar(for: .event, eventStore: self)
        calendar.title = "Team"
        object_setClass(calendar, ServerCalendar.self)
        return calendar
    }()

    /// A subscribed calendar, which can't be changed.
    lazy var readOnlyCalendar: EKCalendar = {
        let calendar = EKCalendar(for: .event, eventStore: self)
        calendar.title = "Holidays"
        object_setClass(calendar, ReadOnlyCalendar.self)
        return calendar
    }()

    /// The events `event(withIdentifier:)` finds: of a repeating one, its first occurrence.
    var byID: [String: EKEvent] = [:]
    private(set) var removed: [(title: String, span: EKSpan, commit: Bool)] = []
    private(set) var spans: [EKSpan] = []
    private(set) var commits = 0
    /// Every removal and save of an event, in order.
    private(set) var writes: [String] = []
    /// How many removals succeed before the next fails (nil: none fails), and whether a save fails.
    var removalsBeforeFailure: Int?
    var savesFail = false

    override var defaultCalendarForNewEvents: EKCalendar? { hasDefaults ? calendar : nil }
    override func event(withIdentifier identifier: String) -> EKEvent? { byID[identifier] }
    override func calendar(withIdentifier identifier: String) -> EKCalendar? {
        [calendar, sharedCalendar, readOnlyCalendar, list].first { $0.calendarIdentifier == identifier }
    }
    override func calendars(for entityType: EKEntityType) -> [EKCalendar] { entityType == .event ? [calendar, sharedCalendar, readOnlyCalendar] : [list] }

    override func remove(_ event: EKEvent, span: EKSpan, commit: Bool) throws {
        if removalsBeforeFailure == removed.count { throw CocoaError(.fileWriteUnknown) }
        removed.append((event.title, span, commit))
        writes.append("remove \(event.title ?? "")")
    }

    override func commit() throws {
        commits += 1
    }
    override func defaultCalendarForNewReminders() -> EKCalendar? { hasDefaults ? list : nil }

    override func requestFullAccessToEvents(completion: @escaping EKEventStoreRequestAccessCompletionHandler) {
        answerAccess(.event, completion)
    }

    override func requestFullAccessToReminders(completion: @escaping EKEventStoreRequestAccessCompletionHandler) {
        answerAccess(.reminder, completion)
    }

    private func answerAccess(_ type: EKEntityType, _ completion: EKEventStoreRequestAccessCompletionHandler) {
        accessRequests.append(type)
        if let grants { completion(grants, nil) } else { completion(false, CocoaError(.featureUnsupported)) }
    }

    override func predicateForEvents(withStart startDate: Date, end endDate: Date, calendars: [EKCalendar]?) -> NSPredicate {
        eventRanges.append(startDate...endDate)
        eventCalendars = calendars
        return super.predicateForEvents(withStart: startDate, end: endDate, calendars: calendars)
    }

    override func events(matching predicate: NSPredicate) -> [EKEvent] {
        fetches += 1
        guard let eventCalendars else { return events }
        return events.filter { event in eventCalendars.contains { $0 === event.calendar } }
    }

    override func predicateForIncompleteReminders(withDueDateStarting startDate: Date?, ending endDate: Date?, calendars: [EKCalendar]?) -> NSPredicate {
        reminderDueBefore.append(endDate)
        return super.predicateForIncompleteReminders(withDueDateStarting: startDate, ending: endDate, calendars: calendars)
    }

    override func fetchReminders(matching predicate: NSPredicate, completion: @escaping ([EKReminder]?) -> Void) -> Any {
        fetches += 1
        completion(reminders)
        return NSObject()
    }

    override func save(_ event: EKEvent, span: EKSpan, commit: Bool) throws {
        #expect(commit)
        if savesFail { throw CocoaError(.fileWriteUnknown) }
        saved.append(event)
        spans.append(span)
        writes.append("save \(event.title ?? "")")
    }

    override func save(_ reminder: EKReminder, commit: Bool) throws {
        #expect(commit)
        saved.append(reminder)
    }

    func event(_ title: String, start: Date, hours: Double) -> EKEvent {
        let event = EKEvent(eventStore: self)
        event.calendar = calendar
        event.title = title
        event.startDate = start
        event.endDate = start + hours * 3600
        return event
    }

    /// An occurrence of the series `id`, which started at `occurrence` (its start unless it moved).
    func occurrence(_ title: String, id: String, start: Date, occurrence: Date? = nil, hours: Double = 1, repeats: Bool = true, in calendar: EKCalendar? = nil) -> StubEvent {
        let event = StubEvent.make(eventStore: self)
        event.calendar = calendar ?? self.calendar
        event.title = title
        event.startDate = start
        event.endDate = start + hours * 3600
        event.stubIdentifier = id
        event.stubOccurrence = occurrence ?? start
        if repeats { event.recurrenceRules = [EventRecurrence(frequency: "WEEKLY", interval: 1).rule] }
        return event
    }
}

/// An EKEvent with the identity, occurrence and organizer EventKit gives only a saved one. EventKit's
/// own events can't be made one but by `object_setClass`, so it keeps what it stands in for as
/// associated objects, not stored properties.
final class StubEvent: EKEvent {
    private nonisolated(unsafe) static var identifierKey: UInt8 = 0
    private nonisolated(unsafe) static var occurrenceKey: UInt8 = 0
    private nonisolated(unsafe) static var organizerKey: UInt8 = 0
    private nonisolated(unsafe) static var detachedKey: UInt8 = 0

    static func make(eventStore: EKEventStore) -> StubEvent {
        let event = EKEvent(eventStore: eventStore)
        object_setClass(event, StubEvent.self)
        return unsafeDowncast(event, to: StubEvent.self)
    }

    var stubIdentifier: String? {
        get { objc_getAssociatedObject(self, &Self.identifierKey) as? String }
        set { objc_setAssociatedObject(self, &Self.identifierKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
    }

    var stubOccurrence: Date? {
        get { objc_getAssociatedObject(self, &Self.occurrenceKey) as? Date }
        set { objc_setAssociatedObject(self, &Self.occurrenceKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
    }

    var stubOrganizer: EKParticipant? {
        get { objc_getAssociatedObject(self, &Self.organizerKey) as? EKParticipant }
        set { objc_setAssociatedObject(self, &Self.organizerKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
    }

    var stubDetached: Bool {
        get { objc_getAssociatedObject(self, &Self.detachedKey) as? Bool ?? false }
        set { objc_setAssociatedObject(self, &Self.detachedKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
    }

    override var eventIdentifier: String! { stubIdentifier }
    override var occurrenceDate: Date! { stubOccurrence ?? startDate }
    override var organizer: EKParticipant? { stubOrganizer ?? super.organizer }
    override var isDetached: Bool { stubDetached }
}

/// A calendar on a server (EventKit's own calendars can't be made one), as `object_setClass` makes
/// a new EKCalendar: so these declare no stored properties.
final class ServerCalendar: EKCalendar {
    override var type: EKCalendarType { .calDAV }
    override var supportedEventAvailabilities: EKCalendarEventAvailabilityMask { [.busy, .free] }
    override var source: EKSource! {
        get { ServerAccount() }
        set {}
    }
}

/// The account a server calendar is in, as Calendar names it.
final class ServerAccount: EKSource {
    override var title: String { "Team account" }
}

/// An Exchange calendar, made as `ServerCalendar` is: it sends invitations too.
final class ExchangeCalendar: EKCalendar {
    override var type: EKCalendarType { .exchange }
}

/// A calendar that can't be changed, made as `ServerCalendar` is.
final class ReadOnlyCalendar: EKCalendar {
    override var allowsContentModifications: Bool { false }
}

/// Someone, as Calendar makes an attendee (the method `Invitations` uses), for an organizer.
/// `participant` marked as the user, as EventKit marks the user's own address: a subclass made at run
/// time (EventKit's attendee class is its own), answering `isCurrentUser` true.
func currentUser(_ participant: EKParticipant) -> EKParticipant {
    guard let base = object_getClass(participant) else { return participant }
    let name = "VoiceTestCurrentUser\(NSStringFromClass(base))"
    let subclass: AnyClass? = NSClassFromString(name) ?? {
        guard let made = objc_allocateClassPair(base, name, 0) else { return nil }
        let isCurrentUser: @convention(block) (AnyObject) -> Bool = { _ in true }
        class_addMethod(made, NSSelectorFromString("isCurrentUser"), imp_implementationWithBlock(isCurrentUser), "B@:")
        objc_registerClassPair(made)
        return made
    }()
    if let subclass { object_setClass(participant, subclass) }
    return participant
}

/// `participant` as a room or other resource Calendar reaches by a URL that is no email address: a
/// subclass made at run time, answering `url` with `url`.
func resource(_ participant: EKParticipant, at url: URL) -> EKParticipant {
    guard let base = object_getClass(participant) else { return participant }
    let name = "VoiceTestResource\(NSStringFromClass(base))"
    let subclass: AnyClass? = NSClassFromString(name) ?? {
        guard let made = objc_allocateClassPair(base, name, 0) else { return nil }
        let answer: @convention(block) (AnyObject) -> NSURL = { _ in url as NSURL }
        class_addMethod(made, NSSelectorFromString("URL"), imp_implementationWithBlock(answer), "@@:")
        objc_registerClassPair(made)
        return made
    }()
    if let subclass { object_setClass(participant, subclass) }
    return participant
}

/// `participant` as having answered `status`: a subclass made at run time, one for each answer.
func answering(_ participant: EKParticipant, _ status: EKParticipantStatus) -> EKParticipant {
    guard let base = object_getClass(participant) else { return participant }
    let name = "VoiceTestAnswer\(status.rawValue)\(NSStringFromClass(base))"
    let subclass: AnyClass? = NSClassFromString(name) ?? {
        guard let made = objc_allocateClassPair(base, name, 0) else { return nil }
        let answer: @convention(block) (AnyObject) -> Int = { _ in status.rawValue }
        class_addMethod(made, NSSelectorFromString("participantStatus"), imp_implementationWithBlock(answer), "q@:")
        objc_registerClassPair(made)
        return made
    }()
    if let subclass { object_setClass(participant, subclass) }
    return participant
}

/// Makes `method` answer as `block` does, returning its own implementation for the test to put back:
/// what EventKit's private methods do, for the tests that need them to fail or to be seen.
func replace(_ method: Method, with block: Any) -> IMP {
    method_setImplementation(method, imp_implementationWithBlock(block))
}

func participant(_ email: String) -> EKParticipant? {
    _ = EKEvent(eventStore: EKEventStore())
    guard let attendeeClass = NSClassFromString("EKAttendee") as? NSObject.Type else { return nil }
    let factory = NSSelectorFromString("attendeeWithName:emailAddress:")
    return attendeeClass.perform(factory, with: nil, with: email)?.takeUnretainedValue() as? EKParticipant
}
extension EventKitTests {
    /// `EventKitStore` over a stand-in EventKit (never the user's calendars, and no access asked of
    /// macOS): what it asks access for, reads and saves, and what `voice-macos`'s requests answer.
    @MainActor
    struct EventKitStoreTests {
        /// A week from now, to the minute (a hardcoded date goes stale).
        private let start = Date(timeIntervalSince1970: ((Date().timeIntervalSince1970 + 7 * 86_400) / 60).rounded(.down) * 60)

        private func store(_ fake: FakeEventStore, _ status: EKAuthorizationStatus = .fullAccess) -> EventKitStore {
            EventKitStore(store: fake, status: { _ in status })
        }

        /// The events in the range asked, oldest first, each with its calendar's name.
        @Test
        func eventsAreReadOldestFirst() async throws {
            let fake = FakeEventStore()
            fake.events = [fake.event("Later", start: start + 7200, hours: 1), fake.event("Sooner", start: start, hours: 0.5)]

            let events = try await store(fake).events(from: start, to: start + 86_400)

            #expect(fake.eventRanges == [start...(start + 86_400)])
            #expect(events.map(\.title) == ["Sooner", "Later"])
            #expect(events.map(\.calendar) == ["Work", "Work"])
            #expect(events.first?.end == start + 1800)
        }

        /// An event is saved, committed, in the default calendar, and comes back as saved.
        @Test
        func anEventIsSavedInTheDefaultCalendar() async throws {
            let fake = FakeEventStore()
            let event = CalendarEvent(title: "Launch review", start: start, end: start + 1800, isAllDay: false, calendar: "", location: "Room 4", notes: "bring the deck")

            let added = try await store(fake).add(event)

            #expect(fake.saved.count == 1)
            let saved = try #require(fake.saved.first as? EKEvent)
            #expect(saved.calendar === fake.calendar)
            #expect(EventKitStore.calendarEvent(saved) == added)
            #expect(added == CalendarEvent(
                title: "Launch review", start: start, end: start + 1800, isAllDay: false, calendar: "Work", location: "Room 4", notes: "bring the deck",
                calendarId: fake.calendar.calendarIdentifier, timeZone: TimeZone.current.identifier
            ))
            #expect(fake.spans == [.thisEvent])
        }

        /// An event goes in the calendar its `calendarId` names, repeating (saved for the series), its
        /// people invited; a calendar there isn't, or that can't be changed, saves nothing.
        @Test
        func anEventIsSavedInTheCalendarAskedInvitingPeople() async throws {
            let fake = FakeEventStore()
            let events = store(fake)
            var event = CalendarEvent(title: "Planning", start: start, end: start + 1800, isAllDay: false, calendar: "", location: nil, notes: nil)
            event.calendarId = fake.sharedCalendar.calendarIdentifier
            event.recurrence = EventRecurrence(frequency: "DAILY", interval: 1, count: 3)
            event.attendees = [EventAttendee(email: "alex@example.com", name: "Alex"), EventAttendee(email: "sam@example.com", name: nil)]

            let added = try await events.add(event)

            let saved = try #require(fake.saved.first as? EKEvent)
            #expect(saved.calendar === fake.sharedCalendar && fake.spans == [.futureEvents])
            #expect(added.calendar == "Team" && added.recurrence == event.recurrence)
            #expect(Set(added.attendees.map(\.email)).isSuperset(of: ["alex@example.com", "sam@example.com"]))

            await #expect(throws: EventKitStore.Failure.noSuchCalendar.helperError) {
                var elsewhere = event
                elsewhere.calendarId = "calendar-gone"
                _ = try await events.add(elsewhere)
            }
            await #expect(throws: EventKitStore.Failure.calendarReadOnly.helperError) {
                var holidays = event
                holidays.calendarId = fake.readOnlyCalendar.calendarIdentifier
                _ = try await events.add(holidays)
            }
            // A reminders list is no calendar for events.
            await #expect(throws: EventKitStore.Failure.noSuchCalendar.helperError) {
                var errands = event
                errands.calendarId = fake.list.calendarIdentifier
                _ = try await events.add(errands)
            }
            // A calendar on this Mac only has no server to send the invitations.
            await #expect(throws: EventKitStore.Failure.calendarNoInvitations.helperError) {
                var local = event
                local.calendarId = nil
                _ = try await events.add(local)
            }
            #expect(fake.saved.count == 1)
        }

        /// The calendars events can be added to: not a read-only one, the default marked.
        @Test
        func theWritableCalendarsAreListed() async throws {
            let fake = FakeEventStore()
            let calendars = try await store(fake).calendars()
            #expect(calendars.map(\.title) == ["Work", "Team"])
            #expect(calendars.map(\.isDefault) == [true, false])
            #expect(calendars.map(\.account) == ["", "Team account"])
            #expect(calendars.first?.id == fake.calendar.calendarIdentifier)
        }

        /// An event by its id; an occurrence of a repeating one by its id and original start, though it
        /// moved; none there is fails by name.
        @Test
        func anEventIsFoundByItsIDAndOccurrence() async throws {
            let fake = FakeEventStore()
            let first = fake.occurrence("Sync", id: "series-1", start: start)
            let moved = fake.occurrence("Sync", id: "series-1", start: start + 7 * 86_400 + 3600, occurrence: start + 7 * 86_400)
            fake.byID = ["series-1": first, "event-2": fake.occurrence("Review", id: "event-2", start: start, repeats: false)]
            fake.events = [fake.occurrence("Other", id: "series-9", start: start + 7 * 86_400), first, moved]
            let events = store(fake)

            #expect(try await events.event(id: "series-1", occurrence: nil).start == start)
            let found = try await events.event(id: "series-1", occurrence: start + 7 * 86_400)
            #expect(found.start == moved.startDate && found.occurrence == start + 7 * 86_400 && found.id == "series-1")
            // A single event is found at its own start, and at no other: an occurrence named while it still
            // repeated names nothing now.
            #expect(try await events.event(id: "event-2", occurrence: start).title == "Review")
            await #expect(throws: EventKitStore.Failure.noSuchEvent.helperError) { _ = try await events.event(id: "event-2", occurrence: start + 86_400) }
            let span = HelperConfig.eventOccurrenceSearchSpan
            #expect(fake.eventRanges.last == (start + 7 * 86_400 - span)...(start + 7 * 86_400 + span))
            await #expect(throws: EventKitStore.Failure.noSuchEvent.helperError) { _ = try await events.event(id: "gone", occurrence: nil) }
            await #expect(throws: EventKitStore.Failure.noSuchEvent.helperError) { _ = try await events.event(id: "series-1", occurrence: start + 3 * 86_400) }
        }

        /// A single event's fields change as asked, saved for it alone; "" removes a place or notes.
        @Test
        func aSingleEventChangesAsAsked() async throws {
            let fake = FakeEventStore()
            let event = fake.occurrence("Review", id: "event-1", start: start, repeats: false, in: fake.sharedCalendar)
            event.location = "Room 4"
            fake.byID = ["event-1": event]
            var changes = EventChanges()
            changes.title = "Kickoff"
            changes.start = start + 3600
            changes.end = start + 5400
            changes.location = ""
            changes.notes = "Bring the deck"
            changes.availability = "free"

            let saved = try await store(fake).edit(id: "event-1", occurrence: nil, scope: .all, changes: changes)

            #expect(saved.title == "Kickoff" && saved.start == start + 3600 && saved.end == start + 5400)
            #expect(saved.location == nil && saved.notes == "Bring the deck" && saved.availability == "free")
            #expect(fake.spans == [.thisEvent] && fake.removed.isEmpty)

            var clearing = EventChanges()
            clearing.notes = ""
            let cleared = try await store(fake).edit(id: "event-1", occurrence: nil, scope: .all, changes: clearing)
            #expect(cleared.notes == nil && event.notes == nil)
        }

        /// For the whole series, the first occurrence moves by as much as the one named, saved for every
        /// one; for one occurrence, that one alone; from one on, that one for the rest.
        @Test(arguments: [(EventScope.all, EKSpan.futureEvents), (.thisOnly, .thisEvent), (.thisAndFollowing, .futureEvents)])
        func aRepeatingEventChangesOverTheScopeAsked(scope: EventScope, span: EKSpan) async throws {
            let fake = FakeEventStore()
            let first = fake.occurrence("Sync", id: "series-1", start: start, hours: 0.5)
            let later = fake.occurrence("Sync", id: "series-1", start: start + 7 * 86_400, hours: 0.5)
            fake.byID = ["series-1": first]
            fake.events = [first, later]
            var changes = EventChanges()
            changes.start = later.startDate + 3600
            changes.end = later.startDate + 3600 + 2700

            _ = try await store(fake).edit(id: "series-1", occurrence: later.startDate, scope: scope, changes: changes)

            let edited = scope == .all ? first : later
            let base = scope == .all ? start : start + 7 * 86_400
            #expect(fake.saved.count == 1 && fake.saved.first === edited)
            #expect(edited.startDate == base + 3600 && edited.endDate == base + 3600 + 2700)
            #expect(fake.spans == [span])
        }

        /// A new rule, or none, is saved for the series even for one occurrence asked (EventKit rewrites a
        /// rule saved for one as a daily one); the occurrences dropped go first, committed, by their starts.
        @Test
        func repeatingChangesAndOccurrencesAreDropped() async throws {
            let fake = FakeEventStore()
            let first = fake.occurrence("Sync", id: "series-1", start: start)
            let second = fake.occurrence("Sync second", id: "series-1", start: start + 7 * 86_400)
            let third = fake.occurrence("Sync third", id: "series-1", start: start + 14 * 86_400)
            fake.byID = ["series-1": first]
            fake.events = [first, second, third]
            var changes = EventChanges()
            changes.recurrence = .set(EventRecurrence(frequency: "DAILY", interval: 1, count: 4))
            changes.exclude = [start + 7 * 86_400, start + 14 * 86_400]

            let saved = try await store(fake).edit(id: "series-1", occurrence: nil, scope: .all, changes: changes)

            #expect(fake.removed.map(\.title) == ["Sync second", "Sync third"])
            #expect(fake.writes == ["remove Sync second", "remove Sync third", "save Sync"])
            // Each committed as it goes: none left pending for a later save to commit.
            #expect(fake.removed.allSatisfy { $0.span == .thisEvent && $0.commit } && fake.commits == 0)
            #expect(saved.recurrence == EventRecurrence(frequency: "DAILY", interval: 1, count: 4) && fake.spans == [.futureEvents])

            var ending = EventChanges()
            ending.recurrence = .clear
            _ = try await store(fake).edit(id: "series-1", occurrence: start, scope: .thisOnly, changes: ending)
            #expect(first.recurrenceRules?.isEmpty != false && fake.spans == [.futureEvents, .futureEvents])
        }

        /// People are invited once each (by email, any case) and removed by email.
        @Test
        func peopleAreInvitedAndRemoved() async throws {
            let fake = FakeEventStore()
            let event = fake.occurrence("Planning", id: "event-1", start: start, repeats: false, in: fake.sharedCalendar)
            #expect(Invitations.invite("alex@example.com", name: "Alex", to: event))
            fake.byID = ["event-1": event]
            var changes = EventChanges()
            changes.invite = [EventAttendee(email: "ALEX@example.com", name: nil), EventAttendee(email: "sam@example.com", name: "Sam")]

            let invited = try await store(fake).edit(id: "event-1", occurrence: nil, scope: .all, changes: changes)
            #expect(invited.attendees.filter { $0.email == "alex@example.com" }.count == 1)
            #expect(invited.attendees.contains { $0.email == "sam@example.com" })

            var removing = EventChanges()
            removing.uninvite = ["alex@example.com"]
            let removed = try await store(fake).edit(id: "event-1", occurrence: nil, scope: .all, changes: removing)
            #expect(!removed.attendees.contains { $0.email == "alex@example.com" } && removed.attendees.contains { $0.email == "sam@example.com" })
        }

        /// An invitation from someone else, a read-only calendar, an event there isn't or invitations a
        /// calendar on this Mac can't send change nothing, and say which.
        @Test
        func whatCantBeChangedIsRefused() async throws {
            let fake = FakeEventStore()
            let invitation = fake.occurrence("Review", id: "event-1", start: start, repeats: false, in: fake.sharedCalendar)
            #expect(Invitations.invite("me@example.com", name: nil, to: invitation))
            invitation.stubOrganizer = participant("pat@example.com")
            let holiday = fake.occurrence("Holiday", id: "event-2", start: start, repeats: false, in: fake.readOnlyCalendar)
            let local = fake.occurrence("Focus", id: "event-3", start: start, repeats: false)
            fake.byID = ["event-1": invitation, "event-2": holiday, "event-3": local]
            let events = store(fake)
            var changes = EventChanges()
            changes.title = "Changed"
            var inviting = EventChanges()
            inviting.invite = [EventAttendee(email: "sam@example.com", name: nil)]

            #expect(EventKitStore.calendarEvent(invitation).isInvitation)
            await #expect(throws: EventKitStore.Failure.notOrganizer.helperError) { _ = try await events.edit(id: "event-1", occurrence: nil, scope: .all, changes: changes) }
            await #expect(throws: EventKitStore.Failure.calendarReadOnly.helperError) { _ = try await events.edit(id: "event-2", occurrence: nil, scope: .all, changes: changes) }
            await #expect(throws: EventKitStore.Failure.noSuchEvent.helperError) { _ = try await events.edit(id: "gone", occurrence: nil, scope: .all, changes: changes) }
            await #expect(throws: EventKitStore.Failure.calendarNoInvitations.helperError) { _ = try await events.edit(id: "event-3", occurrence: nil, scope: .all, changes: inviting) }
            await #expect(throws: EventKitStore.Failure.calendarReadOnly.helperError) { try await events.delete(id: "event-2") }
            #expect(fake.saved.isEmpty && fake.removed.isEmpty)
        }

        /// Deleting removes every occurrence, committed; an invitation from someone else is removed too.
        @Test
        func anEventIsDeletedWithEveryOccurrence() async throws {
            let fake = FakeEventStore()
            fake.byID = ["series-1": fake.occurrence("Sync", id: "series-1", start: start)]

            try await store(fake).delete(id: "series-1")

            #expect(fake.removed.map(\.title) == ["Sync"] && fake.removed.first?.span == .futureEvents && fake.removed.first?.commit == true)
            // An occurrence changed on its own, by its own id, goes alone.
            let moved = fake.occurrence("Sync moved", id: "series-1/moved", start: start + 7 * 86_400, repeats: false)
            moved.stubDetached = true
            fake.byID["series-1/moved"] = moved
            try await store(fake).delete(id: "series-1/moved")
            #expect(fake.removed.last?.title == "Sync moved" && fake.removed.last?.span == .thisEvent)
            await #expect(throws: EventKitStore.Failure.noSuchEvent.helperError) { try await store(fake).delete(id: "gone") }
            // An invitation, someone else's event with the user invited, is removed from the user's calendar.
            let invitation = fake.occurrence("Their review", id: "event-2", start: start, repeats: false, in: fake.sharedCalendar)
            #expect(Invitations.invite("me@example.com", name: nil, to: invitation))
            invitation.stubOrganizer = participant("pat@example.com")
            #expect(EventKitStore.isInvitation(invitation))
            fake.byID["event-2"] = invitation
            try await store(fake).delete(id: "event-2")
            #expect(fake.removed.last?.title == "Their review")
        }

        /// An event with an organizer who isn't the user but nobody invited (one in someone else's shared
        /// calendar) is no invitation: it is read as the user's and changes.
        @Test
        func anEventWithAnOrganizerAndNoAttendeesIsNoInvitation() async throws {
            let fake = FakeEventStore()
            let event = fake.occurrence("Review", id: "event-1", start: start, repeats: false, in: fake.sharedCalendar)
            event.stubOrganizer = participant("pat@example.com")
            fake.byID = ["event-1": event]
            #expect(event.organizer?.isCurrentUser == false && !event.hasAttendees && !EventKitStore.calendarEvent(event).isInvitation)
            var changes = EventChanges()
            changes.title = "Kickoff"
            _ = try await store(fake).edit(id: "event-1", occurrence: nil, scope: .all, changes: changes)
            #expect(fake.saved.count == 1 && event.title == "Kickoff")
        }

        /// Open reminders due before the day asked, each with its list's name.
        @Test
        func openRemindersAreRead() async throws {
            let fake = FakeEventStore()
            let reminder = EKReminder(eventStore: fake)
            reminder.calendar = fake.list
            reminder.title = "Send the deck"
            reminder.dueDateComponents = ReminderItem.dueCalendar.dateComponents([.year, .month, .day], from: start)
            fake.reminders = [reminder]

            let reminders = try await store(fake).openReminders(dueBefore: start + 86_400)

            #expect(fake.reminderDueBefore == [start + 86_400])
            #expect(reminders == [ReminderItem(title: "Send the deck", list: "Errands", due: ReminderItem.dueCalendar.startOfDay(for: start), dueHasTime: false, notes: nil)])
            _ = try await store(fake).openReminders(dueBefore: nil)
            #expect(fake.reminderDueBefore == [start + 86_400, nil])
        }

        /// A reminder is saved, committed, in the default list, and comes back as saved.
        @Test
        func aReminderIsSavedInTheDefaultList() async throws {
            let fake = FakeEventStore()
            let reminder = ReminderItem(title: "Call back", list: "", due: start, dueHasTime: true, notes: "about Friday")

            let added = try await store(fake).add(reminder)

            #expect(fake.saved.count == 1)
            let saved = try #require(fake.saved.first as? EKReminder)
            #expect(saved.calendar === fake.list)
            #expect(added == ReminderItem(title: "Call back", list: "Errands", due: start, dueHasTime: true, notes: "about Friday"))
        }

        /// With no default calendar or list, nothing is saved and the app is told which.
        @Test
        func withNoDefaultNothingIsSaved() async {
            let fake = FakeEventStore()
            fake.hasDefaults = false
            let events = store(fake)

            await #expect(throws: EventKitStore.Failure.noDefaultCalendar.helperError) {
                try await events.add(CalendarEvent(title: "Launch review", start: start, end: start + 1800, isAllDay: false, calendar: "", location: nil, notes: nil))
            }
            await #expect(throws: EventKitStore.Failure.noDefaultList.helperError) {
                try await events.add(ReminderItem(title: "Call back", list: "", due: nil, dueHasTime: false, notes: nil))
            }
            #expect(fake.saved.isEmpty)
        }

        /// Allowed already, nothing is asked; not asked yet, macOS is asked once per kind and a grant
        /// goes ahead.
        @Test
        func accessIsAskedOnlyTheFirstTime() async throws {
            let allowed = FakeEventStore()
            _ = try await store(allowed).events(from: start, to: start + 3600)
            #expect(allowed.accessRequests.isEmpty)
            #expect(allowed.fetches == 1)

            let asked = FakeEventStore()
            _ = try await store(asked, .notDetermined).events(from: start, to: start + 3600)
            _ = try await store(asked, .notDetermined).openReminders(dueBefore: nil)
            #expect(asked.accessRequests == [.event, .reminder])
            #expect(asked.fetches == 2)
        }

        /// Refused, restricted, write-only, or a request refused or failing: nothing is read or saved, and
        /// the app is told which access to allow.
        @Test(arguments: [(EKAuthorizationStatus.denied, true as Bool?), (.restricted, true), (.writeOnly, true), (.notDetermined, false), (.notDetermined, nil)])
        func withoutAccessNothingIsReadOrSaved(status: EKAuthorizationStatus, grants: Bool?) async {
            let fake = FakeEventStore()
            fake.grants = grants
            let events = store(fake, status)

            await #expect(throws: EventKitStore.Failure.calendarNoAccess.helperError) { try await events.events(from: start, to: start + 3600) }
            await #expect(throws: EventKitStore.Failure.calendarNoAccess.helperError) {
                try await events.add(CalendarEvent(title: "Launch review", start: start, end: start + 1800, isAllDay: false, calendar: "", location: nil, notes: nil))
            }
            await #expect(throws: EventKitStore.Failure.remindersNoAccess.helperError) { try await events.openReminders(dueBefore: nil) }
            await #expect(throws: EventKitStore.Failure.remindersNoAccess.helperError) {
                try await events.add(ReminderItem(title: "Call back", list: "", due: nil, dueHasTime: false, notes: nil))
            }
            #expect(fake.fetches == 0)
            #expect(fake.saved.isEmpty)
            #expect(fake.accessRequests == (status == .notDetermined ? [.event, .event, .reminder, .reminder] : []))
        }

        /// Without access, an event is neither read, changed nor deleted, nor the calendars listed: each
        /// asks for access as its first step, when it hasn't been decided.
        @Test(arguments: [(EKAuthorizationStatus.denied, true as Bool?), (.restricted, true), (.writeOnly, true), (.notDetermined, false), (.notDetermined, nil)])
        func withoutAccessNoEventIsReadChangedOrDeleted(status: EKAuthorizationStatus, grants: Bool?) async {
            let fake = FakeEventStore()
            fake.grants = grants
            let sync = fake.occurrence("Sync", id: "series-1", start: start)
            fake.byID = ["series-1": sync]
            fake.events = [sync]
            let events = store(fake, status)
            var changes = EventChanges()
            changes.title = "Renamed"
            changes.exclude = [start + 7 * 86_400]

            await #expect(throws: EventKitStore.Failure.calendarNoAccess.helperError) { _ = try await events.event(id: "series-1", occurrence: nil) }
            await #expect(throws: EventKitStore.Failure.calendarNoAccess.helperError) { _ = try await events.calendars() }
            await #expect(throws: EventKitStore.Failure.calendarNoAccess.helperError) { _ = try await events.edit(id: "series-1", occurrence: nil, scope: .all, changes: changes) }
            await #expect(throws: EventKitStore.Failure.calendarNoAccess.helperError) { try await events.delete(id: "series-1") }
            #expect(fake.saved.isEmpty && fake.removed.isEmpty && fake.commits == 0 && sync.title == "Sync")
            #expect(fake.accessRequests == (status == .notDetermined ? [.event, .event, .event, .event] : []))
        }

        /// Access granted when asked, the same requests read, list, change and delete: the refusals above
        /// are access's. (The stand-in's status stays undetermined, so each asks.)
        @Test
        func withAccessTheEventIsReadChangedAndDeleted() async throws {
            let fake = FakeEventStore()
            let sync = fake.occurrence("Sync", id: "series-1", start: start)
            fake.byID = ["series-1": sync]
            fake.events = [sync]
            let events = store(fake, .notDetermined)
            var changes = EventChanges()
            changes.title = "Renamed"

            #expect(try await events.event(id: "series-1", occurrence: nil).title == "Sync")
            #expect(try await events.calendars().isEmpty == false)
            _ = try await events.edit(id: "series-1", occurrence: nil, scope: .all, changes: changes)
            try await events.delete(id: "series-1")
            #expect(sync.title == "Renamed" && fake.saved.count == 1 && fake.removed.count == 1)
            #expect(fake.accessRequests == [.event, .event, .event, .event])
        }

        /// An occurrence in the hours a clock turned back repeats is named by a local time that reads as
        /// the earlier instant: at Antarctica/Troll, which turns it back two hours, the most any zone does,
        /// the later instant is still found from its local time, read, changed and deleted by the series
        /// and read as a single event, and a second further is another time.
        @Test
        func anOccurrenceInTheRepeatedHoursIsFound() async throws {
            let zone = try #require(TimeZone(identifier: "Antarctica/Troll"))
            var transition = try #require(zone.nextDaylightSavingTimeTransition(after: Date()))
            while zone.secondsFromGMT(for: transition) >= zone.secondsFromGMT(for: transition - 1) {
                transition = try #require(zone.nextDaylightSavingTimeTransition(after: transition))
            }
            let fold = TimeInterval(zone.secondsFromGMT(for: transition - 1) - zone.secondsFromGMT(for: transition))
            #expect(fold == 2 * 3600)
            // The occurrence a quarter hour into the repeated hours, and the earlier instant of its local time.
            let occurrence = transition + 15 * 60
            let named = occurrence - fold
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            let local: Set<Calendar.Component> = [.year, .month, .day, .hour, .minute]
            #expect(calendar.dateComponents(local, from: named) == calendar.dateComponents(local, from: occurrence))

            let fake = FakeEventStore()
            let first = fake.occurrence("Sync", id: "series-1", start: occurrence - 7 * 86_400)
            let later = fake.occurrence("Sync later", id: "series-1", start: occurrence)
            fake.byID = ["series-1": first]
            fake.events = [first, later]
            let events = store(fake)
            #expect(try await events.event(id: "series-1", occurrence: named).title == "Sync later")
            await #expect(throws: EventKitStore.Failure.noSuchEvent.helperError) { _ = try await events.event(id: "series-1", occurrence: named - 1) }
            await #expect(throws: EventKitStore.Failure.noSuchEvent.helperError) { _ = try await events.event(id: "series-1", occurrence: occurrence - 86_400) }
            // Changed alone, and deleted from the series, by the same name.
            var renaming = EventChanges()
            renaming.title = "Sync moved"
            _ = try await events.edit(id: "series-1", occurrence: named, scope: .thisOnly, changes: renaming)
            #expect(fake.saved.last === later && later.title == "Sync moved" && first.title == "Sync")
            var excluding = EventChanges()
            excluding.exclude = [named]
            _ = try await events.edit(id: "series-1", occurrence: nil, scope: .all, changes: excluding)
            #expect(fake.removed.map(\.title) == ["Sync moved"])

            let single = fake.occurrence("Review", id: "event-1", start: occurrence, repeats: false)
            fake.byID["event-1"] = single
            #expect(try await events.event(id: "event-1", occurrence: named).title == "Review")
            await #expect(throws: EventKitStore.Failure.noSuchEvent.helperError) { _ = try await events.event(id: "event-1", occurrence: named - 1) }
        }

        /// Each of `voice-macos`'s Calendar and Reminders requests carries its fields to the store, and
        /// answers with what it read or saved, times in milliseconds.
        @Test
        func theRequestsReachTheStore() async throws {
            let fake = FakeEventStore()
            fake.events = [fake.event("Launch review", start: start, hours: 1)]
            let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
            let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
            let service = MacService.register(on: channel, eventStore: store(fake), contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }))
            let ms = { (date: Date) in Int(date.timeIntervalSince1970 * 1000) }
            let requests = [
                #"{"id":1,"method":"calendarEvents","params":{"start":\#(ms(start)),"end":\#(ms(start + 86_400))}}"#,
                #"{"id":2,"method":"calendarAdd","params":{"title":"Offsite","start":\#(ms(start)),"end":\#(ms(start + 3600)),"isAllDay":false,"location":"Room 4","notes":"the long one","calendarId":null,"availability":"busy","recurrence":null,"attendees":[]}}"#,
                #"{"id":3,"method":"reminders","params":{"dueBefore":\#(ms(start))}}"#,
                #"{"id":4,"method":"reminderAdd","params":{"title":"Call back","due":\#(ms(start)),"dueHasTime":true,"notes":"about Friday"}}"#,
            ]
            for request in requests { await channel.handle(line: Data(request.utf8)) }

            let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
            #expect(replies.count == requests.count)
            guard replies.count == requests.count else { return }
            let results = replies.map { $0["result"] as? [String: Any] }
            #expect(fake.eventRanges == [start...(start + 86_400)])
            #expect((results[0]?["events"] as? [[String: Any]])?.map { $0["title"] as? String } == ["Launch review"])
            #expect(results[1]?["title"] as? String == "Offsite" && results[1]?["calendar"] as? String == "Work" && results[1]?["location"] as? String == "Room 4")
            #expect((results[1]?["end"] as? NSNumber)?.intValue == ms(start + 3600))
            #expect(fake.reminderDueBefore == [start])
            #expect(results[3]?["title"] as? String == "Call back" && results[3]?["list"] as? String == "Errands" && results[3]?["dueHasTime"] as? Bool == true)
            #expect((results[3]?["due"] as? NSNumber)?.intValue == ms(start))
            #expect(fake.saved.map(\.title) == ["Offsite", "Call back"])
            withExtendedLifetime(service) {}
        }

        /// A `calendarAdd` request carries what the user confirmed to the event saved: its calendar, its
        /// rule (saved for the series), free time and the people invited.
        @Test
        func aCreateRequestCarriesEveryField() async throws {
            let fake = FakeEventStore()
            let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
            let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
            let service = MacService.register(on: channel, eventStore: store(fake), contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }))
            let ms = { (date: Date) in Int(date.timeIntervalSince1970 * 1000) }
            let calendarId = fake.sharedCalendar.calendarIdentifier
            let request = #"{"id":1,"method":"calendarAdd","params":{"title":"Standup","start":\#(ms(start)),"end":\#(ms(start + 900)),"isAllDay":false,"location":null,"notes":null,"calendarId":"\#(calendarId)","availability":"free","recurrence":{"frequency":"WEEKLY","interval":1,"count":null,"until":null,"days":[{"weekday":2,"week":0}],"monthDays":[],"months":[]},"attendees":[{"email":"alex@example.com","name":"Alex"}]}}"#

            await channel.handle(line: Data(request.utf8))

            let reply = try #require(lines.withLock { $0 }.first.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
            let result = try #require(reply["result"] as? [String: Any])
            let saved = try #require(fake.saved.first as? EKEvent)
            #expect(saved.calendar === fake.sharedCalendar && fake.spans == [.futureEvents])
            #expect(saved.availability == .free)
            #expect(EventKitStore.calendarEvent(saved).recurrence == EventRecurrence(frequency: "WEEKLY", interval: 1, days: [EventRecurrence.Day(weekday: 2, week: 0)]))
            #expect((saved.attendees ?? []).compactMap(Invitations.email(of:)) == ["alex@example.com"])
            #expect(result["calendarId"] as? String == calendarId && result["availability"] as? String == "free")
            #expect(((result["attendees"] as? [[String: Any]]) ?? []).map { $0["email"] as? String } == ["alex@example.com"])
            #expect((result["recurrence"] as? [String: Any])?["frequency"] as? String == "WEEKLY")
            withExtendedLifetime(service) {}
        }

        /// The single-event requests carry their fields to the store: an absent change is left as it is,
        /// a null recurrence ends the repeating; a malformed request is refused before the store.
        @Test
        func theSingleEventRequestsReachTheStore() async throws {
            let fake = FakeEventStore()
            let first = fake.occurrence("Sync", id: "series-1", start: start)
            let second = fake.occurrence("Sync second", id: "series-1", start: start + 7 * 86_400)
            fake.byID = ["series-1": first]
            fake.events = [first, second]
            let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
            let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
            let service = MacService.register(on: channel, eventStore: store(fake), contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }))
            let ms = { (date: Date) in Int(date.timeIntervalSince1970 * 1000) }
            let requests = [
                #"{"id":1,"method":"calendarEvent","params":{"id":"series-1","occurrence":\#(ms(start))}}"#,
                #"{"id":2,"method":"calendars","params":{}}"#,
                #"{"id":10,"method":"calendarEdit","params":{"id":"series-1","occurrence":null,"scope":"all","invite":[],"uninvite":[],"exclude":[\#(ms(start + 7 * 86_400))]}}"#,
                #"{"id":3,"method":"calendarEdit","params":{"id":"series-1","occurrence":null,"scope":"all","title":"Standup","location":"","recurrence":{"frequency":"DAILY","interval":1,"count":3,"until":null,"days":[],"monthDays":[],"months":[]},"invite":[],"uninvite":[],"exclude":[]}}"#,
                #"{"id":4,"method":"calendarEdit","params":{"id":"series-1","occurrence":null,"scope":"all","recurrence":null,"invite":[],"uninvite":[],"exclude":[]}}"#,
                #"{"id":5,"method":"calendarDelete","params":{"id":"series-1"}}"#,
                #"{"id":6,"method":"calendarEdit","params":{"id":"series-1","scope":"sometimes"}}"#,
                #"{"id":7,"method":"calendarEdit","params":{"id":"series-1","scope":"all","recurrence":{"frequency":"HOURLY","interval":1}}}"#,
                #"{"id":8,"method":"calendarAdd","params":{"title":"Offsite","start":\#(ms(start)),"end":\#(ms(start)),"isAllDay":false,"availability":"busy","attendees":[{"name":"Alex"}]}}"#,
                #"{"id":9,"method":"calendarEdit","params":{"id":"series-1","scope":"all","invite":[{"name":"Alex"}]}}"#,
                #"{"id":11,"method":"calendarEdit","params":{"id":"series-1","scope":"all","uninvite":[3]}}"#,
                #"{"id":12,"method":"calendarEdit","params":{"id":"series-1","scope":"all","exclude":["soon"]}}"#,
            ]
            for request in requests { await channel.handle(line: Data(request.utf8)) }

            let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
            #expect(replies.count == requests.count)
            guard replies.count == requests.count else { return }
            let results = replies.map { $0["result"] as? [String: Any] }
            #expect(results[0]?["id"] as? String == "series-1" && (results[0]?["occurrence"] as? NSNumber)?.intValue == ms(start))
            #expect((results[1]?["calendars"] as? [[String: Any]])?.map { $0["title"] as? String } == ["Work", "Team"])
            #expect(results[2]?["id"] as? String == "series-1")
            #expect(results[3]?["title"] as? String == "Standup" && results[3]?["location"] is NSNull)
            #expect(results[4]?["recurrence"] is NSNull && first.recurrenceRules?.isEmpty != false)
            // The occurrence the request named is deleted, and only it, before the series' own deletion.
            #expect(fake.removed.map(\.title) == ["Sync second", "Standup"])
            for index in 6..<requests.count { #expect(replies[index]["error"] != nil, "request \(index + 1) is refused") }
            #expect(fake.saved.count == 3)
            withExtendedLifetime(service) {}
        }

        /// A `calendarEdit` request carries every change to the event saved: its title, times, place,
        /// notes, free time, a counted rule (never one repeating for ever) and the people invited and
        /// removed.
        @Test
        func anEditRequestCarriesEveryField() async throws {
            let fake = FakeEventStore()
            let own = fake.occurrence("Planning", id: "event-1", start: start, repeats: false, in: fake.sharedCalendar)
            #expect(Invitations.invite("alex@example.com", name: "Alex", to: own))
            own.stubOrganizer = currentUser(try #require(participant("me@example.com")))
            fake.byID = ["event-1": own]
            let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
            let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
            let service = MacService.register(on: channel, eventStore: store(fake), contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }))
            let ms = { (date: Date) in Int(date.timeIntervalSince1970 * 1000) }
            let moved = start + 86_400
            let request = #"{"id":1,"method":"calendarEdit","params":{"id":"event-1","occurrence":null,"scope":"all","title":"Planning, moved","start":\#(ms(moved)),"end":\#(ms(moved + 5400)),"isAllDay":false,"location":"Room 9","notes":"the agenda","availability":"free","recurrence":{"frequency":"WEEKLY","interval":2,"count":4,"until":null,"days":[{"weekday":3,"week":0}],"monthDays":[],"months":[]},"invite":[{"email":"sam@example.com","name":"Sam"}],"uninvite":["Alex@Example.com"],"exclude":[]}}"#

            await channel.handle(line: Data(request.utf8))

            let reply = try #require(lines.withLock { $0 }.first.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
            let result = try #require(reply["result"] as? [String: Any])
            #expect(own.title == "Planning, moved" && own.startDate == moved && own.endDate == moved + 5400 && !own.isAllDay)
            #expect(own.location == "Room 9" && own.notes == "the agenda" && own.availability == .free)
            let rule = try #require(own.recurrenceRules?.first)
            #expect(rule.frequency == .weekly && rule.interval == 2 && rule.recurrenceEnd?.occurrenceCount == 4)
            #expect(rule.daysOfTheWeek?.map(\.dayOfTheWeek) == [.tuesday])
            #expect(Set((own.attendees ?? []).compactMap(Invitations.email(of:))) == ["sam@example.com"])
            #expect(fake.saved.count == 1 && fake.spans == [.futureEvents])
            let recurrence = try #require(result["recurrence"] as? [String: Any])
            #expect((recurrence["count"] as? NSNumber)?.intValue == 4 && (recurrence["interval"] as? NSNumber)?.intValue == 2)
            #expect(((result["attendees"] as? [[String: Any]]) ?? []).compactMap { $0["email"] as? String } == ["sam@example.com"])
            withExtendedLifetime(service) {}
        }

        /// The requests name the occurrence and the occurrences covered: a later one is read, changed
        /// alone to all day, and with the following ones, and the first is left as it was.
        @Test
        func theRequestsNameTheOccurrenceAndScope() async throws {
            let fake = FakeEventStore()
            let first = fake.occurrence("Sync", id: "series-1", start: start)
            let second = fake.occurrence("Sync second", id: "series-1", start: start + 7 * 86_400)
            fake.byID = ["series-1": first]
            fake.events = [first, second]
            let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
            let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
            let service = MacService.register(on: channel, eventStore: store(fake), contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }))
            let later = Int((start + 7 * 86_400).timeIntervalSince1970 * 1000)
            let requests = [
                #"{"id":1,"method":"calendarEvent","params":{"id":"series-1","occurrence":\#(later)}}"#,
                #"{"id":2,"method":"calendarEdit","params":{"id":"series-1","occurrence":\#(later),"scope":"thisOnly","isAllDay":true,"invite":[],"uninvite":[],"exclude":[]}}"#,
                #"{"id":3,"method":"calendarEdit","params":{"id":"series-1","occurrence":\#(later),"scope":"thisAndFollowing","title":"Sync later","invite":[],"uninvite":[],"exclude":[]}}"#,
            ]
            for request in requests { await channel.handle(line: Data(request.utf8)) }

            let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
            #expect(replies.count == requests.count)
            guard replies.count == requests.count else { return }
            #expect((replies[0]["result"] as? [String: Any])?["title"] as? String == "Sync second")
            #expect(second.isAllDay && second.title == "Sync later" && !first.isAllDay && first.title == "Sync")
            #expect(fake.saved.count == 2 && fake.saved.allSatisfy { $0 === second } && fake.spans == [.thisEvent, .futureEvents])
            withExtendedLifetime(service) {}
        }

        /// An occurrence changed on its own is found by its own id, however far it moved from where it was.
        @Test
        func aDetachedOccurrenceIsFoundByItsOwnIDAfterALongMove() async throws {
            let fake = FakeEventStore()
            let moved = fake.occurrence("Sync moved", id: "series-1/RID=1", start: start + 90 * 86_400, occurrence: start + 7 * 86_400)
            moved.stubDetached = true
            fake.byID = ["series-1/RID=1": moved]

            let found = try await store(fake).event(id: "series-1/RID=1", occurrence: start + 7 * 86_400)
            #expect(found.id == "series-1/RID=1" && found.start == start + 90 * 86_400 && found.isDetached)
        }

        /// An occurrence changed on its own, which carries its series' rule, is saved alone whatever scope
        /// is asked: saved for the following events, every later occurrence would take its changes.
        @Test(arguments: [EventScope.all, .thisAndFollowing, .thisOnly])
        func aDetachedOccurrenceChangesAlone(scope: EventScope) async throws {
            let fake = FakeEventStore()
            let moved = fake.occurrence("Sync moved", id: "series-1/RID=1", start: start + 8 * 86_400, occurrence: start + 7 * 86_400)
            moved.stubDetached = true
            fake.byID = ["series-1/RID=1": moved]
            fake.events = [moved]
            var changes = EventChanges()
            changes.title = "Sync once"
            changes.start = start + 8 * 86_400 + 3600
            changes.end = start + 8 * 86_400 + 7200

            _ = try await store(fake).edit(id: "series-1/RID=1", occurrence: nil, scope: scope, changes: changes)

            #expect(moved.hasRecurrenceRules)
            #expect(fake.saved.count == 1 && fake.saved.first === moved && fake.spans == [.thisEvent])
            #expect(moved.title == "Sync once" && moved.startDate == start + 8 * 86_400 + 3600 && moved.endDate == start + 8 * 86_400 + 7200)
        }

        /// An event is read with the zone its times and its rule's days are counted in, none for one that floats.
        @Test
        func anEventIsReadWithItsTimeZone() {
            let fake = FakeEventStore()
            let zoned = fake.event("Sync", start: start, hours: 1)
            zoned.timeZone = TimeZone(identifier: "Asia/Kolkata")
            let floating = fake.event("Trip", start: start, hours: 1)
            floating.timeZone = nil
            #expect(EventKitStore.calendarEvent(zoned).timeZone == "Asia/Kolkata")
            #expect(EventKitStore.calendarEvent(floating).timeZone == nil)
        }

        /// A single event made to repeat is saved for the following events: saved for itself, EventKit
        /// rewrites the new rule as a daily one.
        @Test
        func aSingleEventMadeToRepeatIsSavedForTheFollowingEvents() async throws {
            let fake = FakeEventStore()
            let single = fake.occurrence("Planning", id: "event-1", start: start, repeats: false)
            fake.byID = ["event-1": single]
            fake.events = [single]
            var changes = EventChanges()
            let weekly = EventRecurrence(frequency: "WEEKLY", interval: 1, count: 4)
            changes.recurrence = .set(weekly)

            _ = try await store(fake).edit(id: "event-1", occurrence: nil, scope: .all, changes: changes)

            #expect(fake.saved.count == 1 && fake.saved.first === single && fake.spans == [.futureEvents])
            #expect(single.recurrenceRules?.first.flatMap(EventRecurrence.init) == weekly)
        }

        /// A room, reached by a URL that is no email address, is no attendee the model can name or remove.
        @Test
        func aRoomIsNoAttendee() throws {
            let room = resource(try #require(participant("room-4@example.com")), at: try #require(URL(string: "urn:example:room-4")))
            #expect(Invitations.email(of: room) == nil)
            #expect(EventKitStore.eventAttendee(room) == nil)
            let person = try #require(participant("Alex@Example.com"))
            #expect(Invitations.email(of: person) == "alex@example.com")
        }

        /// An occurrence named while the event still repeated deletes nothing once it is a single event:
        /// not a later date, and not the event itself at its start.
        @Test
        func anOccurrenceOfAnEventThatStoppedRepeatingDeletesNothing() async throws {
            let fake = FakeEventStore()
            let single = fake.occurrence("Keep as one", id: "event-1", start: start, repeats: false)
            fake.byID = ["event-1": single]
            fake.events = [single]
            let events = store(fake)
            for excluded in [start + 7 * 86_400, start] {
                var changes = EventChanges()
                changes.exclude = [excluded]
                await #expect(throws: EventKitStore.Failure.noSuchEvent.helperError) { _ = try await events.edit(id: "event-1", occurrence: nil, scope: .all, changes: changes) }
            }
            #expect(fake.removed.isEmpty && fake.saved.isEmpty && fake.commits == 0)
        }

        /// An edit refused deletes none of the occurrences it names, and leaves none pending: one of them
        /// not there, or an invitation the calendar can't send.
        @Test
        func aRefusedEditDeletesNoOccurrence() async throws {
            let fake = FakeEventStore()
            let first = fake.occurrence("Sync", id: "series-1", start: start)
            let second = fake.occurrence("Sync second", id: "series-1", start: start + 7 * 86_400)
            fake.byID = ["series-1": first]
            fake.events = [first, second]
            let events = store(fake)
            var missing = EventChanges()
            missing.exclude = [start + 7 * 86_400, start + 9 * 86_400]
            var inviting = EventChanges()
            inviting.exclude = [start + 7 * 86_400]
            inviting.invite = [EventAttendee(email: "sam@example.com", name: nil)]

            await #expect(throws: EventKitStore.Failure.noSuchEvent.helperError) { _ = try await events.edit(id: "series-1", occurrence: nil, scope: .all, changes: missing) }
            await #expect(throws: EventKitStore.Failure.calendarNoInvitations.helperError) { _ = try await events.edit(id: "series-1", occurrence: nil, scope: .all, changes: inviting) }
            #expect(fake.removed.isEmpty && fake.commits == 0 && fake.saved.isEmpty)
        }

        /// The whole series moved across a daylight-saving change keeps the time of day the user
        /// confirmed: it moves by days, not by a number of seconds an hour off.
        @Test
        func aSeriesMovedAcrossADaylightSavingChangeKeepsItsTimeOfDay() async throws {
            let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            let transition = try #require(zone.nextDaylightSavingTimeTransition(after: Date()))
            let dayBefore = try #require(calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: transition)))
            // 10:00 on the day `days` from the day before the change.
            var times: [Int: Date] = [:]
            for days in [-14, -11, 0, 3] {
                let day = try #require(calendar.date(byAdding: .day, value: days, to: dayBefore))
                times[days] = calendar.date(bySettingHour: 10, minute: 0, second: 0, of: day)
            }
            let firstStart = try #require(times[-14]), movedFirst = try #require(times[-11])
            let targetStart = try #require(times[0]), newStart = try #require(times[3])
            let fake = FakeEventStore()
            let first = fake.occurrence("Sync", id: "series-1", start: firstStart)
            let target = fake.occurrence("Sync", id: "series-1", start: targetStart)
            for event in [first, target] { event.timeZone = zone }
            fake.byID = ["series-1": first]
            fake.events = [first, target]
            var changes = EventChanges()
            changes.start = newStart
            changes.end = newStart + 3600

            _ = try await store(fake).edit(id: "series-1", occurrence: targetStart, scope: .all, changes: changes)

            #expect(first.startDate == movedFirst && first.endDate == movedFirst + 3600)
        }

        /// An Exchange calendar sends invitations as a CalDAV one does: people are invited to a new
        /// event and added to the user's own.
        @Test
        func anExchangeCalendarInvites() async throws {
            let fake = FakeEventStore()
            object_setClass(fake.sharedCalendar, ExchangeCalendar.self)
            var event = CalendarEvent(title: "Planning", start: start, end: start + 1800, isAllDay: false, calendar: "", location: nil, notes: nil)
            event.calendarId = fake.sharedCalendar.calendarIdentifier
            event.attendees = [EventAttendee(email: "alex@example.com", name: "Alex")]
            let added = try await store(fake).add(event)
            #expect(fake.saved.first?.calendar === fake.sharedCalendar && added.attendees.contains { $0.email == "alex@example.com" })

            let own = fake.occurrence("Review", id: "event-1", start: start, repeats: false, in: fake.sharedCalendar)
            fake.byID = ["event-1": own]
            var changes = EventChanges()
            changes.invite = [EventAttendee(email: "sam@example.com", name: "Sam")]
            let edited = try await store(fake).edit(id: "event-1", occurrence: nil, scope: .all, changes: changes)
            #expect(fake.saved.last === own && edited.attendees.contains { $0.email == "sam@example.com" })
        }

        /// An all-day series moved from a later occurrence keeps the days confirmed: every occurrence
        /// moves by as many days and lasts as many as the one named was given.
        @Test
        func anAllDaySeriesMovedKeepsItsDays() async throws {
            let calendar = Calendar.current
            let day = { (days: Int) in calendar.date(byAdding: .day, value: days, to: calendar.startOfDay(for: self.start))! }
            let fake = FakeEventStore()
            let first = fake.occurrence("Offsite", id: "series-1", start: day(0))
            let target = fake.occurrence("Offsite", id: "series-1", start: day(7))
            for (event, from) in [(first, 0), (target, 7)] {
                event.isAllDay = true
                event.startDate = day(from)
                event.endDate = day(from + 2)
            }
            fake.byID = ["series-1": first]
            fake.events = [first, target]
            var changes = EventChanges()
            changes.start = day(8)
            changes.end = day(11)

            _ = try await store(fake).edit(id: "series-1", occurrence: day(7), scope: .all, changes: changes)

            #expect(first.isAllDay && calendar.isDate(first.startDate, inSameDayAs: day(1)))
            #expect(calendar.isDate(first.endDate, inSameDayAs: day(4)))
        }

        /// An all-day series keeps its days when the days confirmed are shorter than the ones it moves
        /// to: the clock goes forward an hour in the days confirmed, not in the first occurrence's.
        @Test
        func anAllDaySeriesKeepsItsDaysAcrossAClockChange() async throws {
            let saved = getenv("TZ").map { String(cString: $0) }
            setenv("TZ", "America/Los_Angeles", 1)
            tzset()
            NSTimeZone.resetSystemTimeZone()
            defer {
                if let saved { setenv("TZ", saved, 1) } else { unsetenv("TZ") }
                tzset()
                NSTimeZone.resetSystemTimeZone()
            }
            let calendar = Calendar.current
            let zone = calendar.timeZone
            #expect(zone.identifier == "America/Los_Angeles")
            // The next time the clock goes forward, found from today.
            var forward = try #require(zone.nextDaylightSavingTimeTransition(after: Date()))
            while zone.secondsFromGMT(for: forward) <= zone.secondsFromGMT(for: forward - 1) {
                forward = try #require(zone.nextDaylightSavingTimeTransition(after: forward))
            }
            // The occurrence named starts the day before, so the three days confirmed are an hour short.
            let named = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: forward))!
            let day = { (days: Int) in calendar.date(byAdding: .day, value: days - 8, to: named)! }
            #expect(day(11).timeIntervalSince(day(8)) == 3 * 86_400 - 3600)
            #expect(day(4).timeIntervalSince(day(1)) == 3 * 86_400)
            let fake = FakeEventStore()
            let first = fake.occurrence("Offsite", id: "series-1", start: day(0))
            let target = fake.occurrence("Offsite", id: "series-1", start: day(7))
            for (event, from) in [(first, 0), (target, 7)] {
                event.isAllDay = true
                event.startDate = day(from)
                event.endDate = day(from + 2)
            }
            fake.byID = ["series-1": first]
            fake.events = [first, target]
            var changes = EventChanges()
            changes.start = day(8)
            changes.end = day(11)

            _ = try await store(fake).edit(id: "series-1", occurrence: day(7), scope: .all, changes: changes)

            #expect(first.isAllDay && calendar.isDate(first.startDate, inSameDayAs: day(1)))
            #expect(calendar.isDate(first.endDate, inSameDayAs: day(4)))
        }

        /// The series moves by the days the named occurrence moves on the calendar, whatever the hours:
        /// later the same day stays that day, a few minutes past midnight is the next.
        @Test(arguments: [(from: 10, to: 23, toMinute: 0, nextDay: false), (from: 23, to: 0, toMinute: 30, nextDay: true)])
        func aSeriesMovesByCalendarDays(from: Int, to: Int, toMinute: Int, nextDay: Bool) async throws {
            let zone = try #require(TimeZone(identifier: "UTC"))
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            let day = { (days: Int, hour: Int, minute: Int) in
                calendar.date(bySettingHour: hour, minute: minute, second: 0, of: calendar.date(byAdding: .day, value: days, to: calendar.startOfDay(for: self.start))!)!
            }
            let fake = FakeEventStore()
            let first = fake.occurrence("Sync", id: "series-1", start: day(0, from, 0))
            let target = fake.occurrence("Sync", id: "series-1", start: day(7, from, 0))
            for event in [first, target] { event.timeZone = zone }
            fake.byID = ["series-1": first]
            fake.events = [first, target]
            let newStart = day(nextDay ? 8 : 7, to, toMinute)
            var changes = EventChanges()
            changes.start = newStart
            changes.end = newStart + 1800

            _ = try await store(fake).edit(id: "series-1", occurrence: day(7, from, 0), scope: .all, changes: changes)

            #expect(first.startDate == day(nextDay ? 1 : 0, to, toMinute) && first.endDate == first.startDate + 1800)
        }

        /// An occurrence is looked for in its own event's calendar: one of another calendar at the same
        /// time, sharing the id, is not it.
        @Test
        func anOccurrenceIsLookedForInItsOwnCalendar() async throws {
            let fake = FakeEventStore()
            let first = fake.occurrence("Sync", id: "series-1", start: start)
            let elsewhere = fake.occurrence("Elsewhere", id: "series-1", start: start + 7 * 86_400, in: fake.sharedCalendar)
            let second = fake.occurrence("Sync second", id: "series-1", start: start + 7 * 86_400)
            fake.byID = ["series-1": first]
            fake.events = [elsewhere, second]

            let read = try await store(fake).event(id: "series-1", occurrence: start + 7 * 86_400)

            #expect(read.title == "Sync second")
        }

        /// The first person invited to an event with none makes the user its organizer, as Calendar does;
        /// later ones don't again. One this macOS can't invite fails the create, saving nothing.
        @Test
        func invitingMakesTheUserOrganizerOnceAndAFailedInviteSavesNothing() async throws {
            let fake = FakeEventStore()
            var event = CalendarEvent(title: "Planning", start: start, end: start + 1800, isAllDay: false, calendar: "", location: nil, notes: nil)
            event.calendarId = fake.sharedCalendar.calendarIdentifier
            event.attendees = [EventAttendee(email: "alex@example.com", name: "Alex"), EventAttendee(email: "sam@example.com", name: nil)]

            let organizer = try #require(class_getInstanceMethod(EKEvent.self, NSSelectorFromString("addOrganizerAndSelfAttendeeForNewInvitation")))
            // The people already on the event each time the organizer is added: none, once.
            let calls = OSAllocatedUnfairLock<[Int]>(initialState: [])
            let recording: @convention(block) (AnyObject) -> Void = { event in
                let present = (event as? EKEvent)?.attendees?.count ?? 0
                calls.withLock { $0.append(present) }
            }
            do {
                let original = replace(organizer, with: recording)
                defer { method_setImplementation(organizer, original) }
                _ = try await store(fake).add(event)
            }
            #expect(calls.withLock { $0 } == [0] && fake.saved.count == 1)

            let attendeeClass: AnyClass = try #require(NSClassFromString("EKAttendee"))
            let factory = try #require(class_getClassMethod(attendeeClass, NSSelectorFromString("attendeeWithName:emailAddress:")))
            let refusing: @convention(block) (AnyObject, NSString?, NSString) -> AnyObject? = { _, _, _ in nil }
            do {
                let original = replace(factory, with: refusing)
                defer { method_setImplementation(factory, original) }
                await #expect(throws: EventKitStore.Failure.invitationsUnavailable.helperError) { _ = try await store(fake).add(event) }
            }
            #expect(fake.saved.count == 1)
        }

        /// A failed write leaves what was already committed, and nothing after it: an occurrence deleted
        /// stays deleted, the change asked with it isn't saved, and the failure reaches the app.
        @Test
        func aFailedWriteKeepsWhatWasCommittedAndNothingAfter() async throws {
            for failing in ["second removal", "save"] {
                let fake = FakeEventStore()
                let first = fake.occurrence("Sync", id: "series-1", start: start)
                let second = fake.occurrence("Sync second", id: "series-1", start: start + 7 * 86_400)
                let third = fake.occurrence("Sync third", id: "series-1", start: start + 14 * 86_400)
                fake.byID = ["series-1": first]
                fake.events = [first, second, third]
                if failing == "save" { fake.savesFail = true } else { fake.removalsBeforeFailure = 1 }
                var changes = EventChanges()
                changes.title = "Standup"
                changes.exclude = [start + 7 * 86_400, start + 14 * 86_400]

                await #expect(throws: CocoaError.self, "the \(failing) fails") {
                    _ = try await store(fake).edit(id: "series-1", occurrence: nil, scope: .all, changes: changes)
                }
                let deleted = failing == "save" ? ["Sync second", "Sync third"] : ["Sync second"]
                #expect(fake.writes == deleted.map { "remove \($0)" }, "the \(failing) fails")
                #expect(fake.saved.isEmpty && (failing == "save" || first.title == "Sync"), "the \(failing) fails")
            }
        }

        /// An event moved into the hour a daylight-saving change repeats keeps the times confirmed, its
        /// end too; the whole series moved onto that day keeps the length confirmed.
        @Test
        func timesInTheRepeatedHourAreKept() async throws {
            let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            // The next change that turns the clock back: at it, the hour before it is repeated.
            var transition = try #require(zone.nextDaylightSavingTimeTransition(after: Date()))
            while zone.secondsFromGMT(for: transition) > zone.secondsFromGMT(for: transition - 1) {
                transition = try #require(zone.nextDaylightSavingTimeTransition(after: transition))
            }
            // The second 01:15 of that day, an hour after the first.
            let repeated = transition + 15 * 60

            let fake = FakeEventStore()
            let single = fake.occurrence("Review", id: "event-1", start: repeated - 86_400, repeats: false)
            single.timeZone = zone
            fake.byID = ["event-1": single]
            var changes = EventChanges()
            changes.start = repeated
            changes.end = repeated + 5400
            _ = try await store(fake).edit(id: "event-1", occurrence: nil, scope: .all, changes: changes)
            #expect(single.startDate == repeated && single.endDate == repeated + 5400)

            // A weekly series whose first occurrence, at 10:00, is on that day, moved from its next one.
            let day = calendar.startOfDay(for: transition)
            let firstStart = try #require(calendar.date(bySettingHour: 10, minute: 0, second: 0, of: day))
            let targetStart = try #require(calendar.date(byAdding: .day, value: 7, to: firstStart))
            let first = fake.occurrence("Sync", id: "series-1", start: firstStart)
            let target = fake.occurrence("Sync", id: "series-1", start: targetStart)
            for event in [first, target] { event.timeZone = zone }
            fake.byID["series-1"] = first
            fake.events = [first, target]
            let newStart = try #require(calendar.date(bySettingHour: 1, minute: 15, second: 0, of: targetStart))
            var moving = EventChanges()
            moving.start = newStart
            moving.end = newStart + 5400
            _ = try await store(fake).edit(id: "series-1", occurrence: targetStart, scope: .all, changes: moving)
            #expect(calendar.dateComponents([.hour, .minute], from: first.startDate) == DateComponents(hour: 1, minute: 15))
            #expect(first.endDate.timeIntervalSince(first.startDate) == 5400)
        }

        /// The series moves by days in its own zone, not the Mac's: one zone of the two has a
        /// daylight-saving change between its first occurrence and the one moved, and the other none.
        @Test
        func aSeriesInAnotherZoneMovesByItsOwnDays() async throws {
            let los = try #require(TimeZone(identifier: "America/Los_Angeles"))
            let kolkata = try #require(TimeZone(identifier: "Asia/Kolkata"))
            // The Mac's zone changes its clocks: the event's has none; otherwise the event's does.
            let macChanges = TimeZone.current.nextDaylightSavingTimeTransition(after: Date()) != nil
            let zone = macChanges ? kolkata : los
            let transition = try #require((macChanges ? TimeZone.current : los).nextDaylightSavingTimeTransition(after: Date()))
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            let dayBefore = try #require(calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: transition)))
            var times: [Int: Date] = [:]
            for days in [-14, -11, 0, 3] {
                let day = try #require(calendar.date(byAdding: .day, value: days, to: dayBefore))
                times[days] = calendar.date(bySettingHour: 10, minute: 0, second: 0, of: day)
            }
            let firstStart = try #require(times[-14]), movedFirst = try #require(times[-11])
            let targetStart = try #require(times[0]), newStart = try #require(times[3])
            let fake = FakeEventStore()
            let first = fake.occurrence("Sync", id: "series-1", start: firstStart)
            let target = fake.occurrence("Sync", id: "series-1", start: targetStart)
            for event in [first, target] { event.timeZone = zone }
            fake.byID = ["series-1": first]
            fake.events = [first, target]
            var changes = EventChanges()
            changes.start = newStart
            changes.end = newStart + 3600

            _ = try await store(fake).edit(id: "series-1", occurrence: targetStart, scope: .all, changes: changes)

            #expect(fake.saved.count == 1 && fake.saved.first === first)
            #expect(first.startDate == movedFirst && first.endDate == movedFirst + 3600)
            #expect(target.startDate == targetStart)
        }

        /// An event is made all day, and timed again, as asked.
        @Test
        func anEventBecomesAllDayAndTimedAgain() async throws {
            let fake = FakeEventStore()
            let event = fake.occurrence("Review", id: "event-1", start: start, repeats: false)
            fake.byID = ["event-1": event]
            let events = store(fake)
            var changes = EventChanges()
            changes.isAllDay = true
            _ = try await events.edit(id: "event-1", occurrence: nil, scope: .all, changes: changes)
            #expect(event.isAllDay)
            changes.isAllDay = false
            _ = try await events.edit(id: "event-1", occurrence: nil, scope: .all, changes: changes)
            #expect(!event.isAllDay)
        }

        /// A timed event made all day over several days keeps its last day: all day is set before the
        /// dates, which set after it would move the end back to the start's day.
        @Test
        func anEventMadeAllDayKeepsItsLastDay() async throws {
            let fake = FakeEventStore()
            let event = fake.occurrence("Offsite", id: "event-1", start: start, repeats: false)
            fake.byID = ["event-1": event]
            let first = Calendar.current.startOfDay(for: start)
            let last = Calendar.current.date(byAdding: .day, value: 2, to: first)!
            var changes = EventChanges()
            changes.isAllDay = true
            changes.start = first
            changes.end = last

            let saved = try await store(fake).edit(id: "event-1", occurrence: nil, scope: .all, changes: changes)

            #expect(event.isAllDay && saved.isAllDay)
            #expect(Calendar.current.isDate(event.startDate, inSameDayAs: first))
            #expect(Calendar.current.isDate(event.endDate, inSameDayAs: last))
        }

        /// The user's own meeting with people invited is no invitation: it changes, and its people with it.
        @Test
        func theUsersOwnMeetingChanges() async throws {
            let fake = FakeEventStore()
            let own = fake.occurrence("Planning", id: "event-1", start: start, repeats: false, in: fake.sharedCalendar)
            #expect(Invitations.invite("alex@example.com", name: nil, to: own))
            own.stubOrganizer = currentUser(try #require(participant("me@example.com")))
            fake.byID = ["event-1": own]
            var changes = EventChanges()
            changes.title = "Planning, moved"

            #expect(!EventKitStore.calendarEvent(own).isInvitation)
            let saved = try await store(fake).edit(id: "event-1", occurrence: nil, scope: .all, changes: changes)
            #expect(saved.title == "Planning, moved" && !saved.isInvitation && fake.saved.count == 1)
        }
    }
}
