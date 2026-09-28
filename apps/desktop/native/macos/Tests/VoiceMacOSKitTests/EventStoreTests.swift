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
            "isAllDay": false, "calendar": "Work", "location": "Room 4", "notes": nil,
        ])
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

    override var defaultCalendarForNewEvents: EKCalendar? { hasDefaults ? calendar : nil }
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
        #expect(added == CalendarEvent(title: "Launch review", start: start, end: start + 1800, isAllDay: false, calendar: "Work", location: "Room 4", notes: "bring the deck"))
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
            #"{"id":2,"method":"calendarAdd","params":{"title":"Offsite","start":\#(ms(start)),"end":\#(ms(start + 3600)),"isAllDay":false,"location":"Room 4","notes":"the long one"}}"#,
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
}
