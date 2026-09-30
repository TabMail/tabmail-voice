// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

@preconcurrency import Contacts
import Foundation
import VoiceHelperSupport

/// A person in the user's contacts, as the app's contacts tools read and add them.
struct ContactCard: Equatable, Sendable {
    var firstName = ""
    var lastName = ""
    var organization = ""
    var emails: [String] = []
    var phones: [String] = []

    /// "First Last", or the company for a contact with no name.
    var displayName: String {
        let name = [firstName, lastName].filter { !$0.isEmpty }.joined(separator: " ")
        return name.isEmpty ? organization : name
    }

    /// What the app receives, and sends to add one.
    var json: JSON {
        [
            "firstName": .string(firstName), "lastName": .string(lastName), "organization": .string(organization),
            "emails": .array(emails.map(JSON.string)), "phones": .array(phones.map(JSON.string)),
        ]
    }
}

/// Whether a contact matches a search: its name (either way round), company or an email address
/// contains the query, ignoring case and accents. Phone numbers are returned, not searched.
enum ContactMatch {
    static func matches(_ card: ContactCard, _ query: String) -> Bool {
        let fields = [card.displayName, "\(card.lastName) \(card.firstName)", card.organization] + card.emails
        return fields.contains { $0.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }
}

/// A search's matches as the address book is read: each contact that matches is kept, and the reading
/// stops at `limit`, so the address book never crosses the wire.
struct ContactSearch {
    let query: String
    let limit: Int
    private(set) var matches: [ContactCard] = []

    /// Keeps `card` if it matches; true once `limit` are kept, to stop reading.
    mutating func read(_ card: ContactCard) -> Bool {
        if ContactMatch.matches(card, query) { matches.append(card) }
        return matches.count >= limit
    }
}

/// Apple Contacts through the Contacts framework, for the Answer tool's contacts tools
/// (ADR-DESK-025). Access is asked the first time a request needs it: macOS shows its prompt for
/// TabMail Voice, the app that started this helper, with the app's usage string. Denied, a request
/// fails with a `Failure` the app turns into a message saying where to allow it. The framework's
/// calls block, so they run off the main thread.
@MainActor
final class ContactsFrameworkStore {
    /// Why a request can't be carried out, sent as the error's message; the app knows each by name.
    enum Failure: String, Error {
        case contactsNoAccess

        var helperError: HelperError { HelperError(rawValue) }
    }

    private let store: CNContactStore
    private let status: (CNEntityType) -> CNAuthorizationStatus

    /// `store` and `status` are the Contacts framework's own; a test gives stand-ins, never the user's
    /// contacts.
    init(store: CNContactStore = CNContactStore(), status: @escaping (CNEntityType) -> CNAuthorizationStatus = CNContactStore.authorizationStatus(for:)) {
        self.store = store
        self.status = status
    }

    private nonisolated static var keys: [any CNKeyDescriptor] {
        [
            CNContactGivenNameKey, CNContactFamilyNameKey, CNContactOrganizationNameKey,
            CNContactEmailAddressesKey, CNContactPhoneNumbersKey,
        ].map { $0 as NSString }
    }

    /// The contacts `query` matches (`ContactMatch`), at most `limit`, in the user's sort order. Every
    /// contact is read and matched here: the framework's name predicate matches neither email
    /// addresses nor accents.
    func search(_ query: String, limit: Int) async throws -> [ContactCard] {
        try await requireAccess()
        let store = store
        return try await Task.detached {
            var search = ContactSearch(query: query, limit: limit)
            let request = CNContactFetchRequest(keysToFetch: Self.keys)
            request.sortOrder = .userDefault
            try store.enumerateContacts(with: request) { contact, stop in
                if search.read(Self.card(contact)) { stop.pointee = true }
            }
            return search.matches
        }.value
    }

    /// Adds `contact` to the default container and returns it as saved.
    func add(_ contact: ContactCard) async throws -> ContactCard {
        try await requireAccess()
        let store = store
        return try await Task.detached {
            let saved = Self.mutableContact(contact)
            let request = CNSaveRequest()
            request.add(saved, toContainerWithIdentifier: nil)
            try store.execute(request)
            return Self.card(saved)
        }.value
    }

    /// Asks for access the first time; throws when the user has not allowed it.
    private func requireAccess() async throws {
        switch status(.contacts) {
        case .authorized:
            return
        case .notDetermined:
            // A request that fails is no access either: the user is told where to allow it.
            guard (try? await store.requestAccess(for: .contacts)) == true else { throw Failure.contactsNoAccess.helperError }
        default:
            throw Failure.contactsNoAccess.helperError
        }
    }

    /// `card` as a contact to save, every field on it.
    nonisolated static func mutableContact(_ card: ContactCard) -> CNMutableContact {
        let contact = CNMutableContact()
        contact.givenName = card.firstName
        contact.familyName = card.lastName
        contact.organizationName = card.organization
        contact.emailAddresses = card.emails.map { CNLabeledValue(label: CNLabelWork, value: $0 as NSString) }
        contact.phoneNumbers = card.phones.map { CNLabeledValue(label: CNLabelPhoneNumberMain, value: CNPhoneNumber(stringValue: $0)) }
        return contact
    }

    nonisolated static func card(_ contact: CNContact) -> ContactCard {
        ContactCard(
            firstName: contact.givenName, lastName: contact.familyName, organization: contact.organizationName,
            emails: contact.emailAddresses.map { $0.value as String }, phones: contact.phoneNumbers.map { $0.value.stringValue }
        )
    }
}
