// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import EventKit
import Foundation

/// The people invited to an event, which EventKit reads but has no public way to write. Calendar
/// itself invites through methods EventKit keeps to itself: an attendee made by
/// `+[EKAttendee attendeeWithName:emailAddress:]`, added by `-[EKCalendarItem addAttendee:]` and
/// removed by `-[EKCalendarItem removeAttendee:]`; once the event is saved, its calendar's server
/// (iCloud, Google, Exchange) emails the invitations, updates and cancellations, as it does for
/// Calendar's own (ADR-DESK-060). Each method is looked up when it is used, so a macOS without one
/// refuses (`available` false) instead of crashing.
enum Invitations {
    private static let attendeeFactory = NSSelectorFromString("attendeeWithName:emailAddress:")
    private static let addSelector = NSSelectorFromString("addAttendee:")
    private static let removeSelector = NSSelectorFromString("removeAttendee:")
    private static let organizerSelector = NSSelectorFromString("addOrganizerAndSelfAttendeeForNewInvitation")

    private typealias Factory = @convention(c) (AnyClass, Selector, NSString?, NSString) -> AnyObject?
    private typealias Change = @convention(c) (AnyObject, Selector, AnyObject) -> Void
    private typealias Organizer = @convention(c) (AnyObject, Selector) -> Void

    private static var attendeeClass: AnyClass? { NSClassFromString("EKAttendee") }

    /// Whether this macOS still has the methods inviting needs.
    static var available: Bool {
        guard let attendeeClass, class_getClassMethod(attendeeClass, attendeeFactory) != nil else { return false }
        return class_getInstanceMethod(EKEvent.self, addSelector) != nil && class_getInstanceMethod(EKEvent.self, removeSelector) != nil
    }

    /// Invites `email` (named `name`, when given) to `event`; false when this macOS can't.
    static func invite(_ email: String, name: String?, to event: EKEvent) -> Bool {
        guard available, let attendeeClass, let factory = class_getClassMethod(attendeeClass, attendeeFactory),
              let add = class_getInstanceMethod(EKEvent.self, addSelector) else { return false }
        if !event.hasAttendees, let organizer = class_getInstanceMethod(EKEvent.self, organizerSelector) {
            // The organizer and the user, as Calendar adds them to the first invitation it sends.
            unsafeBitCast(method_getImplementation(organizer), to: Organizer.self)(event, organizerSelector)
        }
        guard let attendee = unsafeBitCast(method_getImplementation(factory), to: Factory.self)(attendeeClass, attendeeFactory, name as NSString?, email as NSString) else { return false }
        unsafeBitCast(method_getImplementation(add), to: Change.self)(event, addSelector, attendee)
        return true
    }

    /// Removes `attendee` from `event`; false when this macOS can't.
    static func uninvite(_ attendee: EKParticipant, from event: EKEvent) -> Bool {
        guard available, let remove = class_getInstanceMethod(EKEvent.self, removeSelector) else { return false }
        unsafeBitCast(method_getImplementation(remove), to: Change.self)(event, removeSelector, attendee)
        return true
    }

    /// The email address `participant` is reached at, lowercased; nil for one without (a room).
    static func email(of participant: EKParticipant) -> String? {
        guard participant.url.scheme?.lowercased() == "mailto" else { return nil }
        let address = (participant.url as NSURL).resourceSpecifier ?? ""
        return address.isEmpty ? nil : address.lowercased()
    }
}
