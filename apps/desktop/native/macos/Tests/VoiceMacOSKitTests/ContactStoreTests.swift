// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Contacts
import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

/// Contacts as `voice-macos` matches them and sends them to the app (the app's
/// `MacSystem.contactStore` reads them back), from the Swift `ContactsToolsTests`. Never the user's
/// own contacts: nothing is saved or read from the address book, and no access is asked.
struct ContactStoreTests {
    private let sam = ContactCard(
        firstName: "Sam", lastName: "Example", organization: "Company",
        emails: ["sam@example.com", "sam.example@domain.com"], phones: ["+1 555 0100"]
    )

    /// A contact matches on its name either way round, its company or an email address, ignoring case
    /// and accents.
    @Test(arguments: ["sam", "EXAMPLE", "sam example", "example sam", "compa", "@domain.com", "Sám"])
    func aContactMatchesItsNameCompanyOrEmail(query: String) {
        #expect(ContactMatch.matches(sam, query))
    }

    /// A phone number or another name matches nothing.
    @Test(arguments: ["Alex", "0100", "sam@domain.com"])
    func otherTextMatchesNoContact(query: String) {
        #expect(!ContactMatch.matches(sam, query))
    }

    /// A contact with no name matches on its company.
    @Test
    func aCompanyAloneMatches() {
        #expect(ContactMatch.matches(ContactCard(organization: "Domain"), "dom"))
    }

    /// A contact is saved with every field the user confirmed, each where it belongs, and read back as
    /// it was given.
    @Test
    func aContactIsSavedWithEveryField() {
        let saved = ContactsFrameworkStore.mutableContact(sam)

        #expect(saved.givenName == "Sam" && saved.familyName == "Example" && saved.organizationName == "Company")
        #expect(saved.phoneNumbers.map(\.value.stringValue) == ["+1 555 0100"])
        #expect(ContactsFrameworkStore.card(saved) == sam)
    }

    /// A search keeps only the contacts that match, and stops reading once it has `limit`.
    @Test
    func aSearchStopsAtItsLimit() {
        let alex = ContactCard(firstName: "Alex", lastName: "Other", organization: "", emails: [], phones: [])
        let sams = (1...3).map { ContactCard(firstName: "Sam", lastName: "Example \($0)", organization: "", emails: [], phones: []) }
        var search = ContactSearch(query: "sam", limit: 2)

        let stoppedAt = [sams[0], alex, sams[1], sams[2]].firstIndex { search.read($0) }

        #expect(stoppedAt == 2)
        #expect(search.matches == [sams[0], sams[1]])
    }

    /// Every field goes to the app as it is, the lists as arrays.
    @Test
    func aContactCarriesEveryField() {
        #expect(sam.json == [
            "firstName": "Sam", "lastName": "Example", "organization": "Company",
            "emails": ["sam@example.com", "sam.example@domain.com"], "phones": ["+1 555 0100"],
        ])
        #expect(ContactCard().json == ["firstName": "", "lastName": "", "organization": "", "emails": [], "phones": []])
    }

    /// A refusal goes to the app by the name it knows (`ContactStoreFailure`'s kinds).
    @Test
    func aRefusalGoesByName() {
        #expect(ContactsFrameworkStore.Failure.contactsNoAccess.helperError == HelperError("contactsNoAccess"))
    }
}

/// The Contacts framework standing in for the user's address book: it records what
/// `ContactsFrameworkStore` asks, reads and saves, hands out the contacts a test gives it, and asks
/// macOS for nothing.
final class FakeContactStore: CNContactStore, @unchecked Sendable {
    /// What a request for access answers: granted, refused, or (nil) failing.
    var grants: Bool? = true
    var contacts: [CNContact] = []
    private(set) var accessRequests = 0
    /// How many contacts each enumeration read before it was stopped, and in what order it asked.
    private(set) var reads: [Int] = []
    private(set) var sortOrders: [CNContactSortOrder] = []
    private(set) var executed = 0
    /// What each executed save added, by container (nil: the default one). `CNSaveRequest` has no
    /// public way to read it, so the stand-in reads the request's own record (a test's view only).
    private(set) var added: [(container: String?, contacts: [CNContact])] = []

    override func requestAccess(for entityType: CNEntityType, completionHandler: @escaping (Bool, (any Error)?) -> Void) {
        accessRequests += 1
        if let grants { completionHandler(grants, nil) } else { completionHandler(false, CocoaError(.featureUnsupported)) }
    }

    override func enumerateContacts(with fetchRequest: CNContactFetchRequest, usingBlock block: (CNContact, UnsafeMutablePointer<ObjCBool>) -> Void) throws {
        sortOrders.append(fetchRequest.sortOrder)
        var read = 0
        var stop: ObjCBool = false
        for contact in contacts where !stop.boolValue {
            read += 1
            block(contact, &stop)
        }
        reads.append(read)
    }

    override func execute(_ saveRequest: CNSaveRequest) throws {
        executed += 1
        let key = "addedContactsByContainerIdentifier"
        guard saveRequest.responds(to: NSSelectorFromString(key)), let byContainer = saveRequest.value(forKey: key) as? [AnyHashable: Any] else { return }
        for (container, contacts) in byContainer {
            added.append((container as? String, (contacts as? [CNContact]) ?? []))
        }
    }
}

/// `ContactsFrameworkStore` over a stand-in address book (never the user's contacts, and no access
/// asked of macOS): what it asks access for, reads and saves, and what `voice-macos`'s requests
/// answer.
@MainActor
struct ContactsFrameworkStoreTests {
    private func store(_ fake: FakeContactStore, _ status: CNAuthorizationStatus = .authorized) -> ContactsFrameworkStore {
        ContactsFrameworkStore(store: fake, status: { _ in status })
    }

    private func contact(_ first: String, _ last: String, email: String) -> CNContact {
        ContactsFrameworkStore.mutableContact(ContactCard(firstName: first, lastName: last, emails: [email]))
    }

    /// The address book is read in the user's order and matched here, and the read stops at the
    /// limit's last match.
    @Test
    func aSearchReadsInTheUsersOrderUpToItsLimit() async throws {
        let fake = FakeContactStore()
        fake.contacts = [contact("Sam", "Example", email: "sam@example.com"), contact("Alex", "Example", email: "alex@company.com"), contact("Sam", "Other", email: "other@domain.com"), contact("Sam", "Third", email: "third@domain.com")]

        let found = try await store(fake).search("sam", limit: 2)

        #expect(found.map(\.lastName) == ["Example", "Other"])
        #expect(fake.reads == [3])
        #expect(fake.sortOrders == [.userDefault])
    }

    /// A contact is saved once and comes back as saved.
    @Test
    func aContactIsSaved() async throws {
        let fake = FakeContactStore()
        let card = ContactCard(firstName: "Sam", lastName: "Example", organization: "Company", emails: ["sam@example.com"], phones: ["+1 555 0100"])

        let added = try await store(fake).add(card)

        #expect(fake.executed == 1)
        #expect(added == card)
        #expect(fake.added.map(\.container) == [nil])
        #expect(fake.added.map { $0.contacts.map(ContactsFrameworkStore.card) } == [[card]])
    }

    /// Allowed already, nothing is asked; not asked yet, macOS is asked and a grant goes ahead.
    @Test
    func accessIsAskedOnlyTheFirstTime() async throws {
        let allowed = FakeContactStore()
        _ = try await store(allowed).search("sam", limit: 1)
        #expect(allowed.accessRequests == 0)

        let asked = FakeContactStore()
        _ = try await store(asked, .notDetermined).search("sam", limit: 1)
        #expect(asked.accessRequests == 1)
        #expect(asked.reads == [0])
    }

    /// Refused, restricted, or a request refused or failing: nothing is read or saved, and the app is
    /// told to allow Contacts.
    @Test(arguments: [(CNAuthorizationStatus.denied, true as Bool?), (.restricted, true), (.notDetermined, false), (.notDetermined, nil)])
    func withoutAccessNothingIsReadOrSaved(status: CNAuthorizationStatus, grants: Bool?) async {
        let fake = FakeContactStore()
        fake.grants = grants
        fake.contacts = [contact("Sam", "Example", email: "sam@example.com")]
        let contacts = store(fake, status)

        await #expect(throws: ContactsFrameworkStore.Failure.contactsNoAccess.helperError) { try await contacts.search("sam", limit: 1) }
        await #expect(throws: ContactsFrameworkStore.Failure.contactsNoAccess.helperError) { try await contacts.add(ContactCard(firstName: "Sam")) }
        #expect(fake.reads.isEmpty)
        #expect(fake.executed == 0)
        #expect(fake.accessRequests == (status == .notDetermined ? 2 : 0))
    }

    /// `voice-macos`'s Contacts requests carry their fields to the store and answer with what it found
    /// or saved.
    @Test
    func theRequestsReachTheStore() async throws {
        let fake = FakeContactStore()
        fake.contacts = [contact("Sam", "Example", email: "sam@example.com"), contact("Sam", "Other", email: "other@domain.com")]
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MacService.register(on: channel, eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }), contactStore: store(fake))
        let requests = [
            #"{"id":1,"method":"contactsSearch","params":{"query":"sam","limit":1}}"#,
            #"{"id":2,"method":"contactsAdd","params":{"firstName":"Alex","lastName":"Example","organization":"Company","emails":["alex@company.com"],"phones":["+1 555 0101"]}}"#,
        ]
        for request in requests { await channel.handle(line: Data(request.utf8)) }

        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.count == requests.count)
        guard replies.count == requests.count else { return }
        let results = replies.map { $0["result"] as? [String: Any] }
        #expect((results[0]?["contacts"] as? [[String: Any]])?.map { $0["lastName"] as? String } == ["Example"])
        #expect(fake.reads == [1])
        #expect(results[1]?["firstName"] as? String == "Alex" && results[1]?["lastName"] as? String == "Example" && results[1]?["organization"] as? String == "Company")
        #expect(results[1]?["emails"] as? [String] == ["alex@company.com"] && results[1]?["phones"] as? [String] == ["+1 555 0101"])
        #expect(fake.executed == 1)
        #expect(fake.added.map { $0.contacts.map(ContactsFrameworkStore.card) } == [[ContactCard(firstName: "Alex", lastName: "Example", organization: "Company", emails: ["alex@company.com"], phones: ["+1 555 0101"])]])
        withExtendedLifetime(service) {}
    }
}
