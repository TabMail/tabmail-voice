// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import EventKit
import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

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
            recurrence: recurrence, isDetached: true, isInvitation: true
        )
        let ms = { (date: Date) in JSON.number(date.timeIntervalSince1970 * 1000) }

        #expect(event.json["id"] == "series-1" && event.json["occurrence"] == ms(start) && event.json["calendarId"] == "calendar-1")
        #expect(event.json["availability"] == "free" && event.json["isDetached"] == true && event.json["isInvitation"] == true)
        #expect(event.json["attendees"] == [["email": "alex@example.com", "name": "Alex", "status": "accepted"]])
        #expect(event.json["organizer"] == ["email": "me@example.com", "name": nil, "status": "unknown"])
        #expect(event.json["recurrence"] == [
            "frequency": "MONTHLY", "interval": 2, "count": nil, "until": ms(until), "days": [["weekday": 6, "week": -1]], "monthDays": [], "months": [],
            "positions": [], "yearWeeks": [], "yearDays": [],
        ])
        #expect(EventRecurrence(json: event.json["recurrence"]!) == recurrence)
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

    /// A timed event keeps its times to the second.
    @Test
    @MainActor
    func aTimedEventKeepsItsTimes() {
        let event = CalendarEvent(title: "Launch review", start: start, end: start + 1800, isAllDay: false, calendar: "", location: nil, notes: nil)
        let saved = EKEvent(eventStore: EKEventStore())

        EventKitStore.fill(saved, from: event)

        #expect(EventKitStore.calendarEvent(saved) == event)
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
        #expect(read.attendees.contains(EventAttendee(email: "alex@example.com", name: "Alex", status: read.attendees.first { $0.email == "alex@example.com" }?.status ?? "")))
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

    override var defaultCalendarForNewEvents: EKCalendar? { hasDefaults ? calendar : nil }
    override func event(withIdentifier identifier: String) -> EKEvent? { byID[identifier] }
    override func calendar(withIdentifier identifier: String) -> EKCalendar? {
        [calendar, sharedCalendar, readOnlyCalendar, list].first { $0.calendarIdentifier == identifier }
    }
    override func calendars(for entityType: EKEntityType) -> [EKCalendar] { entityType == .event ? [calendar, sharedCalendar, readOnlyCalendar] : [list] }

    override func remove(_ event: EKEvent, span: EKSpan, commit: Bool) throws {
        removed.append((event.title, span, commit))
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
        return super.predicateForEvents(withStart: startDate, end: endDate, calendars: calendars)
    }

    override func events(matching predicate: NSPredicate) -> [EKEvent] {
        fetches += 1
        return events
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
        saved.append(event)
        spans.append(span)
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

func participant(_ email: String) -> EKParticipant? {
    _ = EKEvent(eventStore: EKEventStore())
    guard let attendeeClass = NSClassFromString("EKAttendee") as? NSObject.Type else { return nil }
    let factory = NSSelectorFromString("attendeeWithName:emailAddress:")
    return attendeeClass.perform(factory, with: nil, with: email)?.takeUnretainedValue() as? EKParticipant
}

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
            calendarId: fake.calendar.calendarIdentifier
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
